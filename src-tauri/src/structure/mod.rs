//! Shared, deterministic document-structure layer.
//!
//! The local model may only propose block boundaries. Everything here is the
//! authority that validates those proposals and renders notes from the
//! original blocks. No model output is ever inserted as note text.

mod format;
mod model;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

const DEFAULT_MAX_BLOCKS: usize = 5_000;
const MAX_BLOCKS: usize = 20_000;
const DEFAULT_TARGET_CHARS: usize = 6_000;
const MIN_TARGET_CHARS: usize = 500;
const MAX_TARGET_CHARS: usize = 50_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureBlock {
    pub id: String,
    pub kind: String,
    pub level: Option<u8>,
    pub text: String,
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    pub id: String,
    pub title: String,
    pub level: u8,
    pub start_block: String,
    pub end_block: String,
    pub children: Vec<OutlineNode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitOption {
    pub mode: String,
    pub level: Option<u8>,
    pub sections: usize,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureInspection {
    pub title: String,
    pub blocks: Vec<StructureBlock>,
    pub outline: Vec<OutlineNode>,
    pub split_options: Vec<SplitOption>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureInspectRequest {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub max_blocks: Option<usize>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitMode {
    Auto,
    Headings,
    Paragraph,
    Topics,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSplitRequest {
    pub title: String,
    pub content: String,
    pub mode: SplitMode,
    #[serde(default)]
    pub level: Option<u8>,
    #[serde(default)]
    pub target_chars: Option<usize>,
    #[serde(default)]
    pub existing_paths: Vec<String>,
    #[serde(default = "default_allow_model")]
    pub allow_model: bool,
}

fn default_allow_model() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionPlan {
    pub title: String,
    pub file_name: String,
    pub content: String,
    pub start_block: String,
    pub end_block: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitStats {
    pub blocks: usize,
    pub sections: usize,
    pub model_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSplitPlan {
    pub mode: String,
    pub level: Option<u8>,
    pub model_used: bool,
    pub parent_content: String,
    pub sections: Vec<SectionPlan>,
    pub warnings: Vec<String>,
    pub stats: SplitStats,
}

struct ParsedNote {
    frontmatter: String,
    blocks: Vec<StructureBlock>,
}

#[derive(Clone, Debug)]
struct OutlineDraft {
    heading_index: usize,
    level: u8,
    title: String,
    start: usize,
    end: usize,
    children: Vec<OutlineDraft>,
}

#[derive(Clone, Debug)]
struct SelectedSection {
    start: usize,
    end: usize,
    title: String,
}

fn frontmatter_end(content: &str) -> Option<usize> {
    let first_end = content.find('\n')?;
    if content[..first_end].trim_end_matches('\r') != "---" {
        return None;
    }
    let mut offset = first_end + 1;
    for segment in content[offset..].split_inclusive('\n') {
        offset += segment.len();
        let line = segment.trim_end_matches(['\r', '\n']);
        if line == "---" || line == "..." {
            return Some(offset);
        }
    }
    None
}

fn heading(line: &str) -> Option<(u8, String)> {
    let t = line.trim_start();
    let count = t.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&count) {
        return None;
    }
    let rest = &t[count..];
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    Some((count as u8, rest.trim().to_string()))
}

fn list_start(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("- ")
        || t.starts_with("* ")
        || t.starts_with("+ ")
        || t.split_once(". ")
            .is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

fn table_start(lines: &[&str], i: usize) -> bool {
    let t = lines[i].trim_start();
    if t.starts_with('|') {
        return true;
    }
    i + 1 < lines.len()
        && lines[i + 1].contains('|')
        && lines[i + 1]
            .chars()
            .all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

fn split_frontmatter(content: &str) -> (String, &str) {
    match frontmatter_end(content) {
        Some(end) if content.is_char_boundary(end) => (content[..end].to_string(), &content[end..]),
        _ => (String::new(), content),
    }
}

fn parse_note(content: &str) -> ParsedNote {
    // Structure and rendered plans are LF-normalized. The source note may be
    // opened with CRLF, but every block the planner emits is canonical Markdown.
    let content = content.replace("\r\n", "\n");
    let (frontmatter, body) = split_frontmatter(&content);
    let base_line = frontmatter.matches('\n').count();
    let lines: Vec<&str> = body.split('\n').collect();
    let mut blocks = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i].trim().is_empty() {
            i += 1;
            continue;
        }
        let start = i;
        let t = lines[i].trim_start();
        let kind: &str;
        let mut level = None;
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
        } else if let Some((n, _)) = heading(&lines[i]) {
            kind = "heading";
            level = Some(n);
            i += 1;
        } else if t.starts_with("![") {
            kind = "media";
            i += 1;
        } else if t.starts_with('>') {
            kind = "quote";
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
        } else if list_start(&lines[i]) {
            kind = "list";
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() {
                let s = lines[i].trim_start();
                if heading(&lines[i]).is_some()
                    || s.starts_with("```")
                    || s.starts_with("~~~")
                    || table_start(&lines, i)
                {
                    break;
                }
                i += 1;
            }
        } else if table_start(&lines, i) {
            kind = "table";
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() {
                if !lines[i].trim_start().starts_with('|') {
                    break;
                }
                i += 1;
            }
        } else {
            kind = "paragraph";
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() {
                let s = lines[i].trim_start();
                if heading(&lines[i]).is_some()
                    || s.starts_with("```")
                    || s.starts_with("~~~")
                    || list_start(&lines[i])
                    || table_start(&lines, i)
                    || s.starts_with('>')
                {
                    break;
                }
                i += 1;
            }
        }
        let text = lines[start..i].join("\n");
        let end_line = base_line + i;
        blocks.push(StructureBlock {
            id: format!("b{}", blocks.len()),
            kind: kind.into(),
            level,
            text,
            start_line: base_line + start + 1,
            end_line,
        });
    }
    ParsedNote {
        frontmatter,
        blocks,
    }
}

fn heading_blocks(blocks: &[StructureBlock]) -> Vec<usize> {
    blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| b.level.map(|_| i))
        .collect()
}

fn build_outline_drafts(
    blocks: &[StructureBlock],
    headings: &[usize],
    parent_level: u8,
) -> Vec<OutlineDraft> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < headings.len() {
        let idx = headings[i];
        let level = blocks[idx].level.unwrap_or(1);
        if level <= parent_level {
            break;
        }
        let mut j = i + 1;
        while j < headings.len() {
            let next = blocks[headings[j]].level.unwrap_or(1);
            if next <= level {
                break;
            }
            j += 1;
        }
        let end = if j < headings.len() {
            headings[j].saturating_sub(1)
        } else {
            blocks.len().saturating_sub(1)
        };
        let children = build_outline_drafts(blocks, &headings[i + 1..j], level);
        out.push(OutlineDraft {
            heading_index: idx,
            level,
            title: heading_text(&blocks[idx].text),
            start: idx,
            end,
            children,
        });
        i = j;
    }
    out
}

fn to_outline(blocks: &[StructureBlock], drafts: &[OutlineDraft]) -> Vec<OutlineNode> {
    drafts
        .iter()
        .map(|d| OutlineNode {
            id: blocks[d.heading_index].id.clone(),
            title: d.title.clone(),
            level: d.level,
            start_block: blocks[d.start].id.clone(),
            end_block: blocks[d.end].id.clone(),
            children: to_outline(blocks, &d.children),
        })
        .collect()
}

fn heading_text(text: &str) -> String {
    text.trim()
        .trim_start_matches('#')
        .trim()
        .trim_end_matches('#')
        .trim()
        .to_string()
}

pub(super) fn timestamp_heading(block: &StructureBlock) -> bool {
    if block.level.is_some() {
        return false;
    }
    let first = block.text.lines().next().unwrap_or("").trim();
    first.len() >= 5
        && first.as_bytes().get(2) == Some(&b':')
        && first[..2].chars().all(|c| c.is_ascii_digit())
}

/// A conservative, deterministic signal used only to tell the local model
/// which plain-text blocks look like section titles. It never rewrites a note.
pub(super) fn candidate_heading(block: &StructureBlock) -> bool {
    if block.level.is_some() {
        return true;
    }
    let first = block.text.lines().next().unwrap_or("").trim();
    if first.is_empty() || first.contains("http://") || first.contains("https://") {
        return false;
    }
    if first.starts_with(['#', '-', '*', '+', '|', '>', '[']) {
        return false;
    }
    // Transcript timestamps are legitimate section starts.
    if timestamp_heading(block) {
        return true;
    }
    let words: Vec<&str> = first.split_whitespace().collect();
    if words.is_empty() || words.len() > 10 || first.chars().count() > 90 {
        return false;
    }
    if first
        .chars()
        .all(|c| c.is_ascii_digit() || c.is_whitespace() || c == '.' || c == '-')
    {
        return false;
    }
    if first.to_ascii_lowercase().starts_with("page ") {
        return false;
    }
    if first.ends_with(['.', '!', '?']) {
        return false;
    }
    let alpha = first.chars().filter(|c| c.is_alphabetic()).count();
    if alpha == 0 {
        return false;
    }
    let uppercase = first.chars().filter(|c| c.is_uppercase()).count();
    if uppercase == alpha && words.len() >= 2 {
        return true;
    }
    let title_words = words
        .iter()
        .filter(|word| word.chars().next().is_some_and(|c| c.is_uppercase()))
        .count();
    if title_words * 2 < words.len() {
        return false;
    }
    words.len() >= 2 || (words.len() == 1 && words[0].chars().count() >= 4)
}

fn section_chars(blocks: &[StructureBlock], section: &SelectedSection) -> usize {
    blocks[section.start..=section.end]
        .iter()
        .map(|block| block.text.chars().count())
        .sum()
}

/// Model starts can be finer than topic sections. Merge only tiny adjacent
/// sections that do not start at a heading-like block; candidate headings and
/// existing headings remain hard boundaries.
fn coalesce_model_sections(
    blocks: &[StructureBlock],
    sections: Vec<SelectedSection>,
) -> Vec<SelectedSection> {
    if sections.len() < 3 {
        return sections;
    }
    let total: usize = blocks.iter().map(|block| block.text.chars().count()).sum();
    let minimum = (total / 6).clamp(220, 800);
    let original = sections.clone();
    let mut out: Vec<SelectedSection> = Vec::with_capacity(sections.len());
    for section in sections {
        let can_merge = out.last().is_some_and(|previous| {
            previous.end + 1 == section.start
                && !(candidate_heading(&blocks[section.start])
                    && !timestamp_heading(&blocks[section.start]))
                && section_chars(blocks, previous) < minimum
        });
        if let Some(previous) = out.last_mut().filter(|_| can_merge) {
            previous.end = section.end;
        } else {
            out.push(section);
        }
    }
    if out.len() < 2 {
        original
    } else {
        out
    }
}

fn count_levels(blocks: &[StructureBlock]) -> [usize; 7] {
    let mut counts = [0usize; 7];
    for block in blocks {
        if let Some(level) = block.level {
            if (1..=6).contains(&level) {
                counts[level as usize] += 1;
            }
        }
    }
    counts
}

fn paragraph_chunks(blocks: &[StructureBlock], target: usize) -> Vec<(usize, usize)> {
    if blocks.is_empty() {
        return Vec::new();
    }
    let target = target.clamp(MIN_TARGET_CHARS, MAX_TARGET_CHARS);
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut chars = 0usize;
    for i in 0..blocks.len() {
        let len = blocks[i].text.chars().count();
        if i > start && chars + len > target {
            out.push((start, i - 1));
            start = i;
            chars = 0;
        }
        chars += len + 2;
    }
    out.push((start, blocks.len() - 1));
    if out.len() == 1 && blocks.len() > 1 {
        let mid = blocks.len() / 2;
        out = vec![(0, mid - 1), (mid, blocks.len() - 1)];
    }
    out
}

pub fn inspect(
    content: &str,
    title: &str,
    max_blocks: Option<usize>,
) -> Result<StructureInspection, String> {
    let parsed = parse_note(content);
    let limit = max_blocks
        .unwrap_or(DEFAULT_MAX_BLOCKS)
        .clamp(1, MAX_BLOCKS);
    if parsed.blocks.len() > limit {
        return Err(format!(
            "LIMIT: structure inspection found {} blocks (limit {limit})",
            parsed.blocks.len()
        ));
    }
    let headings = heading_blocks(&parsed.blocks);
    let outline = to_outline(
        &parsed.blocks,
        &build_outline_drafts(&parsed.blocks, &headings, 0),
    );
    let counts = count_levels(&parsed.blocks);
    let mut split_options = Vec::new();
    for level in 1u8..=6 {
        let count = counts[level as usize];
        if count > 0 {
            split_options.push(SplitOption {
                mode: "headings".into(),
                level: Some(level),
                sections: count,
                label: format!("Heading {level} · {count} section{}", plural(count)),
            });
        }
    }
    let chunks = paragraph_chunks(&parsed.blocks, DEFAULT_TARGET_CHARS).len();
    if chunks > 0 {
        split_options.push(SplitOption {
            mode: "paragraph".into(),
            level: None,
            sections: chunks,
            label: format!("Paragraph chunks · {chunks} section{}", plural(chunks)),
        });
    }
    split_options.push(SplitOption {
        mode: "topics".into(),
        level: None,
        sections: 0,
        label: "Topics · local model".into(),
    });
    let mut warnings = Vec::new();
    if headings.is_empty() {
        warnings.push("No headings found; topic analysis or paragraph chunks are required.".into());
    } else if choose_auto_level(&parsed.blocks).is_none() {
        warnings.push(
            "Fewer than two usable section headings; the document cannot be split by heading."
                .into(),
        );
    }
    if counts[1] > 1 {
        warnings.push("Multiple H1 headings found; the note title should be the only H1.".into());
    }
    if parsed.blocks.is_empty() {
        warnings.push("The note has no content blocks.".into());
    }
    Ok(StructureInspection {
        title: title.to_string(),
        blocks: parsed.blocks,
        outline,
        split_options,
        warnings,
    })
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

fn choose_auto_level(blocks: &[StructureBlock]) -> Option<u8> {
    let counts = count_levels(blocks);
    for level in 2u8..=6 {
        if counts[level as usize] >= 2 {
            return Some(level);
        }
    }
    if counts[1] >= 2 {
        return Some(1);
    }
    None
}

fn select_headings(blocks: &[StructureBlock], level: u8) -> Vec<SelectedSection> {
    let headings = heading_blocks(blocks);
    let mut selected = Vec::new();
    for (pos, &idx) in headings.iter().enumerate() {
        if blocks[idx].level != Some(level) {
            continue;
        }
        let mut next = blocks.len();
        for &later in headings.iter().skip(pos + 1) {
            if blocks[later].level.is_some_and(|l| l <= level) {
                next = later;
                break;
            }
        }
        let title = heading_text(&blocks[idx].text);
        selected.push(SelectedSection {
            start: idx,
            end: next.saturating_sub(1),
            title: if title.is_empty() {
                format!("Section {}", selected.len() + 1)
            } else {
                title
            },
        });
    }
    selected
}

fn selected_from_chunks(
    blocks: &[StructureBlock],
    chunks: Vec<(usize, usize)>,
) -> Vec<SelectedSection> {
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, (start, end))| {
            let title = block_title(blocks.get(start), i + 1);
            SelectedSection { start, end, title }
        })
        .collect()
}

fn block_title(block: Option<&StructureBlock>, index: usize) -> String {
    let Some(block) = block else {
        return format!("Section {index}");
    };
    if block.level.is_some() {
        let text = heading_text(&block.text);
        if !text.is_empty() {
            return truncate_title(&text);
        }
    }
    let first = block
        .text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let cleaned = first.trim_start_matches('-').trim();
    if cleaned.is_empty() {
        format!("Section {index}")
    } else {
        truncate_title(cleaned)
    }
}

fn truncate_title(value: &str) -> String {
    let mut text = value.replace(['\n', '\r'], " ");
    text = text.replace(['[', ']', '|', '#', '^'], " ");
    text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text = text.trim_matches(['*', '_', '`', ' ']).to_string();
    if text.chars().count() > 80 {
        text = text.chars().take(77).collect::<String>() + "…";
    }
    if text.is_empty() {
        "Section".into()
    } else {
        text
    }
}

fn sanitize_file_name(title: &str) -> String {
    let mut cleaned: String = title
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '[' | ']' | '#' | '^'
            )
        })
        .filter(|c| !c.is_control())
        .collect();
    cleaned = cleaned.trim_matches([' ', '.']).to_string();
    if cleaned.chars().count() > 200 {
        cleaned = cleaned.chars().take(200).collect();
        if let Some(space) = cleaned.rfind(' ') {
            cleaned.truncate(space);
        }
        cleaned = cleaned.trim_matches([' ', '.']).to_string();
    }
    if cleaned.is_empty() {
        "Section".into()
    } else {
        cleaned
    }
}

