//! Safe, deterministic note formatting.
//!
//! This formatter never infers structure from prose and never joins lines. It
//! only normalizes the syntax a note already has, so running it cannot delete
//! page numbers, merge paragraphs, or invent headings.

use super::{heading, split_frontmatter, OutlineNode};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFormatRequest {
    pub title: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFormatPreview {
    pub content: String,
    pub changed: bool,
    pub outline: Vec<OutlineNode>,
    pub warnings: Vec<String>,
}

fn first_h1(body: &str) -> Option<String> {
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some((1, text)) = heading(line) {
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn normalize_heading(line: &str, title: &str) -> Option<String> {
    let (level, text) = heading(line)?;
    let text = text.trim();
    if level == 1 {
        if text.eq_ignore_ascii_case(title) {
            return None;
        }
        // The note title is the only H1. Preserve every other H1 as a section.
        return Some(if text.is_empty() {
            "##".to_string()
        } else {
            format!("## {text}")
        });
    }
    Some(if text.is_empty() {
        "#".repeat(level as usize)
    } else {
        format!("{} {text}", "#".repeat(level as usize))
    })
}

fn normalize(body: &str, title: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let line = line.trim_end();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push(line.to_string());
            continue;
        }
        if in_fence {
            out.push(line.to_string());
            continue;
        }
        let leading = line.chars().take_while(|c| *c == ' ' || *c == '\t').count();
        if leading >= 4 {
            // Indented code blocks are not headings and keep their content.
            out.push(line.to_string());
            continue;
        }
        if let Some(normalized) = normalize_heading(line, title) {
            if out
                .last()
                .is_some_and(|previous| !previous.trim().is_empty())
            {
                out.push(String::new());
            }
            out.push(normalized);
            out.push(String::new());
        } else if heading(line)
            .is_some_and(|(level, text)| level == 1 && text.trim().eq_ignore_ascii_case(title))
        {
            // The title H1 is inserted at the top; drop only this duplicate.
        } else if line.trim().is_empty() {
            if out
                .last()
                .is_some_and(|previous| !previous.trim().is_empty())
            {
                out.push(String::new());
            }
        } else {
            out.push(line.to_string());
        }
    }
    while out.first().is_some_and(|line| line.trim().is_empty()) {
        out.remove(0);
    }
    while out.last().is_some_and(|line| line.trim().is_empty()) {
        out.pop();
    }
    out
}

pub(super) fn preview(request: NoteFormatRequest) -> Result<NoteFormatPreview, String> {
    if request.content.len() > 64 * 1024 * 1024 {
        return Err("LIMIT: note exceeds the 64 MiB formatting preview limit".into());
    }
    let content = request.content.replace("\r\n", "\n").replace('\r', "\n");
    let (frontmatter, body) = split_frontmatter(&content);
    let title = if request.title.trim().is_empty() {
        first_h1(body).unwrap_or_else(|| "Note".into())
    } else {
        request.title.trim().to_string()
    };
    let mut lines = normalize(body, &title);
    let mut out = String::new();
    if !frontmatter.is_empty() {
        out.push_str(frontmatter.trim_end_matches('\n'));
        out.push_str("\n\n");
    }
    out.push_str(&format!("# {title}\n"));
    if !lines.is_empty() {
        out.push('\n');
        out.push_str(&lines.join("\n"));
        out.push('\n');
    }
    let formatted = out;
    let (outline, warnings) = match super::inspect(&formatted, &title, None) {
        Ok(value) => (value.outline, value.warnings),
        Err(error) => (Vec::new(), vec![error]),
    };
    Ok(NoteFormatPreview {
        changed: formatted != content,
        content: formatted,
        outline,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(title: &str, content: &str) -> String {
        preview(NoteFormatRequest {
            title: title.into(),
            content: content.into(),
        })
        .unwrap()
        .content
    }

    #[test]
    fn is_idempotent_and_keeps_paragraph_lines() {
        let input = "# Note\n\nA line\ncontinues here\n\n##  Methods\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
        let once = format("Note", input);
        let twice = format("Note", &once);
        assert_eq!(once, twice);
        assert!(once.contains("A line\ncontinues here"));
        assert!(once.contains("## Methods"));
    }

    #[test]
    fn code_fences_are_verbatim() {
        let input = "```rust\n##  not a heading\n# also not\n```\n";
        let out = format("Note", input);
        assert!(out.contains("```rust\n##  not a heading\n# also not\n```"));
    }

    #[test]
    fn title_is_the_only_h1_and_duplicates_are_demoted() {
        let input = "# Other\n\nBody\n\n# Note\n\nMore\n";
        let out = format("Note", input);
        assert_eq!(out.lines().filter(|line| line.starts_with("# ")).count(), 1);
        assert!(out.starts_with("# Note\n"));
        assert!(out.contains("## Other"));
        assert!(!out.contains("# Note\n\n# Note"));
    }

    #[test]
    fn indented_code_and_trailing_hashes_are_preserved() {
        let out = format("Note", "    # not a heading\n\n## C#\n\n## Title ##\n");
        assert!(out.contains("    # not a heading"));
        assert!(out.contains("## C#"));
        assert!(out.contains("## Title ##"));
    }

    #[test]
    fn frontmatter_is_preserved() {
        let input = "---\ntags: [a]\n---\n\n# Note\n\nBody\n";
        let out = format("Note", input);
        assert!(out.starts_with("---\ntags: [a]\n---\n\n# Note\n"));
    }

    #[test]
    fn crlf_is_normalized() {
        let out = format("Note", "# Note\r\n\r\nBody\r\n");
        assert!(!out.contains('\r'));
        assert!(out.ends_with("Body\n"));
    }
}
