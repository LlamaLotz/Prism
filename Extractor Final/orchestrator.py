"""Compatibility launcher for the native, non-interactive Prism ingestor."""
import os
import shutil
import subprocess
import sys

def run_orchestrator(option, source):
    binary = os.environ.get("PRISM_INGEST_EXECUTABLE") or shutil.which("prism-ingest")
    if not binary:
        raise RuntimeError("prism-ingest is unavailable; build the native runtime first")
    return subprocess.call([binary, "--urls" if str(option) == "2" else "--files", source])

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: orchestrator.py <source_url_or_path>")
    source = sys.argv[1]
    sys.exit(run_orchestrator("2" if source.startswith(("http://", "https://")) else "1", source))
