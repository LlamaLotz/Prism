use sha2::{Digest, Sha256};
#[test]
fn model_cache_rejects_unpinned_and_corrupt_payloads() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("runtime");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::create_dir_all(root.join("models")).unwrap();
    let bytes = b"synthetic model payload";
    std::fs::write(root.join("models/test.bin"), bytes).unwrap();
    let digest = format!("{:x}", Sha256::digest(bytes));
    std::fs::write(
        root.join("manifest.json"),
        serde_json::json!({"version":1,"assets":[{"path":"models/test.bin","sha256":digest}]})
            .to_string(),
    )
    .unwrap();
    std::env::set_var("PRISM_INGEST_BIN", root.join("bin"));
    std::env::set_var("PRISM_INGEST_DATA", d.path().join("data"));
    assert!(prism_ingest::assets::model("unlisted.bin").is_err());
    let cached = prism_ingest::assets::model("test.bin").unwrap();
    assert_eq!(std::fs::read(&cached).unwrap(), bytes);
    std::fs::write(&cached, b"corrupt").unwrap();
    prism_ingest::assets::model("test.bin").unwrap();
    assert_eq!(std::fs::read(&cached).unwrap(), bytes);
    std::fs::remove_file(&cached).unwrap();
    std::fs::write(root.join("models/test.bin"), b"corrupt").unwrap();
    assert!(prism_ingest::assets::model("test.bin").is_err());
    assert!(!cached.exists());
}
