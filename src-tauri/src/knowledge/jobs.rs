//! Durable bounded scheduler. Foreground and background have separate slots.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::time::Duration;
thread_local! {static ACTIVE: std::cell::RefCell<Option<JobContext>> = const {std::cell::RefCell::new(None)};}
struct ActiveGuard(Option<JobContext>);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        ACTIVE.with(|a| *a.borrow_mut() = self.0.take());
    }
}
pub fn checkpoint() -> Result<(), String> {
    ACTIVE.with(|a| {
        if let Some(job) = a.borrow().as_ref() {
            job.check()?;
        }
        Ok(())
    })
}
pub fn approval_wait(waiting: bool) -> Result<(), String> {
    ACTIVE.with(|a| {
        if let Some(job) = a.borrow().as_ref() {
            let c = crate::db::init_db(&job.app)?;
            job.check()?;
            c.execute(
                "UPDATE knowledge_jobs SET state=?2 WHERE id=?1",
                params![
                    job.id,
                    if waiting {
                        "waiting_for_approval"
                    } else {
                        "queued"
                    }
                ],
            )
            .map_err(|e| e.to_string())?;
            if !waiting {
                let priority = c
                    .query_row(
                        "SELECT priority FROM knowledge_jobs WHERE id=?1",
                        [&job.id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                while !claim(&c, &job.id, priority)? {
                    job.check()?;
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
            super::emit(&job.app, &c, &job.scope.vault_id, "job_changed", &job.id)?;
        }
        Ok(())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub priority: i64,
    pub progress: f64,
    pub error: Option<String>,
}
fn state(c: &Connection, id: &str) -> Result<String, String> {
    c.query_row("SELECT state FROM knowledge_jobs WHERE id=?1", [id], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}
pub fn recover(c: &Connection) -> Result<(), String> {
    c.execute("UPDATE knowledge_jobs SET state='interrupted',error=CASE WHEN kind IN ('INDEX','EMBED','EMBED_BACKFILL') THEN 'Will refresh on the next vault index or embedding pass.' ELSE 'Prism closed before completion. Retry this operation.' END,updated_at=unixepoch() WHERE state IN ('running','queued','waiting_for_approval')",[]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn run<T>(
    app: &tauri::AppHandle,
    kind: &str,
    priority: i64,
    key: &str,
    payload: serde_json::Value,
    work: impl FnOnce(&JobContext) -> Result<T, String>,
) -> Result<T, String> {
    let scope = super::current(app)?;
    let c = crate::db::init_db(app)?;
    let interrupted: Option<String> = c.query_row("SELECT id FROM knowledge_jobs WHERE vault_id=?1 AND dedup=?2 AND state='interrupted' AND kind IN ('INDEX','EMBED','EMBED_BACKFILL') ORDER BY created_at DESC LIMIT 1",params![scope.vault_id,key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let id = interrupted
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let tx = rusqlite::Transaction::new_unchecked(&c, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let count:i64=tx.query_row("SELECT count(*) FROM knowledge_jobs WHERE state IN ('queued','running','waiting_for_approval')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if count >= 256 {
        return Err("Background queue is full; retry when current work finishes".into());
    }
    let inserted=if interrupted.is_some() {tx.execute("UPDATE knowledge_jobs SET state='queued',progress=0,error=NULL,payload=?2,updated_at=unixepoch() WHERE id=?1 AND state='interrupted'",params![id,payload.to_string()])}
    else {tx.execute("INSERT OR IGNORE INTO knowledge_jobs(id,vault_id,kind,dedup,priority,state,payload) VALUES (?1,?2,?3,?4,?5,'queued',?6)",params![id,scope.vault_id,kind,key,priority,payload.to_string()])}.map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    if inserted == 0 {
        return Err("An identical operation is already queued".into());
    }
    super::emit(app, &c, &scope.vault_id, "job_changed", &id)?;
    let context = JobContext {
        app: app.clone(),
        id: id.clone(),
        scope: scope.clone(),
    };
    loop {
        context.check()?;
        // One slot reserved for foreground, one for background. Claim atomically.
        let claimed = claim(&c, &id, priority)?;
        if claimed {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    super::emit(app, &c, &scope.vault_id, "job_changed", &id)?;
    let _active = ActiveGuard(ACTIVE.with(|a| a.replace(Some(context.clone()))));
    let result = work(&context).and_then(|value| {
        context.check()?;
        Ok(value)
    });
    let status = if state(&c, &id)? == "cancelled" {
        "cancelled"
    } else if result.is_ok() {
        "succeeded"
    } else {
        "failed"
    };
    c.execute("UPDATE knowledge_jobs SET state=?2,progress=CASE WHEN ?2='succeeded' THEN 1 ELSE progress END,error=?3,updated_at=unixepoch() WHERE id=?1",params![id,status,result.as_ref().err()]).map_err(|e|e.to_string())?;
    super::emit(app, &c, &scope.vault_id, "job_changed", &id)?;
    result
}
#[derive(Clone)]
pub struct JobContext {
    pub app: tauri::AppHandle,
    pub id: String,
    pub scope: super::Scope,
}
impl JobContext {
    pub fn check(&self) -> Result<(), String> {
        let c = crate::db::init_db(&self.app)?;
        if super::current(&self.app)?.generation != self.scope.generation {
            c.execute(
                "UPDATE knowledge_jobs SET state='cancelled',error='Vault changed' WHERE id=?1",
                [&self.id],
            )
            .map_err(|e| e.to_string())?;
            return Err("Vault changed".into());
        }
        if ["cancelled", "failed", "interrupted"].contains(&state(&c, &self.id)?.as_str()) {
            return Err("Operation cancelled".into());
        }
        Ok(())
    }
    pub fn yield_background(&self) -> Result<(), String> {
        self.check()?;
        let c = crate::db::init_db(&self.app)?;
        let priority: i64 = c
            .query_row(
                "SELECT priority FROM knowledge_jobs WHERE id=?1",
                [&self.id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if priority >= 50 {
            return Ok(());
        }
        c.execute(
            "UPDATE knowledge_jobs SET state='queued' WHERE id=?1 AND state='running'",
            [&self.id],
        )
        .map_err(|e| e.to_string())?;
        while !claim(&c, &self.id, priority)? {
            self.check()?;
            std::thread::sleep(Duration::from_millis(40));
        }
        Ok(())
    }
    pub fn progress(&self, value: f64) -> Result<(), String> {
        self.check()?;
        let c = crate::db::init_db(&self.app)?;
        c.execute(
            "UPDATE knowledge_jobs SET progress=?2,updated_at=unixepoch() WHERE id=?1",
            params![self.id, value.clamp(0.0, 1.0)],
        )
        .map_err(|e| e.to_string())?;
        super::emit(&self.app, &c, &self.scope.vault_id, "job_changed", &self.id)
    }
}
#[tauri::command]
pub fn list_knowledge_jobs(app: tauri::AppHandle) -> Result<Vec<Job>, String> {
    let scope = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    let mut stmt=c.prepare("SELECT id,kind,state,priority,progress,error FROM knowledge_jobs WHERE vault_id=?1 ORDER BY created_at DESC,id LIMIT 100").map_err(|e|e.to_string())?;
    let out = stmt
        .query_map([scope.vault_id], |r| {
            Ok(Job {
                id: r.get(0)?,
                kind: r.get(1)?,
                state: r.get(2)?,
                priority: r.get(3)?,
                progress: r.get(4)?,
                error: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}
#[tauri::command]
pub fn cancel_knowledge_job(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let scope = super::current(&app)?;
    let c = crate::db::init_db(&app)?;
    c.execute("UPDATE knowledge_jobs SET state='cancelled',updated_at=unixepoch() WHERE id=?1 AND vault_id=?2 AND state IN ('queued','running','waiting_for_approval')",params![id,scope.vault_id]).map_err(|e|e.to_string())?;
    super::emit(&app, &c, &scope.vault_id, "job_changed", &id)
}

fn claim(c: &Connection, id: &str, priority: i64) -> Result<bool, String> {
    // Failed dependencies are terminal; missing/uncompleted dependencies cannot run.
    c.execute("UPDATE knowledge_jobs AS candidate SET state='failed',error='Dependency failed' WHERE state='queued' AND EXISTS(SELECT 1 FROM json_each(candidate.dependencies) d JOIN knowledge_jobs parent ON parent.id=d.value WHERE parent.state IN ('failed','cancelled','interrupted'))",[]).map_err(|e|e.to_string())?;
    let n=c.execute("UPDATE knowledge_jobs SET state='running',updated_at=unixepoch() WHERE id=?1 AND state='queued' AND NOT EXISTS(SELECT 1 FROM knowledge_jobs WHERE state='running' AND (priority>=50)=?2) AND id=(SELECT candidate.id FROM knowledge_jobs candidate WHERE state='queued' AND (priority>=50)=?2 AND NOT EXISTS(SELECT 1 FROM json_each(candidate.dependencies) dep LEFT JOIN knowledge_jobs parent ON parent.id=dep.value WHERE parent.state IS NULL OR parent.state!='succeeded') ORDER BY priority DESC,created_at,id LIMIT 1)",params![id,priority>=50]).map_err(|e|e.to_string())?;
    Ok(n == 1)
}
pub fn resume_embeddings(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(scope) = super::current(&app) else {
            return;
        };
        let pending:Vec<(String,String,String)>=(||->Result<_,String>{let c=crate::db::init_db(&app)?;let mut st=c.prepare("SELECT id,kind,payload FROM knowledge_jobs WHERE vault_id=?1 AND state='interrupted' AND kind IN ('EMBED','EMBED_BACKFILL') LIMIT 256").map_err(|e|e.to_string())?;let rows=st.query_map([&scope.vault_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;rows.collect::<Result<_,_>>().map_err(|e|e.to_string())})().unwrap_or_default();
        for (id, kind, payload) in pending {
            if super::current(&app)
                .map(|s| s.generation != scope.generation)
                .unwrap_or(true)
            {
                break;
            }
            let result = if kind == "EMBED_BACKFILL" {
                crate::backfill_embeddings(app.clone()).await.map(|_| ())
            } else {
                let value: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
                let path = value["path"].as_str().unwrap_or("").to_string();
                match std::fs::read_to_string(&path) {
                    Ok(content) => {
                        crate::schedule_embedding(
                            app.clone(),
                            path,
                            content,
                            value["blocks"].as_bool().unwrap_or(false),
                        )
                        .await
                    }
                    Err(e) => Err(e.to_string()),
                }
            };
            if let Ok(c) = crate::db::init_db(&app) {
                let _=c.execute("UPDATE knowledge_jobs SET state=?2,error=?3 WHERE id=?1 AND state='interrupted'",params![id,if result.is_ok(){"succeeded"}else{"failed"},result.err()]);
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        super::super::schema::migrate(&c).unwrap();
        c
    }
    fn add(c: &Connection, id: &str, priority: i64, deps: &str) {
        c.execute("INSERT INTO knowledge_jobs(id,vault_id,kind,dedup,priority,state,payload,dependencies) VALUES (?1,'v','INDEX',?1,?2,'queued','{}',?3)",params![id,priority,deps]).unwrap();
    }
    #[test]
    fn priorities_reserve_foreground_and_respect_dependencies() {
        let c = db();
        add(&c, "background", 0, "[]");
        add(&c, "later", 10, "[]");
        add(&c, "foreground", 80, "[]");
        add(&c, "dependent", 90, "[\"foreground\"]");
        assert!(!claim(&c, "background", 0).unwrap());
        assert!(claim(&c, "later", 10).unwrap());
        assert!(claim(&c, "foreground", 80).unwrap());
        assert!(!claim(&c, "dependent", 90).unwrap());
        c.execute(
            "UPDATE knowledge_jobs SET state='succeeded' WHERE id='foreground'",
            [],
        )
        .unwrap();
        assert!(claim(&c, "dependent", 90).unwrap());
    }
    #[test]
    fn cancellation_failure_and_crash_recovery() {
        let c = db();
        add(&c, "cancelled", 10, "[]");
        c.execute(
            "UPDATE knowledge_jobs SET state='cancelled' WHERE id='cancelled'",
            [],
        )
        .unwrap();
        assert!(!claim(&c, "cancelled", 10).unwrap());
        add(&c, "child", 10, "[\"cancelled\"]");
        assert!(!claim(&c, "child", 10).unwrap());
        assert_eq!(state(&c, "child").unwrap(), "failed");
        add(&c, "active", 10, "[]");
        assert!(claim(&c, "active", 10).unwrap());
        recover(&c).unwrap();
        assert_eq!(state(&c, "active").unwrap(), "interrupted");
    }
}
