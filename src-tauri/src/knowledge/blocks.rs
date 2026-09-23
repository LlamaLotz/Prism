use serde::Serialize;
use sha2::{Digest, Sha256};

pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedBlock {
    pub text: String,
    pub kind: String,
    pub heading_path: Vec<String>,
    pub anchor: Option<String>,
    pub start_line: usize,
    pub end_line: usize,
}

/// Structural storage is deliberately separate from token-limited inference chunks.
/// Fences, tables and lists remain intact; there is no block-count cap.
pub fn parse(content: &str) -> Vec<ParsedBlock> {
    let lines: Vec<&str> = content.lines().collect();
    let mut out = Vec::new();
    let mut headings: Vec<String> = vec![];
    let mut i = 0;
    if lines.first() == Some(&"---") {
        if let Some(end) = lines
            .iter()
            .skip(1)
            .position(|l| *l == "---" || *l == "...")
        {
            i = end + 2;
        }
    }
    while i < lines.len() {
        if lines[i].trim().is_empty() {
            i += 1;
            continue;
        }
        let start = i;
        let t = lines[i].trim_start();
        let kind;
        if t.starts_with("```") || t.starts_with("~~~") {
            kind = "code";
            let ch = t.chars().next().unwrap();
            let width = t.chars().take_while(|c| *c == ch).count();
            i += 1;
            while i < lines.len() {
                let s = lines[i].trim();
                i += 1;
                if s.chars().take_while(|c| *c == ch).count() >= width && s.chars().all(|c| c == ch)
                {
                    break;
                }
            }
        } else if t.starts_with("$$") {
            kind = "equation";
            i += 1;
            if t == "$$" {
                while i < lines.len() {
                    let end = lines[i].trim() == "$$";
                    i += 1;
                    if end {
                        break;
                    }
                }
            }
        } else if let Some((level, name)) = heading(t) {
            kind = "heading";
            headings.truncate(level - 1);
            headings.push(name.to_string());
            i += 1;
        } else {
            kind = if t.starts_with('>') {
                "quote"
            } else if list(t) {
                "list"
            } else if i + 1 < lines.len()
                && lines[i + 1].contains('|')
                && lines[i + 1].contains("---")
            {
                "table"
            } else {
                "paragraph"
            };
            i += 1;
            while i < lines.len()
                && !lines[i].trim().is_empty()
                && heading(lines[i].trim_start()).is_none()
                && !lines[i].trim_start().starts_with("```")
                && !lines[i].trim_start().starts_with("~~~")
            {
                i += 1;
            }
        }
        let text = lines[start..i].join("\n");
        let anchor = text
            .split_whitespace()
            .last()
            .filter(|s| {
                s.starts_with('^')
                    && s.len() > 1
                    && s[1..]
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            })
            .map(|s| s[1..].to_string());
        out.push(ParsedBlock {
            text,
            kind: kind.into(),
            heading_path: headings.clone(),
            anchor,
            start_line: start + 1,
            end_line: i,
        });
    }
    out
}
fn heading(s: &str) -> Option<(usize, &str)> {
    let n = s.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&n) && s.as_bytes().get(n) == Some(&b' ') {
        Some((n, s[n + 1..].trim()))
    } else {
        None
    }
}
fn list(s: &str) -> bool {
    s.starts_with("- ")
        || s.starts_with("* ")
        || s.starts_with("+ ")
        || s.split_once(". ")
            .is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structures_and_unlimited_blocks() {
        let b=parse("---\ntitle: hidden\n---\n# Heading\n\n```rust\na\n\nb\n```\n\n| a | b |\n| --- | --- |\n| c | d |\n\nText ^stable");
        assert_eq!(b.len(), 4);
        assert_eq!(b[1].kind, "code");
        assert!(b[1].text.contains("\n\n"));
        assert_eq!(b[2].kind, "table");
        assert_eq!(b[3].anchor.as_deref(), Some("stable"));
        assert_eq!(
            parse(
                &(0..1000)
                    .map(|i| format!("Paragraph {i}\n\n"))
                    .collect::<String>()
            )
            .len(),
            1000
        );
    }
}