fn existing_names(paths: &[String]) -> HashSet<String> {
    paths
        .iter()
        .filter_map(|p| Path::new(p).file_name())
        .map(|n| n.to_string_lossy().to_lowercase())
        .collect()
}

fn unique_file_name(title: &str, used: &mut HashSet<String>, existing: &HashSet<String>) -> String {
    let base = sanitize_file_name(title);
    let mut candidate = base.clone();
    let mut n = 2;
    while used.contains(&candidate.to_lowercase())
        || existing.contains(&format!("{}.md", candidate.to_lowercase()))
    {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    used.insert(candidate.to_lowercase());
    candidate
}

fn render_plan(
    parsed: &ParsedNote,
    title: &str,
    sections: Vec<SelectedSection>,
    existing_paths: &[String],
) -> Result<NoteSplitPlan, String> {
    if sections.len() < 2 {
        return Err("INVALID_INPUT: need at least two sections to split".into());
    }
    if sections.iter().any(|s| s.end < s.start) {
        return Err("INVALID_INPUT: invalid section range".into());
    }
    let mut used = HashSet::new();
    let existing = existing_names(existing_paths);
    let mut rendered = Vec::with_capacity(sections.len());
    let parent_title = if title.trim().is_empty() {
        "Note".to_string()
    } else {
        truncate_title(title)
    };
    for (i, section) in sections.iter().enumerate() {
        let file_name = unique_file_name(&section.title, &mut used, &existing);
        let mut body_parts = Vec::new();
        for block in &parsed.blocks[section.start..=section.end] {
            // The boundary heading becomes the H1 of the new note. Keeping it
            // here would duplicate the title and break heading-level contracts.
            if body_parts.is_empty() && block.level.is_some() {
                continue;
            }
            body_parts.push(block.text.clone());
        }
        let body = body_parts.join("\n\n");
        let content = if body.trim().is_empty() {
            format!(
                "# {}\n\n> Part of [[{}]] · Section {} of {}\n\n[[{}]]\n",
                section.title,
                parent_title,
                i + 1,
                sections.len(),
                parent_title
            )
        } else {
            format!(
                "# {}\n\n> Part of [[{}]] · Section {} of {}\n\n{}\n\n[[{}]]\n",
                section.title,
                parent_title,
                i + 1,
                sections.len(),
                body.trim_end(),
                parent_title
            )
        };
        rendered.push(SectionPlan {
            title: section.title.clone(),
            file_name,
            content,
            start_block: parsed.blocks[section.start].id.clone(),
            end_block: parsed.blocks[section.end].id.clone(),
        });
    }
    let first_start = sections
        .first()
        .map(|s| s.start)
        .unwrap_or(parsed.blocks.len());
    let intro = if first_start > 0 {
        parsed.blocks[..first_start]
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    } else {
        String::new()
    };
    let links = rendered
        .iter()
        .map(|s| format!("- [[{}]]", s.title))
        .collect::<Vec<_>>()
        .join("\n");
    let parent_body = [intro.trim_end().to_string(), "## Sections".into(), links]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let parent_content = format!("{}{}\n", parsed.frontmatter, parent_body);
    Ok(NoteSplitPlan {
        mode: "headings".into(),
        level: None,
        model_used: false,
        parent_content,
        sections: rendered,
        warnings: Vec::new(),
        stats: SplitStats {
            blocks: parsed.blocks.len(),
            sections: sections.len(),
            model_ms: 0,
        },
    })
}

fn deterministic_sections(
    blocks: &[StructureBlock],
    mode: SplitMode,
    level: Option<u8>,
    target: usize,
) -> Result<(SplitMode, Option<u8>, Vec<SelectedSection>), String> {
    match mode {
        SplitMode::Headings => {
            let level = level.ok_or("INVALID_INPUT: headings mode requires level")?;
            if !(1..=6).contains(&level) {
                return Err("INVALID_INPUT: heading level must be 1–6".into());
            }
            let sections = select_headings(blocks, level);
            if sections.len() < 2 {
                return Err(format!(
                    "INVALID_INPUT: found {} H{level} sections; need at least two",
                    sections.len()
                ));
            }
            Ok((SplitMode::Headings, Some(level), sections))
        }
        SplitMode::Auto => {
            if let Some(level) = choose_auto_level(blocks) {
                let sections = select_headings(blocks, level);
                if sections.len() >= 2 {
                    return Ok((SplitMode::Auto, Some(level), sections));
                }
            }
            let chunks = paragraph_chunks(blocks, target);
            if chunks.len() < 2 {
                return Err("INVALID_INPUT: not enough content blocks to split".into());
            }
            Ok((
                SplitMode::Paragraph,
                None,
                selected_from_chunks(blocks, chunks),
            ))
        }
        SplitMode::Paragraph => {
            let chunks = paragraph_chunks(blocks, target);
            if chunks.len() < 2 {
                return Err("INVALID_INPUT: not enough content blocks to split".into());
            }
            Ok((
                SplitMode::Paragraph,
                None,
                selected_from_chunks(blocks, chunks),
            ))
        }
        SplitMode::Topics => Err("INTERNAL: topics handled by the model path".into()),
    }
}

fn model_sections(
    blocks: &[StructureBlock],
    proposed: Vec<model::ModelSection>,
    title: &str,
) -> Result<Vec<SelectedSection>, String> {
    if proposed.is_empty() {
        return Err("INVALID_OUTPUT: model returned no sections".into());
    }
    let by_id: std::collections::HashMap<&str, usize> = blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (b.id.as_str(), i))
        .collect();
    // The model returns starts only. Normalize ordering and duplicates here;
    // coverage becomes structural because ends are derived from the next start.
    let mut starts: std::collections::BTreeMap<usize, (u8, String)> =
        std::collections::BTreeMap::new();
    starts.insert(0, (2, String::new()));
    for section in proposed {
        let start = *by_id
            .get(section.start_block.as_str())
            .ok_or("INVALID_OUTPUT: unknown start block")?;
        if !(2..=4).contains(&section.level) {
            return Err("INVALID_OUTPUT: model heading levels must be 2–4".into());
        }
        starts
            .entry(start)
            .and_modify(|entry| {
                if entry.1.trim().is_empty() {
                    entry.1 = section.heading.clone();
                }
            })
            .or_insert((section.level, section.heading));
    }
    // A leading document title belongs in the parent, not in its own section.
    // Only drop it when it clearly matches the requested note title so a real
    // first chapter ("CHAPTER ONE") is never discarded.
    let title_key = title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let first_key = blocks[0]
        .text
        .lines()
        .next()
        .unwrap_or("")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if starts.len() > 2
        && starts.contains_key(&0)
        && !title_key.is_empty()
        && (first_key == title_key
            || first_key.contains(&title_key)
            || title_key.contains(&first_key))
    {
        starts.remove(&0);
    }
    if starts.len() < 2 {
        return Err("INVALID_OUTPUT: model returned fewer than two sections".into());
    }
    let keys = starts.keys().copied().collect::<Vec<_>>();
    let mut sections = Vec::with_capacity(keys.len());
    for (i, &start) in keys.iter().enumerate() {
        let end = keys
            .get(i + 1)
            .map(|next| next.saturating_sub(1))
            .unwrap_or(blocks.len().saturating_sub(1));
        let (_, heading) = starts.get(&start).cloned().unwrap_or((2, String::new()));
        let text = blocks[start..=end]
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let title = choose_heading(&heading, &text, i + 1);
        sections.push(SelectedSection { start, end, title });
    }
    Ok(coalesce_model_sections(blocks, sections))
}

