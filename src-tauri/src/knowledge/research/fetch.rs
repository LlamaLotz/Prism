//! Safe HTML fetching and readable-text extraction for research.
use reqwest::{
    header::CONTENT_TYPE,
    redirect::Policy,
    Url,
};
use scraper::{ElementRef, Html, Selector};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    time::Duration,
};

use super::dedupe::sha256_hex;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHARS: usize = 240_000;
const SKIP: [&str; 9] = [
    "nav", "footer", "header", "aside", "form", "script", "style", "noscript", "iframe",
];

pub(crate) struct FetchedPage {
    pub url: String,
    pub title: String,
    pub text: String,
    pub hash: String,
    pub content_type: String,
    pub fetched_at: i64,
}

fn global_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
    {
        return false;
    }
    // Reserved, carrier-grade NAT, documentation, benchmarking and future use.
    if a == 0 || a >= 240 {
        return false;
    }
    if a == 100 && (64..=127).contains(&b) {
        return false;
    }
    if a == 169 && b == 254 {
        return false;
    }
    if a == 192 && b == 0 && (c == 0 || c == 2) {
        return false;
    }
    if a == 192 && b == 88 && c == 99 {
        return false;
    }
    if a == 198 && (b == 18 || b == 19) {
        return false;
    }
    if a == 198 && b == 51 && c == 100 {
        return false;
    }
    if a == 203 && b == 0 && c == 113 {
        return false;
    }
    true
}

fn global_v6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return global_v4(mapped);
    }
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    let segments = ip.segments();
    // Unique local (fc00::/7), link local (fe80::/10), and anything outside
    // the global-unicast 2000::/3 block.
    if segments[0] & 0xfe00 == 0xfc00 || segments[0] & 0xffc0 == 0xfe80 {
        return false;
    }
    if segments[0] & 0xe000 != 0x2000 {
        return false;
    }
    // Documentation range (2001:db8::/32).
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return false;
    }
    true
}

/// Whether an address is publicly routable. Loopback, private, link-local,
/// multicast, documentation and reserved ranges are rejected so discovered
/// URLs cannot probe the local network.
pub(crate) fn is_global_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => global_v4(ip),
        IpAddr::V6(ip) => global_v6(ip),
    }
}

