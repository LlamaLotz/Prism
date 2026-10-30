//! Search providers. R1 uses DuckDuckGo's keyless HTML endpoint through the
//! existing `web_search` command implementation.
use std::future::Future;
use std::pin::Pin;

#[derive(Clone, Debug)]
pub(crate) struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

pub(crate) trait SearchProvider {
    fn search<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        query: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SearchHit>, String>> + Send + 'a>>;
}

pub(crate) struct DuckDuckGoProvider;

impl SearchProvider for DuckDuckGoProvider {
    fn search<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        query: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<SearchHit>, String>> + Send + 'a>> {
        Box::pin(async move {
            // `web_search` performs the privacy authorization for this exact
            // query; authorizing here as well would prompt the user twice.
            let results = crate::web_search(app.clone(), query.to_string()).await?;
            Ok(results
                .into_iter()
                .filter(|result| {
                    !result.url.trim().is_empty() && !result.title.trim().is_empty()
                })
                .map(|result| SearchHit {
                    title: result.title.trim().to_string(),
                    url: result.url.trim().to_string(),
                    snippet: result.snippet.trim().to_string(),
                })
                .collect())
        })
    }
}
