"""Prism's private backend entry point (API or worker).

Runs from the read-only backend resource directory, with data paths passed by
the native supervisor. Deliberately does not install packages or load user .env.
"""
import os
from pathlib import Path
import sys

runtime = Path(__file__).resolve().parent
sys.path[:0] = [str(runtime / "backend"), str(runtime / "lib")]
os.chdir(runtime / "backend")
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["DOTENV_DISABLED"] = "1"
os.environ["TIKTOKEN_CACHE_DIR"] = str(runtime / "tiktoken-cache")
os.environ["PATH"] = str(runtime / "bin") + os.pathsep + os.environ.get("PATH", "")
os.environ["IMAGEIO_FFMPEG_EXE"] = str(runtime / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))

if sys.argv[1] == "api":
    import uvicorn
    uvicorn.run("api.main:app", host="127.0.0.1", port=int(sys.argv[2]), access_log=False, log_level="warning")
elif sys.argv[1] == "worker":
    from importlib.metadata import entry_points
    entry = next(e for e in entry_points(group="console_scripts") if e.name == "surreal-commands-worker")
    sys.argv = ["surreal-commands-worker", "--import-modules", "commands", "--max-tasks", "2"]
    entry.load()()
else:
    raise SystemExit("Expected api or worker")
