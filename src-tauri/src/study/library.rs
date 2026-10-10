use super::*;

pub(super) fn unique_title(c: &Connection, id: &str, title: &str) -> Result<(), String> {
    let normalized = title.trim().to_lowercase();
    let mut q = c.prepare("SELECT title FROM collections WHERE id<>?1").map_err(error)?;
    let titles = q.query_map([id], |r| r.get::<_, String>(0)).map_err(error)?;
    for other in titles {
        if other.map_err(error)?.trim().to_lowercase() == normalized {
            return Err("A notebook with this name already exists".into());
        }
    }
    Ok(())
}

pub(super) fn cover(c: &Connection, payload: &Value) -> Result<Value, String> {
    let id = string(payload, "id")?;
    let old = collection(c, id)?;
    if payload["revision"] != old["revision"] { return Err("Notebook changed; refresh before saving".into()); }
    let cover = string(payload, "cover")?;
    if !["accent", "black", "grey"].contains(&cover) {
        use base64::Engine;
        let (encoded, png) = if let Some(encoded) = cover.strip_prefix("data:image/png;base64,") {
            (encoded, true)
        } else { (cover.strip_prefix("data:image/webp;base64,").ok_or("Choose an accent, black, grey, or an image cover")?, false) };
        if encoded.len() > 2_800_000 { return Err("Cover image is too large".into()); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(error)?;
        if if png { !bytes.starts_with(b"\x89PNG\r\n\x1a\n") } else { !bytes.starts_with(b"RIFF") || bytes.get(8..12) != Some(b"WEBP") } { return Err("Invalid cover image".into()); }
    }
    let tx = c.unchecked_transaction().map_err(error)?;
    tx.execute("INSERT INTO collection_covers(id,cover) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET cover=excluded.cover", params![id,cover]).map_err(error)?;
    tx.execute("UPDATE collections SET revision=revision+1 WHERE id=?1", [id]).map_err(error)?;
    tx.commit().map_err(error)?;
    collection(c, id)
}

pub(super) fn delete(c: &Connection, payload: &Value) -> Result<Value, String> {
    let id = string(payload, "id")?;
    let tx = c.unchecked_transaction().map_err(error)?;
    let old = collection(&tx, id)?;
    if payload["revision"] != old["revision"] { return Err("Notebook changed; refresh before deleting".into()); }
    for table in ["reviews", "review_events", "attempts"] {
        tx.execute(&format!("DELETE FROM {table} WHERE artifact_id IN (SELECT id FROM artifacts WHERE collection_id=?1)"), [id]).map_err(error)?;
    }
    tx.execute("DELETE FROM artifacts WHERE collection_id=?1", [id]).map_err(error)?;
    tx.execute("UPDATE sessions SET collection_id=NULL WHERE collection_id=?1", [id]).map_err(error)?;
    tx.execute("DELETE FROM collection_covers WHERE id=?1", [id]).map_err(error)?;
    tx.execute("DELETE FROM collections WHERE id=?1", [id]).map_err(error)?;
    tx.commit().map_err(error)?;
    Ok(json!(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_covers_and_deletion_preserve_other_notebooks_and_chats() {
        let c = Connection::open_in_memory().unwrap(); migrate(&c).unwrap(); migrate(&c).unwrap();
        c.execute_batch("INSERT INTO collections(id,title) VALUES('a','Research'),('b','Other'); INSERT INTO sessions VALUES('chat','a');").unwrap();
        assert!(unique_title(&c,"b"," RESEARCH ").is_err());
        assert!(unique_title(&c,"a","research").is_ok());
        let row = cover(&c,&json!({"id":"a","revision":1,"cover":"black"})).unwrap();
        assert_eq!(row["cover"],"black"); assert_eq!(row["revision"],2);
        assert!(cover(&c,&json!({"id":"a","revision":1,"cover":"grey"})).is_err());
        assert!(cover(&c,&json!({"id":"a","revision":2,"cover":"https://example.com/image"})).is_err());
        assert!(delete(&c,&json!({"id":"a","revision":1})).is_err());
        delete(&c,&json!({"id":"a","revision":2})).unwrap();
        assert!(unique_title(&c,"new","Research").is_ok());
        assert!(collection(&c,"b").is_ok());
        let link: Option<String> = c.query_row("SELECT collection_id FROM sessions WHERE id='chat'",[],|r|r.get(0)).unwrap();
        assert!(link.is_none());
    }
    #[test]
    fn covers_survive_reopening_the_library() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.sqlite");
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
        for (i, value) in ["accent", "black", "grey", png].iter().enumerate() {
            let c = Connection::open(&path).unwrap(); migrate(&c).unwrap();
            if i == 0 { c.execute("INSERT INTO collections(id,title) VALUES('a','Notes')", []).unwrap(); }
            cover(&c, &json!({"id":"a","revision":i+1,"cover":value})).unwrap();
            drop(c);
            let reopened = Connection::open(&path).unwrap(); migrate(&reopened).unwrap();
            assert_eq!(collection(&reopened,"a").unwrap()["cover"], *value);
        }
    }

    #[test]
    fn deletion_removes_only_owned_materials_and_review_records() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("source.md"); std::fs::write(&note,"Original source").unwrap();
        let c = Connection::open_in_memory().unwrap(); migrate(&c).unwrap();
        c.execute_batch("INSERT INTO collections(id,title,sources) VALUES('a','Research','[\"source\"]'),('b','Other','[\"source\"]');
            INSERT INTO collection_covers VALUES('a','grey'),('b','black');
            INSERT INTO sessions VALUES('chat-a','a'),('chat-b','b');
            CREATE TABLE chat_messages(id TEXT, content TEXT); INSERT INTO chat_messages VALUES('chat-a','Keep this conversation');
            INSERT INTO artifacts VALUES('material-a','a','quiz','Quiz',1,NULL,'snap','{}',1),('material-b','b','quiz','Other',1,NULL,'snap','{}',1);
            INSERT INTO reviews VALUES('material-a','card',1,1),('material-b','card',1,1);
            INSERT INTO review_events VALUES('event-a','material-a','card','good',1,1),('event-b','material-b','card','good',1,1);
            INSERT INTO attempts VALUES('attempt-a','material-a','[]',1,1,1),('attempt-b','material-b','[]',1,1,1);").unwrap();
        assert!(delete(&c,&json!({"id":"a","revision":9})).is_err());
        assert_eq!(artifacts::list(&c,Some("a")).unwrap().as_array().unwrap().len(),1);
        delete(&c,&json!({"id":"a","revision":1})).unwrap();
        for table in ["reviews", "review_events", "attempts"] {
            let count:i64 = c.query_row(&format!("SELECT count(*) FROM {table} WHERE artifact_id='material-a'"),[],|r|r.get(0)).unwrap(); assert_eq!(count,0);
            let other:i64 = c.query_row(&format!("SELECT count(*) FROM {table} WHERE artifact_id='material-b'"),[],|r|r.get(0)).unwrap(); assert_eq!(other,1);
        }
        assert!(artifacts::list(&c,Some("a")).unwrap().as_array().unwrap().is_empty());
        assert_eq!(collection(&c,"b").unwrap()["cover"],"black");
        assert_eq!(std::fs::read_to_string(note).unwrap(),"Original source");
        assert_eq!(c.query_row("SELECT content FROM chat_messages",[],|r|r.get::<_,String>(0)).unwrap(),"Keep this conversation");
        assert!(unique_title(&c,"new"," research ").is_ok());
    }

}
