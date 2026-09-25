use crate::{Error, Extraction, Result};
use std::{
    collections::{HashSet, VecDeque},
    io::Read,
    time::Duration,
};
use url::Url;
const CAP: u64 = 140 * 1024 * 1024;
/// Upper bound on HTML fed to the Markdown converter; larger pages are
/// truncated at a char boundary after the main/article subtree is selected.
const MAX_CONVERT_BYTES: usize = 2 * 1024 * 1024;
/// Upper bound on links harvested per page; crawls only need discovery order.
const MAX_LINKS_PER_PAGE: usize = 2000;
/// Pages fetched concurrently per crawl round; output stays in BFS order.
const CRAWL_WORKERS: usize = 4;
fn main_selector() -> &'static scraper::Selector {
    static SELECTOR: std::sync::OnceLock<scraper::Selector> = std::sync::OnceLock::new();
    SELECTOR.get_or_init(|| scraper::Selector::parse("main, article").unwrap())
}
fn remove_selector() -> &'static scraper::Selector {
    static SELECTOR: std::sync::OnceLock<scraper::Selector> = std::sync::OnceLock::new();
    SELECTOR.get_or_init(|| {
        // img/picture carry no extractable value (media is never downloaded);
        // their attribute dumps are pure noise. figure/figcaption text stays.
        scraper::Selector::parse(
            "script, style, nav, footer, noscript, iframe, button, img, picture",
        )
        .unwrap()
    })
}
fn title_selector() -> &'static scraper::Selector {
    static SELECTOR: std::sync::OnceLock<scraper::Selector> = std::sync::OnceLock::new();
    SELECTOR.get_or_init(|| scraper::Selector::parse("title").unwrap())
}
fn link_selector() -> &'static scraper::Selector {
    static SELECTOR: std::sync::OnceLock<scraper::Selector> = std::sync::OnceLock::new();
    SELECTOR.get_or_init(|| scraper::Selector::parse("a[href]").unwrap())
}
fn nested_table_selector() -> &'static scraper::Selector {
    static SELECTOR: std::sync::OnceLock<scraper::Selector> = std::sync::OnceLock::new();
    SELECTOR.get_or_init(|| scraper::Selector::parse("table table").unwrap())
}
/// Largest main/article subtree serialized; falls back to the full document.
fn content_html(doc: &scraper::Html, html: &str) -> String {
    doc.select(main_selector())
        .max_by_key(|n| n.text().map(str::len).sum::<usize>())
        .map(|e| e.html())
        .unwrap_or_else(|| html.into())
}
fn truncate_bytes(mut content: String) -> String {
    if content.len() > MAX_CONVERT_BYTES {
        let mut end = MAX_CONVERT_BYTES;
        while !content.is_char_boundary(end) {
            end -= 1;
        }
        content.truncate(end);
    }
    content
}
fn fragment_to_markdown(content: &str) -> String {
    let mut fragment = scraper::Html::parse_fragment(content);
    let ids = fragment
        .select(remove_selector())
        .map(|n| n.id())
        .collect::<Vec<_>>();
    for id in ids {
        if let Some(mut n) = fragment.tree.get_mut(id) {
            n.detach();
        }
    }
    flatten_nested_tables(&mut fragment);
    collapse_table_padding(html2md::parse_html(&fragment.html()).trim()).into()
}
/// html2md pads every cell to its column's max width, so one giant cell
/// makes every row kilobytes wide. Collapse padding on table rows only;
/// all other lines pass through byte-identical.
fn collapse_table_padding(md: &str) -> String {
    md.lines()
        .map(|line| {
            if !line.starts_with('|') {
                return line.to_owned();
            }
            // Split on unescaped pipes so `\|` inside cells survives.
            let mut cells = Vec::new();
            let mut current = String::new();
            let mut chars = line.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    current.push(c);
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                } else if c == '|' {
                    cells.push(std::mem::take(&mut current));
                } else {
                    current.push(c);
                }
            }
            cells.push(current);
            // Separator rows collapse to minimal dashes (edge colons kept);
            // trimming alone cannot shrink them since dashes are content.
            // Detection strips edge colons: a data row of all-dash cells is
            // visually a separator anyway, so collapsing it is harmless.
            let is_separator = cells.iter().filter(|c| !c.trim().is_empty()).all(|c| {
                let t = c.trim().strip_prefix(':').unwrap_or(c.trim());
                let t = t.strip_suffix(':').unwrap_or(t);
                !t.is_empty() && t.chars().all(|ch| ch == '-')
            });
            if is_separator {
                let trailing = cells.pop().unwrap_or_default();
                let mut out = String::new();
                for cell in cells {
                    if out.is_empty() {
                        out.push('|');
                    }
                    let t = cell.trim();
                    if t.is_empty() {
                        out.push_str("  |");
                    } else {
                        out.push(' ');
                        if t.starts_with(':') {
                            out.push(':');
                        }
                        out.push_str("---");
                        if t.ends_with(':') {
                            out.push(':');
                        }
                        out.push_str(" |");
                    }
                }
                out.push_str(trailing.trim_end());
                return out;
            }
            // Preserve leading/trailing pipes; trim interior cells. Separator
            // rows stay valid: trimming removes spaces, never the dashes.
            let trailing = cells.pop().unwrap_or_default();
            let mut out = String::new();
            for cell in cells {
                if out.is_empty() {
                    out.push('|');
                }
                out.push(' ');
                out.push_str(cell.trim());
                out.push_str(" |");
            }
            out.push_str(trailing.trim_end());
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}
/// html2md never finishes on deeply nested tables (route maps, navboxes:
/// hundreds of KB with dozens of nested tables). Flatten any table inside
/// another table to div/p so its text survives in reading order without the
/// nesting blowup. Top-level content tables are untouched.
fn flatten_nested_tables(fragment: &mut scraper::Html) {
    let nested: Vec<_> = fragment
        .select(nested_table_selector())
        .map(|n| n.id())
        .collect();
    for id in nested {
        let members: Vec<_> = fragment
            .tree
            .get(id)
            .map(|n| n.descendants().map(|d| d.id()).collect())
            .unwrap_or_default();
        for member in members {
            let action = fragment.tree.get(member).and_then(|n| match n.value() {
                scraper::node::Node::Element(el) => {
                    let tag: &str = &el.name.local;
                    match tag {
                        "table" | "thead" | "tbody" | "tfoot" | "tr" | "colgroup" => Some("div"),
                        "td" | "th" | "caption" => Some("p"),
                        "col" => Some(""),
                        _ => None,
                    }
                }
                _ => None,
            });
            match action {
                // col carries no text; drop it.
                Some("") => {
                    if let Some(mut node) = fragment.tree.get_mut(member) {
                        node.detach();
                    }
                }
                Some(name) => {
                    if let Some(mut node) = fragment.tree.get_mut(member) {
                        if let scraper::node::Node::Element(el) = node.value() {
                            el.name.local = name.into();
                        }
                    }
                }
                None => {}
            }
        }
    }
}
pub fn markdown(html: &str) -> String {
    let doc = scraper::Html::parse_document(html);
    fragment_to_markdown(&truncate_bytes(content_html(&doc, html)))
}
pub fn client(host: Option<String>) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Prism/1.0")
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("Too many redirects");
            }
            if host
                .as_ref()
                .is_some_and(|h| attempt.url().host_str() != Some(h))
            {
                return attempt.error("Cross-host crawl redirect");
            }
            if !matches!(attempt.url().scheme(), "http" | "https") {
                return attempt.error("Non-web redirect");
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| Error::new("extract", e))
}
pub fn fetch(client: &reqwest::blocking::Client, url: &str) -> Result<String> {
    let res = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| Error::new("extract", e))?;
    if res.content_length().is_some_and(|n| n > CAP) {
        return Err(Error::new("unsupported", "HTTP body exceeds limit"));
    }
    let mut bytes = Vec::new();
    res.take(CAP + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > CAP {
        return Err(Error::new("unsupported", "HTTP body exceeds limit"));
    }
    String::from_utf8(bytes)
        .map_err(|e| Error::new("quality", format!("Unsupported webpage encoding: {e}")))
}
#[cfg(feature = "browser")]
fn render(url: &str, host: Option<String>) -> Result<String> {
    use futures::StreamExt;
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| Error::new("unavailable", e))?
        .block_on(async {
            use chromiumoxide::{Browser, BrowserConfig};
            let config = BrowserConfig::builder()
                .chrome_executable(crate::process::binary("chromium"))
                .enable_request_intercept()
                .build()
                .map_err(|e| Error::new("unavailable", e))?;
            let (mut browser, mut handler) = Browser::launch(config)
                .await
                .map_err(|e| Error::new("unavailable", e))?;
            let task = tokio::spawn(async move { while let Some(_) = handler.next().await {} });
            let result = tokio::time::timeout(Duration::from_secs(30), async {
                use chromiumoxide::cdp::browser_protocol::{
                    fetch::{ContinueRequestParams, EventRequestPaused, FailRequestParams},
                    network::{ErrorReason, ResourceType},
                };
                let page = std::sync::Arc::new(
                    browser
                        .new_page("about:blank")
                        .await
                        .map_err(|e| Error::new("extract", e))?,
                );
                let mut requests = page
                    .event_listener::<EventRequestPaused>()
                    .await
                    .map_err(|e| Error::new("extract", e))?;
                let intercept_page = page.clone();
                let interception = tokio::spawn(async move {
                    while let Some(event) = requests.next().await {
                        let blocked = event.resource_type == ResourceType::Document
                            && host.as_ref().is_some_and(|h| {
                                Url::parse(&event.request.url)
                                    .ok()
                                    .and_then(|u| u.host_str().map(str::to_owned))
                                    .as_ref()
                                    != Some(h)
                            });
                        if blocked {
                            let _ = intercept_page
                                .execute(FailRequestParams::new(
                                    event.request_id.clone(),
                                    ErrorReason::BlockedByClient,
                                ))
                                .await;
                        } else {
                            let _ = intercept_page
                                .execute(ContinueRequestParams::new(event.request_id.clone()))
                                .await;
                        }
                    }
                });
                let result = async {
                    page.goto(url).await.map_err(|e| Error::new("extract", e))?;
                    let html = page.content().await.map_err(|e| Error::new("extract", e))?;
                    if html.len() as u64 > CAP {
                        return Err(Error::new(
                            "unsupported",
                            "Rendered HTML exceeds buffer limit",
                        ));
                    }
                    Ok(html)
                }
                .await;
                interception.abort();
                result
            })
            .await
            .map_err(|_| Error::new("timeout", "Chromium deadline"));
            let _ = tokio::time::timeout(Duration::from_secs(2), browser.close()).await;
            let _ = browser.kill().await;
            task.abort();
            result?
        })
}
#[cfg(not(feature = "browser"))]
fn render(_: &str, _: Option<String>) -> Result<String> {
    Err(Error::new("unavailable", "Chromium support not compiled"))
}
fn page(
    url: &str,
    client: &reqwest::blocking::Client,
    host: Option<String>,
) -> Result<(Extraction, Vec<String>)> {
    crate::event("progress", format!("Fetching {url}"));
    let html = fetch(client, url)?;
    crate::event(
        "progress",
        format!("Fetched {} bytes from {url}, parsing", html.len()),
    );
    // Single DOM parse: title, links, and body all come from one document.
    if let Some(result) = convert(&html)? {
        let (title, links, body) = result;
        return Ok((
            Extraction {
                stem: title.clone(),
                title,
                body,
                source: url.into(),
                engine: "Prism Web".into(),
                kind: "web".into(),
            },
            links,
        ));
    }
    // Thin content falls back to rendering; a second parse covers that HTML.
    crate::event(
        "progress",
        format!("Content thin, trying rendered page {url}"),
    );
    let html = render(url, host)?;
    let (title, links, body) =
        convert(&html)?.ok_or_else(|| Error::new("quality", "Insufficient webpage content"))?;
    Ok((
        Extraction {
            stem: title.clone(),
            title,
            body,
            source: url.into(),
            engine: "Prism Web".into(),
            kind: "web".into(),
        },
        links,
    ))
}
/// Parse once and return title, capped links, and Markdown body.
/// `Ok(None)` means the page is too thin (caller may try rendering).
fn convert(html: &str) -> Result<Option<(String, Vec<String>, String)>> {
    let doc = scraper::Html::parse_document(html);
    let title = doc
        .select(title_selector())
        .next()
        .map(|n| n.text().collect::<String>())
        .unwrap_or_else(|| "Web Page".into());
    let links = doc
        .select(link_selector())
        .take(MAX_LINKS_PER_PAGE)
        .filter_map(|n| n.value().attr("href").map(str::to_owned))
        .collect();
    let body = fragment_to_markdown(&truncate_bytes(content_html(&doc, html)));
    if crate::meaningful(&body) < 10 {
        return Ok(None);
    }
    Ok(Some((title, links, body)))
}
pub fn extract(url: &str) -> Result<Extraction> {
    Ok(page(url, &client(None)?, None)?.0)
}
pub fn canonical(base: &Url, link: &str) -> Option<Url> {
    let mut url = base.join(link).ok()?;
    url.set_fragment(None);
    (matches!(url.scheme(), "http" | "https") && url.host_str() == base.host_str()).then_some(url)
}
pub fn crawl(source: &str, max: usize) -> Result<Extraction> {
    let max = max.max(1);
    let start = Url::parse(source).map_err(|e| Error::new("input", e))?;
    let client = client(start.host_str().map(str::to_owned))?;
    let mut queue = VecDeque::from([start.clone()]);
    let mut seen = HashSet::from([start.to_string()]);
    let mut sections = Vec::new();
    let mut attempted = 0;
    // Rounds of up to CRAWL_WORKERS concurrent fetches; results are joined
    // in discovery order so output stays deterministic BFS.
    while !queue.is_empty() && attempted < max {
        let take = (max - attempted).min(CRAWL_WORKERS).min(queue.len());
        let batch: Vec<Url> = queue.drain(..take).collect();
        for url in &batch {
            attempted += 1;
            crate::event("progress", format!("{attempted}/{max} Crawling {url}"));
        }
        let host = start.host_str().map(str::to_owned);
        let mut results = std::thread::scope(|scope| {
            batch
                .into_iter()
                .enumerate()
                .map(|(i, url)| {
                    let host = host.clone();
                    let client = client.clone();
                    let handle = scope.spawn(move || {
                        let result = page(url.as_str(), &client, host);
                        (i, url, result)
                    });
                    handle
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| match handle.join() {
                    Ok(done) => done,
                    Err(_) => (
                        usize::MAX,
                        start.clone(),
                        Err(Error::new("extract", "Crawl worker panicked")),
                    ),
                })
                .collect::<Vec<_>>()
        });
        results.sort_by_key(|(i, _, _)| *i);
        for (_, url, result) in results {
            match result {
                Ok((e, links)) => {
                    sections.push(format!("## {}\n\nURL: {}\n\n{}", e.title, url, e.body));
                    for href in links {
                        if seen.len() >= max {
                            break;
                        }
                        if let Some(next) = canonical(&start, &href) {
                            if seen.insert(next.to_string()) {
                                queue.push_back(next);
                            }
                        }
                    }
                }
                Err(e) => crate::event("diagnostic", e),
            }
        }
    }
    if sections.is_empty() {
        return Err(Error::new("quality", "No crawl pages extracted"));
    }
    Ok(Extraction {
        title: "Extracted web content".into(),
        stem: "extracted_web_content".into(),
        source: source.into(),
        engine: "Prism Web".into(),
        kind: "crawl".into(),
        body: sections.join("\n\n---\n\n"),
    })
}
