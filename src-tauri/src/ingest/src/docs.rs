use crate::{Error, Result};
use std::{io::Read, path::Path};
const CAP: u64 = 256 * 1024 * 1024;
fn xml(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String> {
    let entry = zip.by_name(name).map_err(|e| Error::new("extract", e))?;
    if entry.size() > CAP {
        return Err(Error::new(
            "unsupported",
            "Office XML exceeds buffer budget",
        ));
    }
    let mut text = String::new();
    entry.take(CAP + 1).read_to_string(&mut text)?;
    if text.len() as u64 > CAP {
        return Err(Error::new("unsupported", "XML exceeds buffer budget"));
    }
    Ok(text)
}
fn text(node: roxmltree::Node) -> String {
    node.descendants()
        .filter(|n| n.is_element())
        .filter_map(|n| match n.tag_name().name() {
            "t" => n.text(),
            "tab" => Some("\t"),
            "br" => Some("\n"),
            _ => None,
        })
        .collect::<String>()
}
fn table(node: roxmltree::Node) -> String {
    let rows = node
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "tr")
        .map(|row| {
            row.children()
                .filter(|n| n.is_element() && n.tag_name().name() == "tc")
                .map(|c| text(c).replace('|', "\\|").replace('\n', " "))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    markdown_table(&rows)
}
fn markdown_table(rows: &[Vec<String>]) -> String {
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        out.push_str(&format!(
            "| {} |\n",
            (0..width)
                .map(|c| row.get(c).cloned().unwrap_or_default().replace('|', "\\|"))
                .collect::<Vec<_>>()
                .join(" | ")
        ));
        if i == 0 {
            out.push_str(&format!("| {} |\n", vec!["---"; width].join(" | ")));
        }
    }
    out
}
pub fn extract(path: &Path) -> Result<String> {
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if matches!(ext.as_str(), "html" | "htm" | "txt" | "md") {
        if path.metadata()?.len() > CAP {
            return Err(Error::new("unsupported", "Text exceeds buffer budget"));
        }
        let s = std::fs::read_to_string(path)?;
        return Ok(if ext == "html" || ext == "htm" {
            crate::web::markdown(&s)
        } else {
            s
        });
    }
    // Bound expanded package data before parsers allocate workbook/XML structures.
    {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)
            .map_err(|e| Error::new("extract", e))?;
        let mut expanded = 0u64;
        for i in 0..archive.len() {
            expanded = expanded.saturating_add(
                archive
                    .by_index(i)
                    .map_err(|e| Error::new("extract", e))?
                    .size(),
            );
            if expanded > CAP {
                return Err(Error::new(
                    "unsupported",
                    "Expanded Office package exceeds buffer budget",
                ));
            }
        }
    }
    if ext == "xlsx" {
        use calamine::Reader;
        if path.metadata()?.len() > CAP {
            return Err(Error::new("unsupported", "Workbook exceeds buffer budget"));
        }
        let mut book: calamine::Xlsx<_> = calamine::open_workbook(path)
            .map_err(|e: calamine::XlsxError| Error::new("extract", e))?;
        let mut out = String::new();
        for name in book.sheet_names().to_vec() {
            let range = book
                .worksheet_range(&name)
                .map_err(|e| Error::new("extract", e))?;
            out.push_str(&format!(
                "## {name}\n\n{}\n",
                markdown_table(
                    &range
                        .rows()
                        .map(|r| r.iter().map(ToString::to_string).collect())
                        .collect::<Vec<_>>()
                )
            ));
        }
        return Ok(out);
    }
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(path)?).map_err(|e| Error::new("extract", e))?;
    if ext == "docx" {
        let s = xml(&mut zip, "word/document.xml")?;
        let tree = roxmltree::Document::parse(&s).map_err(|e| Error::new("extract", e))?;
        if tree.descendants().any(|n| {
            n.is_element()
                && [
                    "drawing",
                    "object",
                    "altChunk",
                    "footnoteReference",
                    "endnoteReference",
                    "numPr",
                ]
                .contains(&n.tag_name().name())
        }) {
            return Err(Error::new(
                "quality",
                "Document requires layout/list/embedded-content conversion",
            ));
        }
        let body = tree
            .descendants()
            .find(|n| {
                n.has_tag_name((
                    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                    "body",
                ))
            })
            .ok_or_else(|| Error::new("extract", "Missing document body"))?;
        let mut out = String::new();
        for node in body.children().filter(|n| n.is_element()) {
            match node.tag_name().name() {
                "p" => {
                    let style = node
                        .descendants()
                        .find(|n| n.is_element() && n.tag_name().name() == "pStyle")
                        .and_then(|n| {
                            n.attributes()
                                .find(|a| a.name() == "val")
                                .map(|a| a.value())
                        })
                        .unwrap_or("");
                    let level = style
                        .to_lowercase()
                        .strip_prefix("heading")
                        .and_then(|s| s.parse::<usize>().ok())
                        .filter(|n| (1..=6).contains(n));
                    if let Some(n) = level {
                        out.push_str(&format!("{} ", "#".repeat(n)));
                    }
                    out.push_str(&text(node));
                    out.push_str("\n\n");
                }
                "tbl" => {
                    out.push_str(&table(node));
                    out.push('\n');
                }
                _ => {}
            }
        }
        return Ok(out);
    }
    // The presentation relationship list, not ZIP order or numeric slide names, defines slide order.
    let presentation = xml(&mut zip, "ppt/presentation.xml")?;
    let relations = xml(&mut zip, "ppt/_rels/presentation.xml.rels")?;
    let p = roxmltree::Document::parse(&presentation).map_err(|e| Error::new("extract", e))?;
    let r = roxmltree::Document::parse(&relations).map_err(|e| Error::new("extract", e))?;
    let mut out = String::new();
    for (i, slide) in p
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "sldId")
        .enumerate()
    {
        let id = slide
            .attributes()
            .find(|a| a.name() == "id" && a.namespace().is_some())
            .map(|a| a.value())
            .unwrap_or("");
        let target = r
            .descendants()
            .find(|n| n.attribute("Id") == Some(id))
            .and_then(|n| n.attribute("Target"))
            .ok_or_else(|| Error::new("extract", "Missing slide relationship"))?;
        let name = if target.starts_with('/') {
            target.trim_start_matches('/').into()
        } else {
            format!("ppt/{target}")
        };
        let s = xml(&mut zip, &name)?;
        let tree = roxmltree::Document::parse(&s).map_err(|e| Error::new("extract", e))?;
        if tree.descendants().any(|n| {
            n.is_element()
                && ["pic", "oleObj", "chart", "graphicFrame"].contains(&n.tag_name().name())
                && !n
                    .descendants()
                    .any(|c| c.is_element() && c.tag_name().name() == "tbl")
        }) {
            return Err(Error::new(
                "quality",
                "Slide contains graphical content requiring Docling",
            ));
        }
        out.push_str(&format!("## Slide {}\n\n", i + 1));
        for node in tree.descendants().filter(|n| {
            n.is_element()
                && (n.tag_name().name() == "p" || n.tag_name().name() == "tbl")
                && !n
                    .ancestors()
                    .skip(1)
                    .any(|p| p.is_element() && p.tag_name().name() == "tbl")
        }) {
            if node.tag_name().name() == "tbl" {
                out.push_str(&table(node));
            } else {
                if node
                    .descendants()
                    .any(|n| n.is_element() && n.tag_name().name() == "buChar")
                {
                    out.push_str("- ");
                }
                out.push_str(&text(node));
            }
            out.push_str("\n\n");
        }
    }
    Ok(out)
}