fn choose_heading(model_heading: &str, section_text: &str, index: usize) -> String {
    let candidate = truncate_title(model_heading);
    let normalized = candidate
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase();
    let haystack = section_text.to_lowercase();
    if !normalized.is_empty() && haystack.contains(&normalized) {
        return candidate;
    }
    // Do not let a small model invent a topic label. Fall back to an extractive
    // heading from the section itself.
    let first = section_text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("");
    if first.is_empty() {
        format!("Section {index}")
    } else {
        truncate_title(first)
    }
}

#[tauri::command]
pub fn get_structure_model_status(
    app: tauri::AppHandle,
) -> Result<model::StructureModelStatus, String> {
    model::status(&app)
}

#[tauri::command]
pub fn preview_note_format(
    request: format::NoteFormatRequest,
) -> Result<format::NoteFormatPreview, String> {
    format::preview(request)
}

#[tauri::command]
pub fn inspect_note_structure(
    request: StructureInspectRequest,
) -> Result<StructureInspection, String> {
    inspect(&request.content, &request.title, request.max_blocks)
}

#[tauri::command]
pub async fn plan_note_split(
    app: tauri::AppHandle,
    request: NoteSplitRequest,
) -> Result<NoteSplitPlan, String> {
    let parsed = parse_note(&request.content);
    if parsed.blocks.is_empty() {
        return Err("INVALID_INPUT: the note has no content".into());
    }
    let target = request
        .target_chars
        .unwrap_or(DEFAULT_TARGET_CHARS)
        .clamp(MIN_TARGET_CHARS, MAX_TARGET_CHARS);
    let mut warnings = Vec::new();
    let mut model_used = false;
    let mut model_ms = 0u64;

    let (effective_mode, level, sections) = if request.mode == SplitMode::Topics {
        // Headings are facts from the source. The model is reserved for
        // documents that do not already have a usable outline.
        if let Some(level) = choose_auto_level(&parsed.blocks) {
            let sections = select_headings(&parsed.blocks, level);
            if sections.len() >= 2 {
                warnings.push(
                    "Usable headings found; using the deterministic heading split instead of the local model."
                        .into(),
                );
                (SplitMode::Topics, Some(level), sections)
            } else {
                warnings.push(
                    "Local structure model is disabled; using deterministic auto split.".into(),
                );
                deterministic_sections(&parsed.blocks, SplitMode::Auto, None, target)?
            }
        } else if !request.allow_model {
            warnings
                .push("Local structure model is disabled; using deterministic auto split.".into());
            deterministic_sections(&parsed.blocks, SplitMode::Auto, None, target)?
        } else {
            let title = request.title.clone();
            let blocks = parsed.blocks.clone();
            let analysis =
                tauri::async_runtime::spawn_blocking(move || model::analyze(&app, &title, &blocks))
                    .await
                    .map_err(|e| format!("INTERNAL: model worker failed: {e}"))?;
            match analysis {
                Ok(result) => {
                    model_ms = result.elapsed_ms;
                    match model_sections(&parsed.blocks, result.sections, &request.title) {
                        Ok(sections) => {
                            model_used = true;
                            warnings.push(
                                "Local model proposed section boundaries; review the preview before applying."
                                    .into(),
                            );
                            (SplitMode::Topics, Some(2), sections)
                        }
                        Err(error) => {
                            warnings.push(format!(
                                "Local model returned an unusable structure ({error}); using deterministic auto split."
                            ));
                            deterministic_sections(&parsed.blocks, SplitMode::Auto, None, target)?
                        }
                    }
                }
                Err(error) => {
                    warnings.push(format!(
                        "Local structure model unavailable or failed ({error}); using deterministic auto split."
                    ));
                    deterministic_sections(&parsed.blocks, SplitMode::Auto, None, target)?
                }
            }
        }
    } else {
        deterministic_sections(&parsed.blocks, request.mode, request.level, target)?
    };

    let mut plan = render_plan(&parsed, &request.title, sections, &request.existing_paths)?;
    plan.mode = match effective_mode {
        SplitMode::Auto => "auto",
        SplitMode::Headings => "headings",
        SplitMode::Paragraph => "paragraph",
        SplitMode::Topics => "topics",
    }
    .into();
    plan.level = level;
    plan.model_used = model_used;
    plan.warnings = warnings;
    plan.stats.model_ms = model_ms;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_headings() {
        let parsed = parse_note(
            "---\ntitle: Test\n---\n\n# Test\n\nIntro\n\n## One\n\nBody\n\n## Two\n\nMore",
        );
        assert_eq!(parsed.frontmatter, "---\ntitle: Test\n---\n");
        assert_eq!(parsed.blocks.len(), 6);
        assert_eq!(parsed.blocks[0].kind, "heading");
        assert_eq!(parsed.blocks[0].level, Some(1));
        assert_eq!(parsed.blocks[1].kind, "paragraph");
        assert_eq!(parsed.blocks[2].level, Some(2));
    }

    #[test]
    fn outline_handles_level_jumps() {
        let parsed = parse_note("# Book\n\nIntro\n\n### Deep\n\nBody\n\n## Sibling\n\nMore");
        let headings = heading_blocks(&parsed.blocks);
        let outline = to_outline(
            &parsed.blocks,
            &build_outline_drafts(&parsed.blocks, &headings, 0),
        );
        assert_eq!(outline.len(), 1);
        assert_eq!(outline[0].children.len(), 2);
        assert_eq!(outline[0].children[0].level, 3);
        assert_eq!(outline[0].children[1].level, 2);
    }

    #[test]
    fn split_preserves_blocks_and_is_deterministic() {
        let content = "# Note\n\nIntro\n\n## One\n\nAlpha\n\n## Two\n\nBeta\n";
        let parsed = parse_note(content);
        let sections = select_headings(&parsed.blocks, 2);
        let plan = render_plan(&parsed, "Note", sections, &[]).unwrap();
        assert_eq!(plan.sections.len(), 2);
        assert!(plan.sections[0].content.contains("Alpha"));
        assert!(plan.sections[0]
            .content
            .starts_with("# One\n\n> Part of [[Note]]"));
        assert!(plan.parent_content.contains("- [[One]]"));
        assert!(plan.parent_content.contains("- [[Two]]"));
    }

    #[test]
    fn model_starts_are_derived_into_complete_sections() {
        let parsed = parse_note("Alpha text.\n\nBeta text.\n\nGamma text.\n\nDelta text.");
        let proposed = vec![
            model::ModelSection {
                start_block: "b1".into(),
                level: 2,
                heading: "Beta".into(),
            },
            model::ModelSection {
                start_block: "b3".into(),
                level: 3,
                heading: "Delta".into(),
            },
        ];
        let sections = model_sections(&parsed.blocks, proposed, "Document").unwrap();
        assert_eq!(sections.len(), 3);
        assert_eq!(sections[0].start, 0);
        assert_eq!(sections[0].end, 0);
        assert_eq!(sections[1].start, 1);
        assert_eq!(sections[1].end, 2);
        assert_eq!(sections[2].start, 3);
        assert_eq!(sections[2].end, 3);
    }

    #[test]
    fn candidate_headings_are_conservative() {
        let parsed = parse_note("PLANT PHYSIOLOGY\n\nPage 4\n\n12\n\nA sentence with a full stop.\n\nExecutive Summary\n\n00:00 Welcome back.");
        assert!(candidate_heading(&parsed.blocks[0]));
        assert!(!candidate_heading(&parsed.blocks[1]));
        assert!(!candidate_heading(&parsed.blocks[2]));
        assert!(!candidate_heading(&parsed.blocks[3]));
        assert!(candidate_heading(&parsed.blocks[4]));
        assert!(candidate_heading(&parsed.blocks[5]));
    }

    #[test]
    fn coalescing_merges_tiny_non_heading_sections() {
        let parsed = parse_note("PLANT PHYSIOLOGY\n\nPhotosynthesis converts light energy into chemical energy inside chloroplasts, and the light reactions split water while releasing oxygen as a by-product.\n\nThe Calvin cycle uses ATP and NADPH to fix carbon dioxide, and rubisco catalyzes the first stable carbon fixation step in most terrestrial plants.\n\nWater moves through the xylem under tension, and transpiration pulls the water column from roots to leaves while cohesion keeps the column intact.\n\nRoot pressure can push water upward when transpiration is low, and aquaporins regulate water movement across cell membranes in the root.\n\nGrowth begins with cell division in meristems, and hormones coordinate division, elongation, and differentiation across the plant body.\n\nEnvironmental signals shape growth, and resource allocation shifts toward roots when nutrients are scarce in the soil.");
        let chunks = selected_from_chunks(
            &parsed.blocks,
            parsed
                .blocks
                .iter()
                .enumerate()
                .map(|(i, _)| (i, i))
                .collect(),
        );
        let merged = coalesce_model_sections(&parsed.blocks, chunks);
        assert!(merged.len() < parsed.blocks.len());
        assert!(merged.len() >= 2);
    }

    #[test]
    fn auto_prefers_h2_over_h1() {
        let parsed = parse_note("# Note\n\nIntro\n\n## One\n\nA\n\n## Two\n\nB");
        assert_eq!(choose_auto_level(&parsed.blocks), Some(2));
    }

    #[test]
    fn paragraph_chunks_never_leave_one_section() {
        let parsed = parse_note("alpha\n\nbeta\n\ngamma\n\ndelta");
        let chunks = paragraph_chunks(&parsed.blocks, 1);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], (0, 1));
        assert_eq!(chunks[1], (2, 3));
    }

    #[test]
    fn crlf_frontmatter_offsets_are_safe() {
        let parsed = parse_note("---\r\ntitle: Test\r\n---\r\n\r\n# Test\r\n\r\nBody");
        assert_eq!(parsed.frontmatter, "---\ntitle: Test\n---\n");
        assert_eq!(parsed.blocks[0].text, "# Test");
        assert_eq!(parsed.blocks[0].start_line, 5);
    }

    #[test]
    fn inspection_reports_heading_and_paragraph_options() {
        let value = inspect(
            "# Note\n\nIntro\n\n## One\n\nA\n\n## Two\n\nB",
            "Note",
            None,
        )
        .unwrap();
        assert_eq!(value.outline.len(), 1);
        assert_eq!(value.outline[0].children.len(), 2);
        assert!(value
            .split_options
            .iter()
            .any(|o| o.mode == "headings" && o.level == Some(2)));
        assert!(value.split_options.iter().any(|o| o.mode == "paragraph"));
        assert!(value.warnings.is_empty());
    }

    #[test]
    fn topics_without_model_is_not_handled_deterministically() {
        let parsed = parse_note("# Note\n\nA\n\nB");
        assert!(deterministic_sections(&parsed.blocks, SplitMode::Topics, None, 6000).is_err());
    }

    #[test]
    fn titles_are_link_safe() {
        assert_eq!(
            truncate_title("A [bracketed] #heading | title"),
            "A bracketed heading title"
        );
        assert_eq!(
            sanitize_file_name("A [bracketed] #heading ^id"),
            "A bracketed heading id"
        );
    }

    #[test]
    fn file_names_are_deduplicated() {
        let mut used = HashSet::new();
        let existing = HashSet::from(["one.md".to_string()]);
        assert_eq!(unique_file_name("One", &mut used, &existing), "One-2");
        assert_eq!(unique_file_name("One", &mut used, &existing), "One-3");
    }
}
