//! Copy only checksum-verified bundled models into the writable model cache.
use crate::{Error, Result};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::PathBuf,
};
pub fn model(name: &str) -> Result<PathBuf> {
    let bin = std::env::var_os("PRISM_INGEST_BIN")
        .map(PathBuf::from)
        .ok_or_else(|| Error::new("unavailable", "Missing runtime manifest location"))?;
    let root = bin
        .parent()
        .ok_or_else(|| Error::new("unavailable", "Invalid runtime directory"))?;
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("manifest.json")).map_err(|e| Error::new("unavailable", e))?,
    )
    .map_err(|e| Error::new("unavailable", e))?;
    let key = format!("models/{name}");
    let expected = manifest["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["path"] == key))
        .and_then(|a| a["sha256"].as_str())
        .ok_or_else(|| Error::new("unavailable", format!("No pinned model entry: {name}")))?;
    let output = crate::data_dir().join(&key);
    fn hash(path: &std::path::Path) -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    if hash(&output).ok().as_deref() == Some(expected) {
        return Ok(output);
    }
    let source = root.join(key);
    if hash(&source).map_err(|e| Error::new("unavailable", e))? != expected {
        return Err(Error::new("unavailable", "Model checksum mismatch"));
    }
    std::fs::create_dir_all(output.parent().unwrap())?;
    let mut temp = tempfile::NamedTempFile::new_in(output.parent().unwrap())?;
    std::io::copy(&mut std::fs::File::open(source)?, &mut temp)?;
    temp.flush()?;
    temp.persist(&output).map_err(|e| Error::new("write", e))?;
    Ok(output)
}
