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
