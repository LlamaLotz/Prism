//! Private bounded HTTP gateway for packaged Python model transports.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
const MAX_BODY: usize = 140 * 1024 * 1024;
pub struct Gateway {
    pub url: String,
    pub token: String,
    stop: Arc<AtomicBool>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
#[derive(Deserialize)]
struct Request {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: String,
}
pub fn start(app: tauri::AppHandle) -> Result<Gateway, String> {
    let scope = super::current(&app)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let url = format!(
        "http://{}/proxy",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let token = uuid::Uuid::new_v4().to_string();
    let secret = token.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        while !stopped.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    if active.fetch_add(1, Ordering::SeqCst) >= 8 {
                        active.fetch_sub(1, Ordering::SeqCst);
                        let _ = socket.write_all(
                            b"HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        continue;
                    }
                    let app = app.clone();
                    let token = secret.clone();
                    let scope = scope.clone();
                    let active = active.clone();
                    let stop = stopped.clone();
                    std::thread::spawn(move || {
                        let result = proxy(&app, &mut socket, &token, &scope, &stop);
                        if let Err(e) = result {
                            let body = serde_json::json!({"error":e}).to_string();
                            let _=write!(socket,"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                        }
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(40))
                }
                Err(_) => break,
            }
        }
    });
    Ok(Gateway { url, token, stop })
}
fn proxy(
    app: &tauri::AppHandle,
    socket: &mut TcpStream,
    token: &str,
    scope: &super::Scope,
    stop: &Arc<AtomicBool>,
) -> Result<(), String> {
    socket
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(socket.try_clone().map_err(|e| e.to_string())?);
    let mut first = String::new();
    reader.read_line(&mut first).map_err(|e| e.to_string())?;
    if first.trim() != "POST /proxy HTTP/1.1" {
        return Err("Invalid gateway request".into());
    }
    let mut authorized = false;
    let mut len = 0;
    let mut total = first.len();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        total += n;
        if total > 16384 || n == 0 {
            return Err("Invalid gateway headers".into());
        }
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("authorization") {
                authorized = value.trim() == format!("Bearer {token}");
            }
            if name.eq_ignore_ascii_case("content-length") {
                len = value.trim().parse().map_err(|_| "Invalid request size")?;
            }
        }
    }
    if !authorized || len > MAX_BODY || len == 0 {
        return Err("Gateway authentication or size check failed".into());
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "Invalid gateway payload")?;
    if stop.load(Ordering::SeqCst) || super::current(app)?.generation != scope.generation {
        return Err("Notebook workspace changed".into());
    }
    let key = super::blocks::hash(&String::from_utf8_lossy(&bytes));
    super::jobs::run(
        app,
        "NOTEBOOK_PROCESS",
        10,
        &key,
        serde_json::json!({"task":"Notebook provider request"}),
        |job| {
            job.check()?;
            let finished = Arc::new(AtomicBool::new(false));
            struct Finish(Arc<AtomicBool>);
            impl Drop for Finish {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::SeqCst);
                }
            }
            let _finish = Finish(finished.clone());
            let peer = socket.try_clone().map_err(|e| e.to_string())?;
            peer.set_read_timeout(Some(Duration::from_millis(200)))
                .map_err(|e| e.to_string())?;
            let observer = job.clone();
            let stopped = stop.clone();
            std::thread::spawn(move || {
                while !finished.load(Ordering::SeqCst) {
                    let closed = matches!(peer.peek(&mut [0u8; 1]), Ok(0));
                    if closed || stopped.load(Ordering::SeqCst) {
                        if let Ok(c) = crate::db::init_db(&observer.app) {
                            let _=c.execute("UPDATE knowledge_jobs SET state='cancelled',error='Notebook request closed' WHERE id=?1 AND state IN ('queued','running','waiting_for_approval')",[&observer.id]);
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            let url = reqwest::Url::parse(&request.url).map_err(|_| "Invalid provider URL")?;
            if !["http", "https"].contains(&url.scheme())
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Unsupported provider URL".into());
            }
            let body = STANDARD
                .decode(&request.body)
                .map_err(|_| "Invalid request body")?;
            super::models::authorize(
                app,
                &url.origin().ascii_serialization(),
                "NOTEBOOK",
                &String::from_utf8_lossy(&bytes),
                false,
                false,
            )?;
            if stop.load(Ordering::SeqCst) || super::current(app)?.generation != scope.generation {
                return Err("Notebook workspace changed".into());
            }
            if matches!(socket.peek(&mut [0u8; 1]), Ok(0)) {
                return Err("Notebook request was cancelled".into());
            }
            super::jobs::checkpoint()?;
            let client = reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|_| "Gateway client failed")?;
            let mut req = client
                .request(
                    reqwest::Method::from_bytes(request.method.as_bytes())
                        .map_err(|_| "Invalid method")?,
                    url,
                )
                .body(body);
            for (name, value) in request.headers {
                if ![
                    "host",
                    "content-length",
                    "connection",
                    "transfer-encoding",
                    "accept-encoding",
                ]
                .contains(&name.to_lowercase().as_str())
                {
                    req = req.header(name, value);
                }
            }
            let mut response = req
                .send()
                .map_err(|_| "Notebook provider connection failed")?;
            let status = response.status().as_u16();
            let headers: Vec<_> = response
                .headers()
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
                .collect();
            let mut bytes = vec![];
            response
                .by_ref()
                .take(MAX_BODY as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Provider response interrupted")?;
            if bytes.len() > MAX_BODY {
                return Err("Provider response too large".into());
            }
            let body=serde_json::json!({"status":status,"headers":headers,"body":STANDARD.encode(bytes)}).to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).map_err(|e|e.to_string())
        },
    )
}
