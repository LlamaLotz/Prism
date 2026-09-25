use crate::{Error, Extraction, Result};
use std::{
    collections::{HashSet, VecDeque},
    io::Read,
    time::Duration,
};
use url::Url;
const CAP: u64 = 140 * 1024 * 1024;
pub fn markdown(html: &str) -> String {
    let doc = scraper::Html::parse_document(html);
    let selector = scraper::Selector::parse("main, article").unwrap();
    let content = doc
        .select(&selector)
        .max_by_key(|n| n.text().map(str::len).sum::<usize>())
        .map(|e| e.html())
        .unwrap_or_else(|| html.into());
    let mut fragment = scraper::Html::parse_fragment(&content);
    let remove =
        scraper::Selector::parse("script, style, nav, footer, noscript, iframe, button").unwrap();
    let ids = fragment.select(&remove).map(|n| n.id()).collect::<Vec<_>>();
    for id in ids {
        if let Some(mut n) = fragment.tree.get_mut(id) {
            n.detach();
        }
    }
    html2md::parse_html(&fragment.html()).trim().into()
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
    let mut html = fetch(client, url)?;
    let mut body = markdown(&html);
    if crate::meaningful(&body) < 10 {
        html = render(url, host)?;
        body = markdown(&html);
    }
    if crate::meaningful(&body) < 10 {
        return Err(Error::new("quality", "Insufficient webpage content"));
    }
    let doc = scraper::Html::parse_document(&html);
    let title = doc
        .select(&scraper::Selector::parse("title").unwrap())
        .next()
        .map(|n| n.text().collect::<String>())
        .unwrap_or_else(|| "Web Page".into());
    let links = doc
        .select(&scraper::Selector::parse("a[href]").unwrap())
        .filter_map(|n| n.value().attr("href").map(str::to_owned))
        .collect();
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
pub fn extract(url: &str) -> Result<Extraction> {
    Ok(page(url, &client(None)?, None)?.0)
}
pub fn canonical(base: &Url, link: &str) -> Option<Url> {
    let mut url = base.join(link).ok()?;
    url.set_fragment(None);
    (matches!(url.scheme(), "http" | "https") && url.host_str() == base.host_str()).then_some(url)
}
pub fn crawl(source: &str, max: usize) -> Result<Extraction> {
    let start = Url::parse(source).map_err(|e| Error::new("input", e))?;
    let client = client(start.host_str().map(str::to_owned))?;
    let mut queue = VecDeque::from([start.clone()]);
    let mut seen = HashSet::from([start.to_string()]);
    let mut sections = Vec::new();
    let mut attempted = 0;
    while let Some(url) = queue.pop_front() {
        if attempted >= max.max(1) {
            break;
        }
        attempted += 1;
        crate::event(
            "progress",
            format!("{attempted}/{} Crawling {url}", max.max(1)),
        );
        match page(url.as_str(), &client, start.host_str().map(str::to_owned)) {
            Ok((e, links)) => {
                sections.push(format!("## {}\n\nURL: {}\n\n{}", e.title, url, e.body));
                for href in links {
                    if let Some(next) = canonical(
                        &start,
                        &url.join(&href).map(|u| u.to_string()).unwrap_or_default(),
                    ) {
                        if seen.len() < max.max(1) && seen.insert(next.to_string()) {
                            queue.push_back(next);
                        }
                    }
                }
            }
            Err(e) => crate::event("diagnostic", e),
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
