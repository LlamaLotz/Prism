"""Stage a local dev-only ingest runtime (worker binary + manifest).

This is NOT the release path: it bundles no third-party binaries or models.
External tools (ffmpeg, yt-dlp, tesseract, chromium) resolve via PATH, and
features not compiled in (pdfium/ml/browser) report `unavailable` so the
Tauri adapter retries once with Python. Release staging still requires
`scripts/build-ingest-runtime.py --release --assets-lock <lock.json>`.

Usage:
    python3 scripts/stage-dev-runtime.py [--release] [--features FEATS]

Output (gitignored): src-tauri/ingest-runtime/{bin/prism-ingest,manifest.json}
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--features", default="")
    args = parser.parse_args()

    target = subprocess.check_output(["rustc", "-vV"], text=True).split("host: ")[1].splitlines()[0]
    manifest = ROOT / "src-tauri/src/ingest/Cargo.toml"
    command = ["cargo", "build", "--locked", "--manifest-path", str(manifest)]
    if args.features:
        command += ["--features", args.features]
    if args.release:
        command.append("--release")
    subprocess.run(command, check=True)

    worker = (
        manifest.parent
        / "target"
        / ("release" if args.release else "debug")
        / ("prism-ingest.exe" if "windows" in target else "prism-ingest")
    )
    if not worker.is_file():
        print(f"worker binary not found: {worker}", file=sys.stderr)
        return 1

    output = ROOT / "src-tauri" / "ingest-runtime"
    bin_dir = output / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    dest = bin_dir / worker.name
    shutil.copy2(worker, dest)
    dest.chmod(0o755)
    digest = hashlib.file_digest(dest.open("rb"), "sha256").hexdigest()
    (output / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "target": target,
                "dev_only": True,
                "features": args.features.split(",") if args.features else [],
                "assets": [
                    {
                        "path": f"bin/{worker.name}",
                        "sha256": digest,
                        "license": "Project license",
                    }
                ],
                "note": "Dev runtime: no third-party binaries/models bundled. "
                "External tools resolve via PATH; missing capabilities fall back to Python.",
            },
            indent=2,
        )
        + "\n"
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
