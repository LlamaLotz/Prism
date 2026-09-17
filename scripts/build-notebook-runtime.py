#!/usr/bin/env python3
"""Build a relocatable, native Notebook runtime. Build tools never ship to users.

Run on each target architecture with Python and uv installed. Outputs a Tauri
resource payload; no dependencies are resolved or downloaded at application boot.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / "notebook/upstream.json").read_text())


def run(*args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, **kwargs)


def download(url, target):
    request = urllib.request.Request(url, headers={"User-Agent": "Prism-runtime-builder"})
    with urllib.request.urlopen(request, timeout=120) as response:
        target.write_bytes(response.read())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uv", default="uv")
    args = parser.parse_args()
    machine = {"AMD64": "x86_64", "arm64": "aarch64"}.get(platform.machine(), platform.machine())
    system = {"Darwin": "apple-darwin", "Windows": "pc-windows-msvc"}.get(platform.system())
    if not system or machine not in ("x86_64", "aarch64"):
        raise SystemExit("Build on a supported macOS or Windows target")
    triple = f"{machine}-{system}"
    dest = ROOT / "src-tauri/notebook-runtime" / triple
    if (dest / "manifest.json").exists():
        raise SystemExit(f"Completed output already exists: {dest}. Move it aside before rebuilding.")
    dest.mkdir(parents=True, exist_ok=True)
    # uv's managed Python distributions are relocatable; the executable is
    # invoked directly with an explicit PYTHONPATH, never a venv console script.
    run(args.uv, "python", "install", PIN["python"], "--install-dir", dest / "python", "--no-bin")
    matches = list((dest / "python").glob("*/python.exe")) if os.name == "nt" else list((dest / "python").glob("*/bin/python3.12"))
    matches = list({p.resolve(): p.resolve() for p in matches}.values())
    if len(matches) != 1:
        raise RuntimeError(f"Expected one private Python, got {matches}")
    python = matches[0]
    source = ROOT / "notebook/upstream"
    shutil.copytree(source, dest / "backend", dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", ".venv"))
    # Single, documented upstream patch: redirect writable data outside resources.
    config = dest / "backend/open_notebook/config.py"
    original = config.read_text()
    assert 'DATA_FOLDER = "./data"' in original
    config.write_text(original.replace('DATA_FOLDER = "./data"', 'DATA_FOLDER = os.environ["PRISM_NOTEBOOK_DATA"]'))
    with tempfile.TemporaryDirectory(prefix="prism-notebook-build-") as tmp:
        tmp = Path(tmp)
        requirements = tmp / "requirements.txt"
        run(args.uv, "export", "--project", source, "--frozen", "--no-dev", "--no-emit-project", "--output-file", requirements, stdout=subprocess.DEVNULL)
        run(args.uv, "pip", "sync", "--python", python, "--target", dest / "lib", requirements)
        run(args.uv, "pip", "install", "--python", python, "--target", dest / "lib", f"imageio-ffmpeg=={PIN['imageioFfmpeg']}")
        arch = {"x86_64": "amd64", "aarch64": "arm64"}[machine]
        os_label = "windows" if os.name == "nt" else "darwin"
        suffix = "zip" if os.name == "nt" else "tgz"
        asset = f"surreal-v{PIN['surrealdb']}.{os_label}-{arch}.{suffix}"
        archive = tmp / asset
        url = f"https://github.com/surrealdb/surrealdb/releases/download/v{PIN['surrealdb']}/{asset}"
        download(url, archive)
        # Verify against the release asset digest served by GitHub over HTTPS.
        release = tmp / "release.json"
        download(f"https://api.github.com/repos/surrealdb/surrealdb/releases/tags/v{PIN['surrealdb']}", release)
        metadata = next(a for a in json.loads(release.read_text())["assets"] if a["name"] == asset)
        digest = metadata.get("digest")
        if not digest or digest != "sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest():
            raise RuntimeError("SurrealDB release digest missing or invalid")
        binary = "surreal.exe" if os.name == "nt" else "surreal"
        (dest / "bin").mkdir(exist_ok=True)
        if suffix == "zip":
            with zipfile.ZipFile(archive) as z:
                member = next(n for n in z.namelist() if Path(n).name == binary)
                (dest / "bin" / binary).write_bytes(z.read(member))
        else:
            with tarfile.open(archive) as t:
                member = next(m for m in t.getmembers() if Path(m.name).name == binary)
                with t.extractfile(member) as f:
                    (dest / "bin" / binary).write_bytes(f.read())
        (dest / "bin" / binary).chmod(0o755)
    ffmpeg = next(p for p in (dest / "lib/imageio_ffmpeg/binaries").iterdir() if p.name.startswith("ffmpeg-"))
    shutil.copy2(ffmpeg, dest / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
    run(__import__('sys').executable, ROOT / "scripts/patch-notebook-runtime.py", dest)
    env = {**os.environ, "PYTHONPATH": str(dest / "lib"), "TIKTOKEN_CACHE_DIR": str(dest / "tiktoken-cache")}
    run(python, "-c", "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')", env=env)
    manifest = {**PIN, "target": triple, "pythonExecutable": str(python.relative_to(dest)).replace('\\', '/'), "surrealExecutable": f"bin/{binary}"}
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Runtime ready: {dest}")


if __name__ == "__main__":
    main()
