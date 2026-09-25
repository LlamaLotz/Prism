use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};
#[test]
fn http_extraction_and_redirect_scope() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let handle = thread::spawn(move || {
        for i in 0..2 {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            let reply = if i == 0 {
                let body="<title>Local fixture</title><main><h1>Heading</h1><p>one two three four five six seven eight nine ten eleven twelve.</p></main>";
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else {
                format!("HTTP/1.1 302 Found\r\nLocation: http://localhost:{}/escape\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",address.port())
            };
            stream.write_all(reply.as_bytes()).unwrap();
        }
    });
    let url = format!("http://{address}/");
    let extracted = prism_ingest::web::extract(&url).unwrap();
    assert_eq!(extracted.title, "Local fixture");
    assert!(extracted.body.contains("Heading"));
    let client = prism_ingest::web::client(Some("127.0.0.1".into())).unwrap();
    assert!(prism_ingest::web::fetch(&client, &url).is_err());
    handle.join().unwrap();
}
#[test]
fn crawl_fetches_in_discovery_order() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    let page = |title: &str, links: &str| {
        format!("<html><head><title>{title}</title></head><body><main><h1>{title}</h1><p>{filler}</p>{links}</main></body></html>")
    };
    let pages = std::collections::HashMap::from([
        (
            "/".to_string(),
            page("Index", "<a href=\"/a\">a</a><a href=\"/b\">b</a>"),
        ),
        ("/a".to_string(), page("Page A", "<a href=\"/b\">b</a>")),
        ("/b".to_string(), page("Page B", "")),
    ]);
    // Exactly three fetches: / then /a + /b concurrently.
    let handle = thread::spawn(move || {
        for _ in 0..3 {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0; 4096];
            let n = stream.read(&mut request).unwrap();
            let path = String::from_utf8_lossy(&request[..n])
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_string();
            let content = pages.get(&path).cloned().unwrap_or_default();
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}",
                content.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
        }
    });
    let url = format!("http://{address}/");
    let extracted = prism_ingest::web::crawl(&url, 3).unwrap();
    handle.join().unwrap();
    let (index, a, b) = (
        extracted.body.find("Index").unwrap(),
        extracted.body.find("Page A").unwrap(),
        extracted.body.find("Page B").unwrap(),
    );
    assert!(index < a && a < b);
    assert!(extracted.body.contains(&format!("URL: http://{address}/a")));
}
/// Serve committed fixture files over loopback: paths map to fixture names.
fn serve_fixtures(
    server: TcpListener,
    routes: std::collections::HashMap<String, String>,
    fetches: usize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        for _ in 0..fetches {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0; 4096];
            let n = stream.read(&mut request).unwrap();
            let path = String::from_utf8_lossy(&request[..n])
                .split_whitespace()
                .nth(1)
                .unwrap_or("/")
                .to_string();
            let content = routes
                .get(&path)
                .map(|name| std::fs::read_to_string(root.join(name)).unwrap())
                .unwrap_or_default();
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}",
                content.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
        }
    })
}
/// Large Wikipedia-shaped article: tables and reading order survive, chrome
/// is stripped, and extraction finishes far inside the fetch timeout.
#[test]
fn wikipedia_like_extract_keeps_tables_and_order() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let handle = serve_fixtures(
        server,
        std::collections::HashMap::from([("/".to_string(), "wiki_a.html".to_string())]),
        1,
    );
    let start = std::time::Instant::now();
    let extracted = prism_ingest::web::extract(&format!("http://{address}/")).unwrap();
    let elapsed = start.elapsed();
    handle.join().unwrap();
    assert_eq!(extracted.title, "Fixture Station Alpha");
    let (heading, mid, last) = (
        extracted.body.find("Fixture Station Alpha").unwrap(),
        extracted.body.find("MID-TABLE-MARKER").unwrap(),
        extracted.body.find("LAST-ROW-MARKER").unwrap(),
    );
    assert!(heading < mid && mid < last);
    for chrome in [
        "CHROME-NAV-MARKER",
        "CHROME-FOOTER-MARKER",
        "CHROME-SCRIPT-MARKER",
    ] {
        assert!(
            !extracted.body.contains(chrome),
            "{chrome} leaked into output"
        );
    }
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "large-page extraction took {elapsed:?}"
    );
}
/// Table-heavy multi-page crawl assembles sections in discovery order.
#[test]
fn wikipedia_like_crawl_stays_ordered() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let handle = serve_fixtures(
        server,
        std::collections::HashMap::from([
            ("/".to_string(), "wiki_index.html".to_string()),
            ("/a".to_string(), "wiki_a.html".to_string()),
            ("/b".to_string(), "wiki_b.html".to_string()),
        ]),
        3,
    );
    let extracted = prism_ingest::web::crawl(&format!("http://{address}/"), 3).unwrap();
    handle.join().unwrap();
    let (index, alpha, beta) = (
        extracted.body.find("Fixture Line Index").unwrap(),
        extracted.body.find("Fixture Station Alpha").unwrap(),
        extracted.body.find("Fixture Station Beta").unwrap(),
    );
    assert!(index < alpha && alpha < beta);
    assert!(extracted.body.contains("MID-TABLE-MARKER"));
    assert!(!extracted.body.contains("CHROME-NAV-MARKER"));
}
