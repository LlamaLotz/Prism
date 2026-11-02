#!/usr/bin/env python3
"""Stage the pinned LFM2.5 GGUF and its license for a packaged Prism build.

The model is not committed to git. Run this before `tauri build` (or in the
release job) so `src-tauri/resources/models` contains the exact artifact whose
SHA-256 is recorded in `manifest.json`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

REVISION = "8ed288026e23958ad9dfa92d53ed773a8eee7125"
REPO = "LiquidAI/LFM2.5-1.2B-Instruct-GGUF"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "models"
LICENSE_OUT = ROOT / "resources" / "licenses" / "LFM-OPEN-LICENSE.txt"
BASE = f"https://huggingface.co/{REPO}/resolve/{REVISION}"

MODELS = {
    "q4-k-m": {
        "file": "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
        "sha256": "b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5",
        "size": 730895168,
        "quantization": "Q4_K_M",
    },
    "qad-q4-0": {
        "file": "LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf",
        "sha256": "bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1",
        "size": 695755488,
        "quantization": "QAD-Q4_0",
    },
}


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response, destination.open("wb") as output:
        total = int(response.headers.get("Content-Length") or 0)
        written = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            written += len(chunk)
            if total:
                print(f"\r  {written * 100 // total:3d}%", end="", file=sys.stderr, flush=True)
    print("", file=sys.stderr)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def ensure_model(name: str) -> dict:
    entry = MODELS[name]
    destination = OUT / entry["file"]
    if destination.is_file():
        if destination.stat().st_size == entry["size"] and digest(destination) == entry["sha256"]:
            print(f"Model already staged: {destination}")
            return entry
        print(f"Existing model failed verification; replacing {destination}", file=sys.stderr)
        destination.unlink()
    print(f"Downloading {entry['file']} ({entry['size'] // (1024 * 1024)} MB)")
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        download(f"{BASE}/{entry['file']}", temporary)
        if temporary.stat().st_size != entry["size"]:
            raise SystemExit(f"size mismatch: {temporary.stat().st_size} != {entry['size']}")
        actual = digest(temporary)
        if actual != entry["sha256"]:
            raise SystemExit(f"sha256 mismatch: {actual} != {entry['sha256']}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Staged {destination}")
    return entry


def write_manifest(selected: list[str]) -> None:
    entries = [MODELS[name] for name in selected]
    manifest = {
        "source": REPO,
        "revision": REVISION,
        "license": "LFM Open License v1.0",
        "default": entries[0]["file"],
        "models": entries,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model",
        choices=sorted(MODELS),
        action="append",
        default=None,
        help="Model variant(s) to stage (default: q4-k-m)",
    )
    args = parser.parse_args()
    selected = args.model or ["q4-k-m"]
    OUT.mkdir(parents=True, exist_ok=True)
    for name in selected:
        ensure_model(name)
    write_manifest(selected)
    if not LICENSE_OUT.is_file():
        LICENSE_OUT.parent.mkdir(parents=True, exist_ok=True)
        download(f"{BASE}/LICENSE", LICENSE_OUT)
    print(f"Manifest: {OUT / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
