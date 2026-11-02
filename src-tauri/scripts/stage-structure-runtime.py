#!/usr/bin/env python3
"""Stage the pinned llama.cpp CPU runtime used by the local structure worker.

This downloads the upstream `b12034` CPU archive for the host platform and
copies only `llama-cli` plus its shared libraries into
`src-tauri/resources/bin`. The macOS/Windows binaries must be signed together
with the application during release packaging.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

BUILD = "b12034"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "bin"
BASE = f"https://github.com/ggml-org/llama.cpp/releases/download/{BUILD}"


def asset_name() -> str:
    system = sys.platform
    machine = platform.machine().lower()
    if system == "linux":
        return f"llama-{BUILD}-bin-ubuntu-arm64.tar.gz" if machine in {"aarch64", "arm64"} else f"llama-{BUILD}-bin-ubuntu-x64.tar.gz"
    if system == "darwin":
        return f"llama-{BUILD}-bin-macos-arm64.tar.gz" if machine in {"aarch64", "arm64"} else f"llama-{BUILD}-bin-macos-x64.tar.gz"
    if system == "win32":
        return f"llama-{BUILD}-bin-win-cpu-arm64.zip" if machine in {"aarch64", "arm64"} else f"llama-{BUILD}-bin-win-cpu-x64.zip"
    raise SystemExit(f"Unsupported platform: {system} {machine}")


def download(url: str, destination: Path) -> None:
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


def wanted(path: Path) -> bool:
    name = path.name
    if name in {"llama-cli", "llama-cli.exe"}:
        return True
    if name.endswith((".dll", ".dylib")):
        return True
    if ".so" in name:
        return True
    return False


def stage_archive(archive: Path, work: Path) -> None:
    extracted = work / "extract"
    extracted.mkdir()
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(extracted)
    else:
        with tarfile.open(archive) as bundle:
            bundle.extractall(extracted)
    source = next((p for p in extracted.iterdir() if p.is_dir()), extracted)
    OUT.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        if not item.is_file() or not wanted(item):
            continue
        destination = OUT / item.name
        if destination.exists():
            destination.unlink()
        shutil.copyfile(item, destination)
        if sys.platform != "win32":
            destination.chmod(destination.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    (OUT / "manifest.json").write_text(
        json.dumps(
            {
                "project": "ggml-org/llama.cpp",
                "build": BUILD,
                "platform": sys.platform,
                "machine": platform.machine(),
                "license": "MIT",
            },
            indent=2,
        )
        + "\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-url", help="Override the upstream archive URL")
    args = parser.parse_args()
    name = asset_name()
    url = args.asset_url or f"{BASE}/{name}"
    with tempfile.TemporaryDirectory(prefix="prism-structure-runtime-") as temporary:
        work = Path(temporary)
        archive = work / name
        print(f"Downloading {url}")
        download(url, archive)
        stage_archive(archive, work)
    print(f"Staged llama.cpp {BUILD} runtime in {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