fn validate_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https URLs can be read".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials are not allowed".into());
    }
    let host = url.host_str().ok_or("URL has no host")?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_global_ip(ip) {
            return Err(format!("Blocked non-public address {ip}"));
        }
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve {host}: {e}"))?
        .collect();
    if addresses.is_empty() {
        return Err(format!("Could not resolve {host}"));
    }
    if let Some(address) = addresses.iter().find(|address| !is_global_ip(address.ip())) {
        return Err(format!(
            "Blocked non-public address {} for {host}",
            address.ip()
        ));
    }
    Ok(())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("PrismResearch/1.0")
        .timeout(Duration::from_secs(8))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.stop();
            }
            let same_host = attempt
                .previous()
                .first()
                .and_then(|url| url.host_str())
                == attempt.url().host_str();
            if same_host {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn normalize_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn skipped(element: &ElementRef<'_>) -> bool {
    if SKIP.contains(&element.value().name()) {
        return true;
    }
    let mut current = element.parent();
    while let Some(node) = current {
        if let Some(element) = ElementRef::wrap(node.clone()) {
            if SKIP.contains(&element.value().name()) {
                return true;
            }
        }
        current = node.parent();
    }
    false
}

pub(crate) struct Extracted {
    pub title: String,
    pub text: String,
    pub hash: String,
}

/// Extracts readable text from an HTML document. Candidate selectors keep
/// paragraph/article structure; navigation and executable content never enter
/// the text returned to callers.
pub(crate) fn extract(html: &str) -> Extracted {
    let document = Html::parse_document(html);
    let title_selector = Selector::parse("title").unwrap();
    let h1_selector = Selector::parse("h1").unwrap();
    let title = document
        .select(&title_selector)
        .next()
        .map(|element| normalize_line(&element.text().collect::<String>()))
        .filter(|title| !title.is_empty())
        .or_else(|| {
            document
                .select(&h1_selector)
                .next()
                .map(|element| normalize_line(&element.text().collect::<String>()))
                .filter(|title| !title.is_empty())
        })
        .unwrap_or_default();

    let keep = Selector::parse("h1, h2, h3, h4, h5, h6, p, li, pre, blockquote").unwrap();
    let article = Selector::parse("article").unwrap();
    let main = Selector::parse("main").unwrap();
    let body = Selector::parse("body").unwrap();
    let root = document
        .select(&article)
        .next()
        .or_else(|| document.select(&main).next())
        .or_else(|| document.select(&body).next());

    let mut lines: Vec<String> = Vec::new();
    if let Some(root) = root {
        for element in root.select(&keep) {
            if skipped(&element) {
                continue;
            }
            let line = normalize_line(&element.text().collect::<String>());
            if !line.is_empty() && lines.last() != Some(&line) {
                lines.push(line);
            }
        }
        if lines.is_empty() {
            let fallback = normalize_line(&root.text().collect::<String>());
            if !fallback.is_empty() {
                lines.push(fallback);
            }
        }
    }
    let text: String = lines.join("\n");
    let text: String = text.chars().take(MAX_CHARS).collect();
    Extracted {
        title,
        hash: sha256_hex(&text),
        text,
    }
}

pub(crate) async fn fetch_page(
    app: &tauri::AppHandle,
    raw_url: &str,
    query: &str,
) -> Result<FetchedPage, String> {
    let url = Url::parse(raw_url).map_err(|_| "Invalid URL")?;
    validate_url(&url)?;
    crate::knowledge::models::authorize(app, url.as_str(), "RESEARCH", query, false, false)?;

    let mut response = client()?
        .get(url.clone())
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "SKIPPED: {url} returned HTTP {}; the page could not be read.",
            status.as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let lower = content_type.to_ascii_lowercase();
    if !(lower.starts_with("text/html") || lower.starts_with("application/xhtml+xml")) {
        return Err(format!(
            "SKIPPED: {url} served {}; Discover reads HTML pages only.",
            if content_type.is_empty() {
                "an unknown content type"
            } else {
                content_type.as_str()
            }
        ));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Network error: {e}"))?
    {
        let remaining = MAX_BYTES.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() >= MAX_BYTES {
            break;
        }
    }
    let html = String::from_utf8_lossy(&body);
    let extracted = extract(&html);
    if extracted.text.is_empty() {
        return Err(format!(
            "SKIPPED: {url} did not contain readable article text."
        ));
    }
    Ok(FetchedPage {
        url: url.to_string(),
        title: if extracted.title.is_empty() {
            url.host_str().unwrap_or_default().to_string()
        } else {
            extracted.title
        },
        text: extracted.text,
        hash: extracted.hash,
        content_type,
        fetched_at: crate::study::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssrf_host_classification_rejects_local_and_reserved_ranges() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "100.64.0.1",
            "192.0.2.10",
            "198.51.100.4",
            "203.0.113.9",
            "198.18.0.1",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_global_ip(ip.parse().unwrap()),
                "{ip} must be treated as non-public"
            );
        }
        for ip in ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(
                is_global_ip(ip.parse().unwrap()),
                "{ip} must be treated as public"
            );
        }
    }

    #[test]
    fn extraction_prefers_article_and_skips_navigation() {
        let html = r#"<html><head><title>  A   title </title></head><body>
            <nav>Ignore this menu</nav><header>Ignore header</header>
            <article><h1>Heading</h1><p>First   paragraph.</p>
            <script>alert(1)</script><p>Second <b>paragraph</b>.</p></article>
            <footer>Ignore footer</footer></body></html>"#;
        let extracted = extract(html);
        assert_eq!(extracted.title, "A title");
        assert!(extracted.text.contains("First paragraph."));
        assert!(extracted.text.contains("Second paragraph."));
        assert!(!extracted.text.contains("Ignore this menu"));
        assert!(!extracted.text.contains("Ignore header"));
        assert!(!extracted.text.contains("alert(1)"));
        assert!(!extracted.text.contains("Ignore footer"));
        assert_eq!(extracted.hash, sha256_hex(&extracted.text));
    }
}
