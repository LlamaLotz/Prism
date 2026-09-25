use crate::{cli::Ocr, Error, Result};
use std::{path::Path, process::Command, time::Duration};
pub fn chunks(pages: u32) -> Vec<(u32, u32)> {
    let size = if pages > 100 { 50 } else { pages.max(1) };
    (0..pages)
        .step_by(size as usize)
        .map(|s| (s, (s + size).min(pages)))
        .collect()
}
pub fn ocr_image(path: &Path) -> Result<String> {
    let mut cmd = Command::new(crate::process::binary("tesseract"));
    cmd.arg(path).args(["stdout", "--psm", "3"]);
    if std::env::var_os("PRISM_INGEST_BIN").is_some() {
        let language = crate::assets::model("eng.traineddata")?;
        cmd.arg("--tessdata-dir")
            .arg(language.parent().unwrap())
            .args(["-l", "eng"]);
    }
    let bytes = crate::process::run(&mut cmd, Duration::from_secs(90), 16 * 1024 * 1024)?;
    let text = String::from_utf8_lossy(&bytes).trim().to_owned();
    if text.is_empty() {
        Err(Error::new("quality", "OCR returned no text"))
    } else {
        Ok(text)
    }
}
pub fn extract(path: &Path, ocr: Ocr, scratch: &Path) -> Result<String> {
    // lopdf's parser materializes the PDF: larger inputs go to the file-backed PDFium reader.
    let pages = page_count(path)?;
    if pages == 0 {
        return Err(Error::new("extract", "PDF contains no pages"));
    }
    let ranges = chunks(pages);
    let workers = crate::budget().min(4);
    let mut output = Vec::new();
    for batch in ranges.chunks(workers) {
        let results = std::thread::scope(|scope| {
            batch
                .iter()
                .map(|&(start, end)| {
                    scope.spawn(move || {
                        let dest = scratch.join(format!("pages-{start}-{end}.md"));
                        let mut cmd = Command::new(std::env::current_exe()?);
                        cmd.env(
                            "PRISM_INGEST_THREADS",
                            (crate::budget() / workers).max(1).to_string(),
                        );
                        cmd.arg("--pdf-chunk")
                            .arg(path)
                            .args([
                                "--page-start",
                                &start.to_string(),
                                "--page-end",
                                &end.to_string(),
                                "--ocr",
                                ocr.name(),
                                "--chunk-output",
                            ])
                            .arg(&dest);
                        match crate::process::run(
                            &mut cmd,
                            Duration::from_secs(90),
                            4 * 1024 * 1024,
                        ) {
                            Ok(_) => std::fs::read_to_string(dest).map_err(Error::from),
                            Err(e) => {
                                if ocr == Ocr::On || e.kind != "timeout" {
                                    return Err(e);
                                }
                                crate::event(
                                    "diagnostic",
                                    format!(
                                        "Pages {}-{end} timed out; retrying text only",
                                        start + 1
                                    ),
                                );
                                let mut retry = Command::new(std::env::current_exe()?);
                                retry.env(
                                    "PRISM_INGEST_THREADS",
                                    (crate::budget() / workers).max(1).to_string(),
                                );
                                retry
                                    .arg("--pdf-chunk")
                                    .arg(path)
                                    .args([
                                        "--page-start",
                                        &start.to_string(),
                                        "--page-end",
                                        &end.to_string(),
                                        "--ocr",
                                        "off",
                                        "--chunk-output",
                                    ])
                                    .arg(&dest);
                                crate::process::run(
                                    &mut retry,
                                    Duration::from_secs(90),
                                    4 * 1024 * 1024,
                                )?;
                                std::fs::read_to_string(dest).map_err(Error::from)
                            }
                        }
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| {
                    h.join()
                        .unwrap_or_else(|_| Err(Error::new("extract", "PDF worker panicked")))
                })
                .collect::<Vec<_>>()
        });
        for result in results {
            output.push(result?);
        }
    }
    Ok(output.join("\n\n---\n\n"))
}
fn page_count(path: &Path) -> Result<u32> {
    #[cfg(feature = "pdfium")]
    {
        if let Ok(pdfium) = bind() {
            if let Ok(doc) = pdfium.load_pdf_from_file(path, None) {
                return Ok(doc.pages().len() as u32);
            }
        }
    }
    if path.metadata()?.len() > 256 * 1024 * 1024 {
        return Err(Error::new("unavailable", "Large PDF requires PDFium"));
    }
    Ok(lopdf::Document::load(path)
        .map_err(|e| Error::new("extract", e))?
        .get_pages()
        .len() as u32)
}
#[cfg(feature = "pdfium")]
fn bind() -> Result<pdfium_render::prelude::Pdfium> {
    use pdfium_render::prelude::*;
    let dir = std::env::var_os("PRISM_INGEST_LIB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::data_dir().join("lib"));
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir))
        .map_err(|e| Error::new("unavailable", e))?;
    Ok(Pdfium::new(bindings))
}
pub fn range(path: &Path, start: u32, end: u32, ocr: Ocr) -> Result<String> {
    #[cfg(feature = "pdfium")]
    if let Ok(pdfium) = bind() {
        use pdfium_render::prelude::*;
        let doc = pdfium
            .load_pdf_from_file(path, None)
            .map_err(|e| Error::new("extract", e))?;
        let mut texts = Vec::new();
        let scratch = tempfile::tempdir()?;
        for idx in start..end {
            let page = doc
                .pages()
                .get(idx as u16)
                .map_err(|e| Error::new("extract", e))?;
            let text = page.text().map_err(|e| Error::new("extract", e))?.all();
            // Vector graphics, images and forms may carry content not represented by plain text.
            let complex = page
                .objects()
                .iter()
                .any(|o| o.object_type() != PdfPageObjectType::Text);
            let boxes = page
                .objects()
                .iter()
                .filter_map(|o| o.bounds().ok())
                .collect::<Vec<_>>();
            let columns = boxes.iter().enumerate().any(|(i, a)| {
                boxes.iter().skip(i + 1).any(|b| {
                    (a.bottom().value - b.bottom().value).abs() < 5.0
                        && (a.right().value + 30.0 < b.left().value
                            || b.right().value + 30.0 < a.left().value)
                })
            });
            let complex = complex || columns;
            if ocr != Ocr::Off && complex && crate::meaningful(&text) >= 50 {
                return Err(Error::new("quality", "PDF layout needs Docling"));
            }
            if ocr == Ocr::On || (ocr == Ocr::Adaptive && crate::meaningful(&text) < 50) {
                let image = scratch.path().join(format!("page-{idx}.png"));
                page.render_with_config(
                    &PdfRenderConfig::new()
                        .set_target_width(1800)
                        .set_maximum_height(2400),
                )
                .map_err(|e| Error::new("extract", e))?
                .as_image()
                .save(&image)
                .map_err(|e| Error::new("extract", e))?;
                texts.push(ocr_image(&image)?);
            } else if !text.trim().is_empty() {
                texts.push(if ocr == Ocr::Off {
                    format!("### Page {}\n\n{}", idx + 1, text.trim())
                } else {
                    text
                });
            }
        }
        if !texts.is_empty() {
            return Ok(texts.join(if ocr == Ocr::Off {
                "\n\n---\n\n"
            } else {
                "\n\n"
            }));
        }
    }
    if ocr == Ocr::On {
        return Err(Error::new(
            "unavailable",
            "PDFium is required to render OCR pages",
        ));
    }
    if path.metadata()?.len() > 256 * 1024 * 1024 {
        return Err(Error::new(
            "unsupported",
            "PDF exceeds text parser buffer budget",
        ));
    }
    let pages = pdf_extract::extract_text_by_pages(path).map_err(|e| Error::new("extract", e))?;
    let text = pages
        .get(start as usize..end as usize)
        .ok_or_else(|| Error::new("extract", "Invalid page range"))?
        .iter()
        .enumerate()
        .map(|(i, t)| format!("### Page {}\n\n{}", start as usize + i + 1, t.trim()))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    if ocr == Ocr::Adaptive {
        return Err(Error::new(
            "quality",
            "PDFium layout inspection unavailable; use Docling",
        ));
    }
    if pages
        .get(start as usize..end as usize)
        .unwrap_or_default()
        .iter()
        .all(|p| p.trim().is_empty())
    {
        return Err(Error::new("quality", "No selectable PDF text"));
    }
    Ok(text)
}
