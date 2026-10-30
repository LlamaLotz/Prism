//! Keyless web search.
//!
//! DuckDuckGo's HTML endpoint is the default, but it now answers automated
//! clients with a JavaScript challenge instead of results (HTTP 202). When it
//! yields nothing, we fall back to public keyless knowledge APIs: Wikipedia,
//! Stack Exchange and Hacker News. They return direct article URLs that the
//! research fetcher can read, and they keep working when a SERP blocks the
//! client.
use crate::{knowledge, WebSearchResult};
use scraper::Html;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

const MAX_RESULTS: usize = 10;
const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Prism/1.0";
const FALLBACK_HOSTS: &str = "wikipedia.org, stackexchange.com, news.ycombinator.com";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())
}

/// Consent may wait on a user decision, so it runs off the async workers.
async fn authorize(app: &tauri::AppHandle, destination: &str, query: &str) -> Result<(), String> {
    let app = app.clone();
    let destination = destination.to_string();
    let query = query.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        knowledge::models::authorize(&app, &destination, "WEB_SEARCH", &query, false, false)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Searches the web for `query`. Consent is checked before any external
/// request; a Strict Local policy still refuses the whole operation.
pub(crate) async fn run(
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<WebSearchResult>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Enter a search query.".into());
    }

    authorize(&app, "https://html.duckduckgo.com", &query).await?;
    if let Ok(results) = duckduckgo(&query).await {
        let results = bound(results);
        if !results.is_empty() {
            return Ok(results);
        }
    }

    authorize(&app, FALLBACK_HOSTS, &query).await?;
    // Wikipedia and Hacker News serve readable HTML; Stack Exchange pages sit
    // behind a bot wall, so it comes last and simply drops out when unreadable.
    let mut results = wikipedia(&query).await;
    results.extend(hacker_news(&query).await);
    results.extend(stackexchange(&query).await);
    let results = bound(results);
    if results.is_empty() {
        return Err(
            "No search provider returned results. This network blocks DuckDuckGo and the fallback sources had no matches.".into(),
        );
    }
    Ok(results)
}

/// De-duplicates by URL, drops unusable rows and caps the list. Result order is
/// preserved so the primary provider keeps its ranking.
fn bound(results: Vec<WebSearchResult>) -> Vec<WebSearchResult> {
    let mut seen = HashSet::new();
    results
        .into_iter()
        .filter(|result| {
            let url = result.url.trim();
            !result.title.trim().is_empty()
                && (url.starts_with("https://") || url.starts_with("http://"))
                && seen.insert(url.to_string())
        })
        .take(MAX_RESULTS)
        .collect()
}

/// Extracts readable text from a search-provider snippet. Provider snippets are
/// HTML fragments with match markup and entities.
fn plain(html: &str) -> String {
    if html.trim().is_empty() {
        return String::new();
    }
    Html::parse_fragment(html)
        .root_element()
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn duckduckgo(query: &str) -> Result<Vec<WebSearchResult>, String> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(query)
    );
    let body = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;
    Ok(parse_duckduckgo(&body))
}

pub(crate) fn parse_duckduckgo(body: &str) -> Vec<WebSearchResult> {
    let document = Html::parse_document(body);
    let Ok(link) = scraper::Selector::parse(".result__a") else {
        return Vec::new();
    };
    let Ok(snippet) = scraper::Selector::parse(".result__snippet") else {
        return Vec::new();
    };
    let Ok(container) = scraper::Selector::parse(".result.results_links") else {
        return Vec::new();
    };
    let mut results = Vec::new();
    for item in document.select(&container) {
        let title = item
            .select(&link)
            .next()
            .map(|element| element.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        let url = item
            .select(&link)
            .next()
            .and_then(|element| element.value().attr("href"))
            .unwrap_or("")
            .to_string();
        let snippet = item
            .select(&snippet)
            .next()
            .map(|element| element.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        if !title.is_empty() {
            results.push(WebSearchResult {
                title,
                url,
                snippet,
            });
        }
        if results.len() >= 5 {
            break;
        }
    }
    results
}

fn parse_wikipedia(value: &Value) -> Vec<WebSearchResult> {
    value
        .get("query")
        .and_then(|query| query.get("search"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let title = plain(item.get("title")?.as_str()?);
            if title.is_empty() {
                return None;
            }
            let url = format!(
                "https://en.wikipedia.org/wiki/{}",
                urlencoding::encode(&title.replace(' ', "_"))
            );
            Some(WebSearchResult {
                title,
                url,
                snippet: plain(item.get("snippet").and_then(Value::as_str).unwrap_or("")),
            })
        })
        .collect()
}

async fn wikipedia(query: &str) -> Vec<WebSearchResult> {
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&format=json&srlimit=5&utf8=1",
        urlencoding::encode(query)
    );
    fetch_json(&url)
        .await
        .map(|value| parse_wikipedia(&value))
        .unwrap_or_default()
}

fn parse_stackexchange(value: &Value) -> Vec<WebSearchResult> {
    value
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let title = plain(item.get("title")?.as_str()?);
            let url = item.get("link")?.as_str()?.to_string();
            if title.is_empty() {
                return None;
            }
            let tags = item
                .get("tags")
                .and_then(Value::as_array)
                .map(|tags| {
                    tags.iter()
                        .filter_map(Value::as_str)
                        .take(3)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            Some(WebSearchResult {
                title,
                url,
                snippet: if tags.is_empty() {
                    "Stack Overflow".into()
                } else {
                    format!("Stack Overflow · {tags}")
                },
            })
        })
        .collect()
}

async fn stackexchange(query: &str) -> Vec<WebSearchResult> {
    let url = format!(
        "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q={}&site=stackoverflow&pagesize=5",
        urlencoding::encode(query)
    );
    fetch_json(&url)
        .await
        .map(|value| parse_stackexchange(&value))
        .unwrap_or_default()
}

fn parse_hacker_news(value: &Value) -> Vec<WebSearchResult> {
    value
        .get("hits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|hit| {
            let title = hit.get("title").and_then(Value::as_str)?.trim().to_string();
            if title.is_empty() {
                return None;
            }
            let url = hit
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| !url.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let id = hit.get("objectID").and_then(Value::as_str).unwrap_or_default();
                    format!("https://news.ycombinator.com/item?id={id}")
                });
            let snippet = hit
                .get("story_text")
                .and_then(Value::as_str)
                .map(plain)
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "Hacker News discussion".into());
            Some(WebSearchResult {
                title,
                url,
                snippet,
            })
        })
        .collect()
}

