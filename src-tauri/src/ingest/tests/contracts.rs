use clap::Parser;
use prism_ingest::{
    audio,
    cli::{Args, Ocr},
    output, pdf, web, youtube,
};
#[test]
fn legacy_filename_contract() {
    let data: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/legacy-contracts.json")).unwrap();
    for case in data["sanitize_filename"].as_array().unwrap() {
        assert_eq!(
            output::sanitize(case["input"].as_str().unwrap()),
            case["expected"].as_str().unwrap()
        );
    }
}
#[test]
fn ocr_precedence() {
    let a = Args::parse_from([
        "prism-ingest",
        "--ocr",
        "off",
        "--yt_method",
        "A",
        "--files",
        "one.pdf|O",
        "two.pdf",
        "--urls",
        "https://example.test",
    ]);
    assert_eq!(
        a.sources().unwrap(),
        vec![
            ("one.pdf".into(), Ocr::On),
            ("two.pdf".into(), Ocr::Adaptive),
            ("https://example.test".into(), Ocr::Adaptive)
        ]
    );
}
#[test]
fn pdf_boundaries() {
    assert_eq!(pdf::chunks(0), vec![]);
    assert_eq!(pdf::chunks(100), vec![(0, 100)]);
    assert_eq!(pdf::chunks(101), vec![(0, 50), (50, 100), (100, 101)]);
    assert_eq!(pdf::chunks(150), vec![(0, 50), (50, 100), (100, 150)]);
}
#[test]
fn captions_formats_and_gate() {
    assert_eq!(
        youtube::clean("WEBVTT\n\n00:00.000 --> 00:01.000\nHello world.\nHello world.\n"),
        "Hello world."
    );
    assert_eq!(
        youtube::clean(r#"{"events":[{"segs":[{"utf8":"Hello "},{"utf8":"world"}]}]}"#),
        "Hello world"
    );
    assert_eq!(
        youtube::clean("<transcript><text>Hello &amp; world</text></transcript>"),
        "Hello & world"
    );
    assert!(youtube::captions_acceptable(&"word ".repeat(50), None));
    assert!(!youtube::captions_acceptable(
        &"word ".repeat(49),
        Some(61.)
    ));
    assert!(youtube::captions_acceptable(&"word ".repeat(10), Some(60.)));
}
#[test]
fn meaningful_excludes_markers() {
    assert_eq!(
        prism_ingest::meaningful("Page 1\nP. 3\nPage-12\none two three"),
        3
    );
}
#[test]
fn crawl_scope() {
    let base = url::Url::parse("https://example.test/start").unwrap();
    assert_eq!(
        web::canonical(&base, "/next#foo").unwrap().as_str(),
        "https://example.test/next"
    );
    assert!(web::canonical(&base, "https://other.test").is_none());
    assert!(web::canonical(&base, "javascript:alert(1)").is_none());
}
#[test]
fn html_structure() {
    let md=web::markdown("<html><nav>ignore this</nav><main><h1>Title</h1><p>Hello <strong>world</strong>.</p><table><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>two</td></tr></table><script>bad()</script></main></html>");
    assert!(md.contains("Title"));
    assert!(md.contains("**world**"));
    assert!(md.contains("one"));
    assert!(!md.contains("ignore this"));
    assert!(!md.contains("bad()"));
}
#[test]
fn overlap_timestamps() {
    assert!(!audio::new_segment(2900, 50, 3000));
    assert!(audio::new_segment(2900, 150, 3000));
}
#[test]
fn atomic_replace_and_sidecar() {
    let d = tempfile::tempdir().unwrap();
    let stage = d.path().join("stage");
    let vault = d.path().join("vault");
    let e = prism_ingest::Extraction {
        title: "A/B".into(),
        stem: "A/B".into(),
        body: "Body".into(),
        engine: "yt-dlp Native".into(),
        source: "https://youtu.be/test".into(),
        kind: "youtube".into(),
    };
    output::stage(&e, &stage).unwrap();
    output::publish(&stage, &vault).unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.join("A B.md")).unwrap(),
        "# A/B\n\nBody"
    );
    let meta: serde_json::Value = serde_json::from_slice(
        &std::fs::read(vault.join("note metadata/A B.md.meta.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(meta["engine"], "yt-dlp Native");
    output::atomic(&vault.join("A B.md"), b"replacement").unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.join("A B.md")).unwrap(),
        "replacement"
    );
}
#[test]
fn no_fallback_for_terminal_errors() {
    for kind in ["write", "cancelled", "input", "protocol", "denied"] {
        assert!(!prism_ingest::Error::new(kind, "test").fallback());
    }
}
fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}
#[test]
fn docx_preserves_heading_paragraph_table() {
    let s = prism_ingest::docs::extract(&fixture("structured.docx")).unwrap();
    assert!(s.starts_with("# Fixture heading"));
    assert!(s.contains("First paragraph."));
    assert!(s.contains("| Alpha | 42 |"));
}
#[test]
fn pptx_uses_relationship_order() {
    let s = prism_ingest::docs::extract(&fixture("ordered.pptx")).unwrap();
    assert!(s.find("First slide").unwrap() < s.find("Last slide").unwrap());
}
#[test]
fn spreadsheet_preserves_sheet_and_cells() {
    let s = prism_ingest::docs::extract(&fixture("sheets.xlsx")).unwrap();
    assert!(s.contains("## Metrics"));
    assert!(s.contains("| Alpha | 42 |"));
}
#[test]
fn pdf_off_recovers_text_in_page_order() {
    let s = pdf::range(&fixture("text-101.pdf"), 49, 51, Ocr::Off).unwrap();
    assert!(s.find("Prism fixture page 50.").unwrap() < s.find("Prism fixture page 51.").unwrap());
    assert!(!s.contains("Prism fixture page 49."));
}
