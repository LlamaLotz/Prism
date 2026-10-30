//! Deterministic URL/content identity for research candidates.
use reqwest::Url;
use std::collections::HashMap;
use std::path::Path;

pub(crate) fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(text.as_bytes());
    format!("{:x}", digest.finalize())
}

fn tracking(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.starts_with("utm_") || matches!(key.as_str(), "fbclid" | "gclid" | "ref")
}

/// Canonical URL identity used for de-duplication. Host casing, fragments,
/// tracking parameters and trailing slashes are not meaningful differences.
pub(crate) fn normalize_url(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    url.set_host(Some(&host)).ok()?;
    url.set_fragment(None);
    let query: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| !tracking(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    if !query.is_empty() {
        url.query_pairs_mut()
            .extend_pairs(query.iter().map(|(key, value)| (key.as_str(), value.as_str())));
    }
    let mut path = url.path().to_string();
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    url.set_path(&path);
    Some(url.to_string())
}

pub(crate) fn domain(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .map(|host| host.trim_start_matches("www.").to_ascii_lowercase())
        .unwrap_or_default()
}

fn title_key(title: &str) -> String {
    title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_domain(title: &str, domain: &str) -> String {
    format!("{}|{}", title_key(title), domain.to_ascii_lowercase())
}

pub(crate) struct ExistingSource {
    pub key: String,
    pub title: String,
    pub url: Option<String>,
    pub path: Option<String>,
}

/// Tracks identities seen in the current candidate set and in the existing
/// collection. Duplicates are retained (the UI can explain them) but point at
/// the first source that established the identity.
pub(crate) struct Dedupe {
    urls: HashMap<String, String>,
    hashes: HashMap<String, String>,
    titles: HashMap<String, String>,
}

impl Dedupe {
    pub(crate) fn with_existing(existing: &[ExistingSource]) -> Self {
        let mut dedupe = Self {
            urls: HashMap::new(),
            hashes: HashMap::new(),
            titles: HashMap::new(),
        };
        for source in existing {
            if let Some(url) = source.url.as_deref().and_then(normalize_url) {
                dedupe.urls.entry(url).or_insert_with(|| source.key.clone());
            }
            let title = title_key(&source.title);
            if !title.is_empty() {
                dedupe.titles.entry(title).or_insert_with(|| source.key.clone());
            }
            if let Some(path) = source.path.as_deref() {
                if let Some(stem) = Path::new(path).file_stem().and_then(|s| s.to_str()) {
                    let stem = title_key(stem);
                    if !stem.is_empty() {
                        dedupe.titles.entry(stem).or_insert_with(|| source.key.clone());
                    }
                }
            }
        }
        dedupe
    }

    /// Returns the key this candidate duplicates, if any. Precedence is URL,
    /// then content hash, then title+domain, then an existing collection title.
    pub(crate) fn duplicate(
        &mut self,
        url: &str,
        hash: &str,
        title: &str,
        domain: &str,
        key: &str,
    ) -> Option<String> {
        let normalized = normalize_url(url);
        if let Some(found) = normalized
            .as_ref()
            .and_then(|url| self.urls.get(url))
            .cloned()
        {
            return Some(found);
        }
        if let Some(found) = self.hashes.get(hash) {
            return Some(found.clone());
        }
        let scoped = title_domain(title, domain);
        if let Some(found) = self.titles.get(&scoped) {
            return Some(found.clone());
        }
        let bare = title_key(title);
        if let Some(found) = self.titles.get(&bare) {
            return Some(found.clone());
        }
        if let Some(url) = normalized {
            self.urls.insert(url, key.to_string());
        }
        self.hashes.insert(hash.to_string(), key.to_string());
        self.titles.insert(scoped, key.to_string());
        if !bare.is_empty() {
            self.titles.insert(bare, key.to_string());
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls_for_deduplication() {
        assert_eq!(
            normalize_url("HTTPS://Example.COM:443/Path/?utm_source=x&b=2&a=1#frag").as_deref(),
            Some("https://example.com/Path?b=2&a=1")
        );
        assert_eq!(
            normalize_url("https://example.com/a/?fbclid=1&gclid=2&ref=nav").as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(normalize_url("ftp://example.com/a"), None);
        assert_eq!(normalize_url("https://user:pass@example.com/a"), None);
    }

    #[test]
    fn content_hashes_are_stable_and_content_addressed() {
        assert_eq!(sha256_hex("same text"), sha256_hex("same text"));
        assert_ne!(sha256_hex("same text"), sha256_hex("same text "));
        assert_eq!(sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn dedupe_precedence_is_url_then_hash_then_title() {
        let mut dedupe = Dedupe::with_existing(&[ExistingSource {
            key: "web:existing".into(),
            title: "Known page".into(),
            url: Some("https://known.example/page?utm_source=x".into()),
            path: None,
        }]);
        assert_eq!(
            dedupe
                .duplicate(
                    "https://known.example/page",
                    "hash-a",
                    "Different title",
                    "known.example",
                    "web:a"
                )
                .as_deref(),
            Some("web:existing")
        );
        assert_eq!(
            dedupe
                .duplicate("https://first.example/", "hash-b", "First", "first.example", "web:b"),
            None
        );
        assert_eq!(
            dedupe
                .duplicate("https://second.example/", "hash-b", "Second", "second.example", "web:c")
                .as_deref(),
            Some("web:b")
        );
        assert_eq!(
            dedupe
                .duplicate("https://third.example/", "hash-c", "First", "first.example", "web:d")
                .as_deref(),
            Some("web:b")
        );
        assert_eq!(
            dedupe
                .duplicate("https://fourth.example/", "hash-d", "Known page", "other.example", "web:e")
                .as_deref(),
            Some("web:existing")
        );
    }
}