async fn hacker_news(query: &str) -> Vec<WebSearchResult> {
    let url = format!(
        "https://hn.algolia.com/api/v1/search?query={}&tags=story&hitsPerPage=5",
        urlencoding::encode(query)
    );
    fetch_json(&url)
        .await
        .map(|value| parse_hacker_news(&value))
        .unwrap_or_default()
}

async fn fetch_json(url: &str) -> Result<Value, String> {
    let response = client()?.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Search source returned HTTP {}", response.status().as_u16()));
    }
    response.json().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snippets_are_stripped_and_entity_decoded() {
        assert_eq!(
            plain("<span class=\"searchmatch\">Rust</span> &amp; tokio"),
            "Rust & tokio"
        );
        assert_eq!(plain("  "), "");
    }

    #[test]
    fn wikipedia_rows_become_article_urls() {
        let value = json!({"query":{"search":[
            {"title":"Rust (programming language)","snippet":"<span class=\"searchmatch\">Rust</span> is a language."},
            {"title":"","snippet":"skip"}
        ]}});
        let rows = parse_wikipedia(&value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Rust (programming language)");
        assert_eq!(rows[0].snippet, "Rust is a language.");
        assert!(rows[0].url.starts_with("https://en.wikipedia.org/wiki/Rust_"));
    }

    #[test]
    fn stackexchange_rows_keep_titles_and_links() {
        let value = json!({"items":[
            {"title":"How do Rust async runtimes handle channels?","link":"https://stackoverflow.com/q/1","tags":["rust","async"]}
        ]});
        let rows = parse_stackexchange(&value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].url, "https://stackoverflow.com/q/1");
        assert!(rows[0].snippet.contains("rust, async"));
    }

    #[test]
    fn hacker_news_falls_back_to_the_discussion_url() {
        let value = json!({"hits":[
            {"title":"Ask HN: best async runtime?","url":null,"objectID":"42","story_text":"<p>Discuss</p>"},
            {"title":"Tokio internals","url":"https://example.com/tokio","objectID":"43"}
        ]});
        let rows = parse_hacker_news(&value);
        assert_eq!(rows[0].url, "https://news.ycombinator.com/item?id=42");
        assert_eq!(rows[0].snippet, "Discuss");
        assert_eq!(rows[1].url, "https://example.com/tokio");
    }

    #[test]
    fn duckduckgo_challenge_pages_yield_no_rows() {
        assert!(parse_duckduckgo("<html><body>challenge</body></html>").is_empty());
        let body = r#"<div class="result results_links"><a class="result__a" href="https://example.com">Example</a><a class="result__snippet">An example result.</a></div>"#;
        let rows = parse_duckduckgo(body);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].url, "https://example.com");
    }

    #[test]
    #[ignore = "requires network access"]
    fn live_fallbacks_return_readable_results() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let rows = runtime.block_on(async {
            let mut rows = wikipedia("rust async runtime").await;
            rows.extend(hacker_news("rust async runtime").await);
            rows
        });
        assert!(!rows.is_empty());
        assert!(rows.iter().any(|row| row.url.starts_with("https://")));
    }

    #[test]
    fn results_are_deduped_and_capped() {
        let rows = (0..15)
            .map(|index| WebSearchResult {
                title: format!("result {index}"),
                url: format!("https://example.com/{}", index % 12),
                snippet: String::new(),
            })
            .collect();
        let rows = bound(rows);
        assert_eq!(rows.len(), MAX_RESULTS);
        let mut urls = rows.iter().map(|row| row.url.clone()).collect::<Vec<_>>();
        urls.sort();
        urls.dedup();
        assert_eq!(urls.len(), rows.len());
    }
}
