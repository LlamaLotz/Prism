//! Shared, dependency-light interchange model for the desktop and extraction worker.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[path = "knowledge/blocks.rs"]
mod structural;

pub const SCHEMA_VERSION: u32 = 1;
pub const NORMALIZATION_VERSION: u32 = 1;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub page: Option<u32>,
    pub bbox: Option<[f64; 4]>,
    pub slide: Option<u32>,
    pub sheet: Option<String>,
    pub cells: Option<String>,
    pub time_range: Option<[f64; 2]>,
    pub text_range: Option<[usize; 2]>,
    pub url: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlock {
    pub id: String,
    pub kind: String,
    pub markdown: String,
    pub heading_level: Option<u8>,
    pub location: Option<Location>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub locator: String,
    pub content_hash: String,
    pub kind: String,
    pub fingerprint_kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrismDocument {
    pub version: u32,
    pub normalization_version: u32,
    pub id: String,
    pub revision: String,
    pub title: String,
    pub source: Source,
    pub extractor: String,
    pub extractor_version: String,
    pub settings_fingerprint: String,
    pub warnings: Vec<String>,
    pub blocks: Vec<DocumentBlock>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fragment {
    pub markdown: String,
    pub location: Option<Location>,
}
impl PrismDocument {
    pub fn new(
        title: String,
        source: Source,
        extractor: String,
        extractor_version: String,
        settings_fingerprint: String,
        fragments: Vec<Fragment>,
    ) -> Self {
        let id = hash(source.locator.as_bytes());
        let revision = hash(
            serde_json::to_vec(&(
                id.as_str(),
                source.content_hash.as_str(),
                extractor.as_str(),
                extractor_version.as_str(),
                settings_fingerprint.as_str(),
                SCHEMA_VERSION,
                NORMALIZATION_VERSION,
                title.as_str(),
                hash(&serde_json::to_vec(&fragments).unwrap()),
            ))
            .unwrap()
            .as_slice(),
        );
        let mut blocks = vec![];
        let mut warnings = vec![];
        for fragment in fragments {
            let markdown = fragment.markdown.replace("\r\n", "\n");
            let mut parsed = structural::parse(&markdown);
            // Front matter belongs to the source; never silently drop it.
            let lines: Vec<_> = markdown.lines().collect();
            if lines.first() == Some(&"---") {
                if let Some(end) = lines
                    .iter()
                    .enumerate()
                    .skip(1)
                    .find(|(_, line)| **line == "---" || **line == "...")
                    .map(|(i, _)| i)
                {
                    parsed.insert(
                        0,
                        structural::ParsedBlock {
                            text: lines[..=end].join("\n"),
                            kind: "text".into(),
                            heading_path: vec![],
                            anchor: None,
                            start_line: 1,
                            end_line: end + 1,
                        },
                    );
                }
            }
            for block in parsed {
                let level = if block.kind == "heading" {
                    Some(
                        block
                            .text
                            .trim_start()
                            .chars()
                            .take_while(|c| *c == '#')
                            .count() as u8,
                    )
                } else {
                    None
                };
                let kind = if block.text.trim_start().starts_with("![") {
                    "media".into()
                } else {
                    block.kind
                };
                let kind = if [
                    "heading",
                    "paragraph",
                    "list",
                    "table",
                    "code",
                    "quote",
                    "media",
                ]
                .contains(&kind.as_str())
                {
                    kind
                } else {
                    warnings.push(format!("Preserved unsupported {kind} structure as text"));
                    "text".into()
                };
                let mut location = fragment.location.clone();
                if source.kind == "markdown" && location.is_none() {
                    location = Some(Location {
                        text_range: Some([block.start_line, block.end_line]),
                        ..Default::default()
                    });
                }
                blocks.push(DocumentBlock {
                    id: format!("{revision}:{}", blocks.len()),
                    kind,
                    markdown: block.text,
                    heading_level: level,
                    location,
                });
            }
        }
        if blocks.iter().any(|b| b.location.is_none()) {
            warnings.push("Some source locations are unavailable; generated Markdown positions are not original-source locations.".into());
        }
        warnings.sort();
        warnings.dedup();
        Self {
            version: SCHEMA_VERSION,
            normalization_version: NORMALIZATION_VERSION,
            id,
            revision,
            title,
            source,
            extractor,
            extractor_version,
            settings_fingerprint,
            warnings,
            blocks,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.version != SCHEMA_VERSION || self.normalization_version != NORMALIZATION_VERSION {
            return Err("Unsupported document schema or normalization version".into());
        }
        if self.blocks.len() > 100_000
            || self.blocks.iter().map(|b| b.markdown.len()).sum::<usize>() > 64 * 1024 * 1024
        {
            return Err("Document exceeds 64 MiB or 100,000 blocks; divide the source".into());
        }
        let mut ids = std::collections::HashSet::new();
        if self
            .blocks
            .iter()
            .any(|b| !ids.insert(&b.id) || !b.id.starts_with(&format!("{}:", self.revision)))
        {
            return Err("Invalid document block identity".into());
        }
        Ok(())
    }
    pub fn markdown(&self) -> String {
        self.blocks
            .iter()
            .map(|b| b.markdown.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub key: String,
    pub name: String,
    pub markdown: String,
    pub blocks: Vec<String>,
}
pub fn safe_name(value: &str) -> String {
    let mut name = String::new();
    for c in value
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|[]#^".contains(*c))
    {
        if name.len() + c.len_utf8() > 100 {
            break;
        }
        name.push(c);
    }
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        "Untitled".into()
    } else if ["CON", "PRN", "AUX", "NUL"].contains(&name.to_uppercase().as_str())
        || name.to_uppercase().starts_with("COM")
        || name.to_uppercase().starts_with("LPT")
    {
        format!("_{name}")
    } else {
        name.into()
    }
}
pub fn outputs(doc: &PrismDocument, split: Option<u8>, name: &str) -> Result<Vec<Output>, String> {
    outputs_selected(doc, split, name, &[])
}
pub fn outputs_selected(
    doc: &PrismDocument,
    split: Option<u8>,
    name: &str,
    excluded: &[String],
) -> Result<Vec<Output>, String> {
    doc.validate()?;
    if split.is_some_and(|l| !(1..=6).contains(&l)) {
        return Err("Heading level must be 1–6".into());
    }
    let base = safe_name(name);
    let mut out = vec![Output {
        key: "root".into(),
        name: format!("{base}.md"),
        markdown: String::new(),
        blocks: vec![],
    }];
    let mut names = std::collections::HashMap::<String, usize>::new();
    let mut selected = 0;
    for block in &doc.blocks {
        if split.is_some() && block.heading_level == split {
            let heading = block.markdown.trim_start_matches('#').trim();
            let stem = safe_name(heading);
            let occurrence = names.entry(stem.to_lowercase()).or_default();
            *occurrence += 1;
            let suffix = if *occurrence == 1 {
                String::new()
            } else {
                format!(" ({occurrence})")
            };
            let name = format!("{base} - {stem}{suffix}.md");
            out.push(Output {
                key: format!("heading:{}:{}", hash(heading.as_bytes()), occurrence),
                name,
                markdown: String::new(),
                blocks: vec![],
            });
            selected = out.len() - 1;
        } else if split.is_some_and(|level| block.heading_level.is_some_and(|l| l < level)) {
            selected = 0;
        }
        let target = &mut out[selected];
        if !target.markdown.is_empty() {
            target.markdown.push_str("\n\n");
        }
        target.markdown.push_str(&block.markdown);
        target.blocks.push(block.id.clone());
    }
    out.retain(|o| o.key == "root" || !excluded.contains(&o.key));
    if out.len() > 1 {
        out[0].markdown.push_str("\n\n## Sections\n");
        let links = out
            .iter()
            .skip(1)
            .map(|o| format!("- [[{}]]", o.name.trim_end_matches(".md")))
            .collect::<Vec<_>>()
            .join("\n");
        out[0].markdown.push_str(&links);
    }
    if out.len() > 10_000 || out.iter().map(|o| o.markdown.len()).sum::<usize>() > 64 * 1024 * 1024
    {
        return Err("Import exceeds 64 MiB / 10,000 outputs; divide the source".into());
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn document(text: &str) -> PrismDocument {
        PrismDocument::new(
            "Example".into(),
            Source {
                locator: "/x.md".into(),
                content_hash: hash(text.as_bytes()),
                kind: "markdown".into(),
                fingerprint_kind: "bytes".into(),
            },
            "test".into(),
            "1".into(),
            "settings".into(),
            vec![Fragment {
                markdown: text.into(),
                location: None,
            }],
        )
    }
    #[test]
    fn structure_unicode_and_split() {
        let d=document("Intro 日本🦀\n\n## Same\n\n```md\n## not a heading\n```\n\n## Same\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
        d.validate().unwrap();
        let o = outputs(&d, Some(2), "Test").unwrap();
        assert_eq!(o.len(), 3);
        assert_ne!(o[1].name, o[2].name);
        assert!(o[1].markdown.contains("## not a heading"));
        assert!(o[2].markdown.contains("| 1 | 2 |"));
        assert!(d.blocks.iter().all(|b| b.location.is_some()));
    }
    #[test]
    fn frontmatter_delimiters_anchors_and_portable_unicode_names() {
        let d = document("---\ntitle: 日本\n...\n\nText ^anchor\n\n![Figure](source.png)");
        assert!(d.markdown().starts_with("---\ntitle: 日本\n..."));
        assert!(d.markdown().contains("^anchor"));
        assert!(d.blocks.iter().any(|b| b.kind == "media"));
        assert!(safe_name(&"🦀".repeat(100)).len() <= 100);
        let sections = document("Intro\n\n## One\n\nBody\n\n## Two\n\nSecond");
        let all = outputs(&sections, Some(2), "Book").unwrap();
        let selected = outputs_selected(&sections, Some(2), "Book", &[all[1].key.clone()]).unwrap();
        assert_eq!(selected.len(), 2);
        assert!(!selected[0].markdown.contains("Book - One"));
        assert!(selected[0].markdown.contains("Book - Two"));
    }
    #[test]
    fn roundtrip_and_versions() {
        let d = document("---\ntitle: Original\n---\n\n# Heading\n\nText  \nline");
        assert!(d.markdown().starts_with("---\ntitle"));
        let mut copy: PrismDocument =
            serde_json::from_slice(&serde_json::to_vec(&d).unwrap()).unwrap();
        copy.validate().unwrap();
        copy.version = 2;
        assert!(copy.validate().is_err());
    }
}
