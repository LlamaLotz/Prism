import os
import sys
import subprocess
import shutil
import hashlib
import json
import time
import threading
import importlib.metadata
import importlib.util
from pathlib import Path

# ---------------------------------------------------------------------------
# Prevent SIGSEGV from duplicate OpenMP runtimes (libiomp5.dylib).
#
# torch and ctranslate2 each bundle their own copy of the Intel OpenMP
# runtime.  When both load into the same process, each initialises its
# own global thread table (__kmp_threads) and spawns worker threads.
# The two runtimes unknowingly fight over the same logical thread
# indices, and the second runtime's __kmp_hyper_barrier_release
# dereferences a null pointer in the first runtime's (now-corrupted)
# thread table.  KMP_DUPLICATE_LIB_OK suppresses only the initial
# duplicate-load fatal error, not the later thread-state corruption.
#
# The real fix: OMP_NUM_THREADS=1 forces both runtimes to run
# single-threaded, so neither spawns worker threads that can collide.
# ONNX Runtime (layout engine) uses its own thread pool, not OpenMP,
# and is unaffected.  Must be set BEFORE any module that pulls in
# OpenMP (numpy, scipy, torch, ctranslate2, onnxruntime) is imported.
# ---------------------------------------------------------------------------
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
# Also prevent MKL's internal threading (used by numpy/scipy on Intel).
os.environ.setdefault("MKL_NUM_THREADS", "1")


# =============================================================================
# Isolated ingestion environment (~/.prism/env)
# =============================================================================
# Homebrew Python on macOS (3.12+) is an "externally-managed" environment
# (PEP 668), so `pip install` into it fails with exit status 1 unless you pass
# `--break-system-packages`. Instead of breaking the system interpreter, the
# extractor runs inside a dedicated virtualenv at ~/.prism/env. A venv's pip is
# never externally managed, so installs succeed on every OS with no special
# flags.

PRISM_ENV_DIR = Path.home() / ".prism" / "env"
MIN_SUPPORTED_PYTHON = (3, 10)


def _is_supported_python_version(version_info):
    """Return whether a Python version can run the ingestion dependencies."""
    return tuple(version_info[:2]) >= MIN_SUPPORTED_PYTHON


def _env_python_pip():
    """Paths to the venv interpreter/pip without creating anything."""
    env_dir = PRISM_ENV_DIR
    if sys.platform == "win32":
        return str(env_dir / "Scripts" / "python.exe"), str(env_dir / "Scripts" / "pip.exe")
    return str(env_dir / "bin" / "python"), str(env_dir / "bin" / "pip")


def _python_version_of(python_bin):
    """Return ``(major, minor)`` for an interpreter, or None if it cannot run."""
    try:
        result = subprocess.run(
            [python_bin, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"],
            capture_output=True,
            text=True,
            check=False,
        )
        major, minor = (int(part) for part in result.stdout.strip().split(".", 1))
        return (major, minor)
    except (OSError, ValueError):
        return None


def _is_supported_python(python_bin):
    """Return whether an interpreter supports the current ingestion stack."""
    version = _python_version_of(python_bin)
    return version is not None and _is_supported_python_version(version)


def _python_candidates():
    """Return likely Python executable names and paths.

    macOS GUI apps do not inherit the shell's PATH, so names such as
    ``python3.12`` are not enough when Prism is launched from Finder or a
    packaged .app. Include the standard Homebrew and python.org locations.
    """
    candidates = []
    if _is_supported_python_version(sys.version_info):
        candidates.append(sys.executable)
    if sys.platform == "darwin":
        candidates.extend((
            "/opt/homebrew/bin/python3",
            "/opt/homebrew/opt/python/bin/python3",
            "/usr/local/bin/python3",
            "/usr/local/opt/python/bin/python3",
        ))
        for minor in (12, 11, 10, 13):
            candidates.extend((
                f"python3.{minor}",
                f"/opt/homebrew/bin/python3.{minor}",
                f"/opt/homebrew/opt/python@3.{minor}/bin/python3.{minor}",
                f"/usr/local/bin/python3.{minor}",
                f"/usr/local/opt/python@3.{minor}/bin/python3.{minor}",
                f"/Library/Frameworks/Python.framework/Versions/3.{minor}/bin/python3.{minor}",
            ))
    elif sys.platform == "win32":
        candidates.extend(("python.exe", "python3.exe"))
    else:
        candidates.extend(("python3", "python"))
    return candidates


def _find_compatible_base_python():
    """Find a system Python capable of creating a supported venv."""
    seen = set()
    for candidate in _python_candidates():
        resolved = candidate if Path(candidate).is_file() else shutil.which(candidate)
        if not resolved:
            continue
        resolved = str(Path(resolved).resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        if _is_supported_python(resolved):
            return resolved
    return None


def get_prism_env(python_creator=None):
    """Create (if missing) and return (python_bin, pip_bin) for the isolated
    ~/.prism/env virtualenv."""
    env_dir = PRISM_ENV_DIR
    env_python, _env_pip = _env_python_pip()
    if not Path(env_python).exists():
        if env_dir.exists():
            shutil.rmtree(env_dir)
        creator = python_creator or sys.executable
        print(f"[Prism Ingestion] Creating isolated virtual environment at {env_dir}...")
        subprocess.run([creator, "-m", "venv", str(env_dir)], check=True)
    return _env_python_pip()


def is_prism_env_active():
    """True when this interpreter IS the one inside ~/.prism/env."""
    try:
        return Path(sys.executable).resolve() == Path(_env_python_pip()[0]).resolve()
    except Exception:
        return False


def pip_install_args(*packages):
    """Build a `pip install` command for the current interpreter.

    Inside the venv this is a plain `pip install`. On macOS, if we're still on
    the externally-managed Homebrew interpreter (venv bootstrap failed), add
    `--break-system-packages` to bypass PEP 668.

    ``--prefer-binary`` keeps installs from falling back to source builds
    (and thus requiring MSVC on Windows) whenever a wheel exists.
    """
    cmd = [sys.executable, "-m", "pip", "install", "--prefer-binary"]
    in_venv = sys.prefix != sys.base_prefix
    if sys.platform == "darwin" and not in_venv:
        cmd.append("--break-system-packages")
    cmd.extend(packages)
    return cmd


def _version_tuple(version):
    """Return ``(major, minor)`` from a version string, ignoring suffixes."""
    parts = []
    for part in str(version).split(".")[:2]:
        digits = "".join(ch for ch in part if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _installed_version(package):
    """Read an installed distribution version without importing the package."""
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def _module_available(module_name):
    """Return whether a module can be located without importing it."""
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def _installed_version_fresh(package):
    """Read a distribution version in a fresh interpreter (post-install check)."""
    try:
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import importlib.metadata as m, sys; print(m.version(sys.argv[1]))",
                package,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.stdout.strip() or None
    except OSError:
        return None


def _pinned_specs(version=None):
    """Choose NumPy/SciPy/pandas constraints for the target Python.

    NumPy 1.x has no wheels for Python 3.13+, and current ctranslate2 and
    PyTorch releases support NumPy 2.  Older interpreters keep the pinned
    NumPy 1.x stack, which torch 2.2.x (macOS Intel) still needs; pandas 3.x
    requires NumPy >= 2, so those interpreters must stay on pandas 2.x.
    """
    version = tuple(version or sys.version_info[:2])
    if version >= (3, 13):
        return "numpy>=2", "scipy>=1.13", "pandas"
    return "numpy<2", "scipy<1.13", "pandas<3"


def required_packages(version=None):
    """Everything the extractor imports, for the target Python version."""
    numpy_spec, scipy_spec, pandas_spec = _pinned_specs(version)
    return [
        "yt-dlp",
        "docling",
        "faster-whisper",
        "requests",
        "beautifulsoup4",
        "tqdm",
        "pypdf",
        "pypdfium2",
        "PyMuPDF",
        "crawl4ai",
        pandas_spec,
        numpy_spec,
        scipy_spec,
        "Pillow",
        "opencv-python",
        "pydantic-settings",
        "typer",
    ]


ENV_READY_MARKER = PRISM_ENV_DIR / ".prism-ready"
ENV_LOCK_FILE = PRISM_ENV_DIR.parent / ".env-bootstrap.lock"


def _script_hash():
    try:
        return hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()
    except OSError:
        return ""


def _write_env_ready_marker():
    """Record that the isolated environment is fully prepared.

    The app uses this marker to skip the one-time setup on later launches and
    to detect when a new build changed the extractor or its requirements.
    """
    try:
        PRISM_ENV_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "scriptHash": _script_hash(),
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "requirements": required_packages(),
            "completedAt": int(time.time()),
        }
        temp = ENV_READY_MARKER.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temp, ENV_READY_MARKER)
    except OSError as exc:
        print(f"[Prism Ingestion] Could not write environment marker: {exc}")


_ENV_LOCK_STOP = None


def _env_lock_heartbeat(stop):
    while not stop.wait(60):
        try:
            os.utime(ENV_LOCK_FILE, None)
        except OSError:
            return


def _acquire_env_lock(timeout_seconds=1800):
    """Serialize venv creation/installs across setup and extraction processes.

    Returns ``(token, owns_lock)``.  A child relaunched by this process
    inherits ``PRISM_ENV_LOCK_TOKEN`` and must not release the parent's lock.
    """
    global _ENV_LOCK_STOP
    inherited = os.environ.get("PRISM_ENV_LOCK_TOKEN")
    if inherited:
        return inherited, False

    ENV_LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    token = f"{os.getpid()}-{time.time_ns()}"
    deadline = time.time() + timeout_seconds
    while True:
        try:
            fd = os.open(ENV_LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, token.encode("utf-8"))
            finally:
                os.close(fd)
            os.environ["PRISM_ENV_LOCK_TOKEN"] = token
            _ENV_LOCK_STOP = threading.Event()
            threading.Thread(
                target=_env_lock_heartbeat,
                args=(_ENV_LOCK_STOP,),
                daemon=True,
            ).start()
            return token, True
        except FileExistsError:
            try:
                age = time.time() - ENV_LOCK_FILE.stat().st_mtime
                # The owner refreshes the mtime every minute.  A lock that has
                # not moved for ten minutes belongs to a crashed setup.
                if age > 600:
                    ENV_LOCK_FILE.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                raise SystemExit(
                    "[Prism Ingestion ERROR] Another Prism environment setup is "
                    "still running. Wait for it to finish and try again."
                )
            time.sleep(1)


def _release_env_lock(token, owns_lock):
    global _ENV_LOCK_STOP
    if _ENV_LOCK_STOP is not None:
        _ENV_LOCK_STOP.set()
        _ENV_LOCK_STOP = None
    if not owns_lock:
        return
    try:
        if ENV_LOCK_FILE.read_text(encoding="utf-8").strip() == token:
            ENV_LOCK_FILE.unlink(missing_ok=True)
    except OSError:
        pass
    finally:
        if os.environ.get("PRISM_ENV_LOCK_TOKEN") == token:
            os.environ.pop("PRISM_ENV_LOCK_TOKEN", None)


def _relaunch_inside_venv(python_bin):
    """Re-run this script under the venv interpreter and wait for it.

    ``os.execv`` cannot replace a process on Windows: it starts a child and
    exits the parent with success.  Prism's host then believes extraction
    finished, deletes the staging directory, and reports "Extraction produced
    no Markdown documents" while the child is still starting.  Running the
    child synchronously keeps the host blocked until extraction really
    finishes, and passes the script path explicitly instead of relying on
    ``sys.argv[0]``.
    """
    script = str(Path(__file__).resolve())
    command = [python_bin, "-u", script, *sys.argv[1:]]
    print(f"[Prism Ingestion] Relaunching inside isolated environment: {python_bin}")
    sys.stdout.flush()
    sys.stderr.flush()
    raise SystemExit(subprocess.call(command))


def bootstrap_isolated_environment():
    """Ensure ~/.prism/env uses Python 3.10+ and run the extractor inside it.

    Crawl4AI's current releases use the ``X | None`` annotation syntax, which
    Python 3.9 cannot evaluate. Recreate stale venvs created by older Prism
    releases before importing any third-party package.
    """
    env_python, _env_pip = _env_python_pip()
    env_is_compatible = Path(env_python).exists() and _is_supported_python(env_python)

    if env_is_compatible and is_prism_env_active():
        return

    try:
        if not env_is_compatible:
            base_python = _find_compatible_base_python()
            if not base_python:
                raise RuntimeError(
                    "Prism could not find Python 3.10 or newer. "
                    "Install Python 3.12 with Homebrew (brew install python@3.12) "
                    "or from python.org, then try again."
                )
            if PRISM_ENV_DIR.exists():
                print("[Prism Ingestion] Replacing the existing unusable Python environment...")
                shutil.rmtree(PRISM_ENV_DIR)
            python_bin, _pip_bin = get_prism_env(base_python)
        else:
            python_bin, _pip_bin = get_prism_env()

        target_version = _python_version_of(python_bin) or sys.version_info[:2]
        packages = required_packages(target_version)
        print("[Prism Ingestion] Installing/upgrading ingestion packages "
              "(first run can take several minutes)...")
        # Use `python -m pip` (not the pip shim) so installs work even if the
        # venv was created without a pip entrypoint script.
        subprocess.run(
            [python_bin, "-m", "pip", "install", "--prefer-binary", "--upgrade", "pip"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        subprocess.run(
            [python_bin, "-m", "pip", "install", "--prefer-binary", "--upgrade", *packages],
            check=True,
        )
    except Exception as e:
        # Never install the whole ingestion stack into the system interpreter:
        # that pollutes the user's Python, can require --break-system-packages,
        # and leaves a half-broken venv that Prism keeps preferring.
        print(f"[Prism Ingestion ERROR] Failed to set up isolated environment: {e}")
        print(
            "Prism could not prepare its isolated Python environment. "
            "Install Python 3.12 (on Windows: "
            "winget install -e --id Python.Python.3.12) and try again.\n"
        )
        raise SystemExit(1) from e

    _relaunch_inside_venv(python_bin)


# Self-Healing Environment: Check and auto-install core dependencies before importing them
def _ensure_numpy_v1():
    """Force NumPy < 2 where the pinned 1.x ABI stack is required.

    Python 3.13+ has no NumPy 1.x wheels, and current ctranslate2/PyTorch
    releases support NumPy 2, so those interpreters use the modern stack.
    The version is read from metadata without importing NumPy; therefore a
    downgrade does not need a process restart.
    """
    if sys.version_info[:2] >= (3, 13):
        return
    installed = _installed_version("numpy")
    if installed is None or installed.startswith("1."):
        return
    print(f"[Prism Self-Healing] NumPy {installed} detected — "
          "ctranslate2/PyTorch require NumPy < 2. Downgrading…")
    try:
        # Fail fast instead of attempting a source build when no wheel exists.
        subprocess.check_call(
            pip_install_args("--only-binary=:all:", "numpy<2"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"[Prism Self-Healing] Failed to downgrade NumPy: {e}")
        print("ctranslate2 / PyTorch may crash. Try manual: pip install 'numpy<2'\n")


def _ensure_scipy_compat():
    """scipy >= 1.13 requires NumPy >= 2.  Since the pinned stack uses
    NumPy < 2, keep scipy < 1.13 on those interpreters."""
    if sys.version_info[:2] >= (3, 13):
        return
    installed = _installed_version("scipy")
    if installed is None or _version_tuple(installed) < (1, 13):
        return
    print(f"[Prism Self-Healing] scipy {installed} detected — "
          "scipy >= 1.13 requires NumPy >= 2. Downgrading…")
    try:
        subprocess.check_call(
            pip_install_args("--only-binary=:all:", "scipy<1.13"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"[Prism Self-Healing] Failed to downgrade scipy: {e}")


def _ensure_pandas_compat():
    """pandas 3.x requires NumPy >= 2; keep pandas 2.x on the NumPy 1 stack."""
    if sys.version_info[:2] >= (3, 13):
        return
    installed = _installed_version("pandas")
    if installed is None or _version_tuple(installed) < (3, 0):
        return
    print(f"[Prism Self-Healing] pandas {installed} detected — "
          "pandas >= 3 requires NumPy >= 2. Downgrading…")
    try:
        subprocess.check_call(
            pip_install_args("--only-binary=:all:", "pandas<3"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"[Prism Self-Healing] Failed to downgrade pandas: {e}")


def _ensure_torch_v2_4_plus():
    """PyTorch >= 2.4 is required by the installed transformers for docling's
    layout detection model (AutoImageProcessor).  On platforms where a
    newer PyTorch isn't available (e.g., macOS Intel, where the last wheel
    is 2.2.2), we fall back to a compatible transformers version instead.

    The persistent marker in the venv skips the check on later runs once the
    fallback is in place.  No process restart is used: the version is read
    from metadata and the upgraded module is not imported yet.
    """
    _fallback_marker = PRISM_ENV_DIR / ".torch_fallback_active"
    if _fallback_marker.exists():
        return  # Already handled — skip the entire check

    installed = _installed_version("torch")
    if installed is None or _version_tuple(installed) >= (2, 4):
        return

    print(f"[Prism Self-Healing] PyTorch {installed} detected — "
          "transformers requires PyTorch >= 2.4. Attempting upgrade…")
    try:
        subprocess.check_call(
            pip_install_args("--upgrade", "torch", "torchvision", "torchaudio"),
        )
    except Exception as e:
        print(f"[Prism Self-Healing] Failed to upgrade PyTorch: {e}")
        _install_compatible_transformers()
        _fallback_marker.touch()
        return

    upgraded = _installed_version_fresh("torch")
    if upgraded is None or _version_tuple(upgraded) < (2, 4):
        # pip reported success but this platform has no newer wheel.
        print(f"[Prism Self-Healing] PyTorch is still {upgraded or 'missing'}.")
        _install_compatible_transformers()
        _fallback_marker.touch()


def _install_compatible_transformers():
    """Install a transformers release that works with torch 2.2.x.

    transformers >= 4.48 bumped the minimum torch requirement to >= 2.4,
    so on Intel Macs (last torch wheel: 2.2.2) we need an older release.
    docling works fine with transformers 4.42–4.47."""
    print(f"[Prism Self-Healing] PyTorch cannot be upgraded on this platform. "
          "Installing transformers<4.48 (compatible with torch 2.2)…")
    try:
        subprocess.check_call(
            pip_install_args("transformers<4.48"),
        )
        print("[Prism Self-Healing] Compatible transformers installed.\n")
    except Exception as e:
        print(f"[Prism Self-Healing] Failed to install compatible transformers: {e}")
        print("Docling layout detection may fail. "
              "Try manual: pip install 'transformers<4.48'\n")


def _patch_hf_model_configs():
    """Patch cached HuggingFace model configs to use `rt_detr` model_type
    instead of the unsupported `rt_detr_v2`.  transformers < 4.48 doesn't
    know `rt_detr_v2`, but the ONNX engine only reads `id2label` from the
    config — the actual model architecture doesn't matter.

    Patches both the transformers and ONNX cached model directories.
    """
    import json
    from pathlib import Path as _P
    _cache = _P.home() / ".cache" / "huggingface" / "hub"
    for glob_pat in ("models--docling-project--docling-layout-heron*/snapshots/*/config.json",
                     "models--docling-project--docling-layout-heron-onnx*/snapshots/*/config.json"):
        for cfg_path in _cache.glob(glob_pat):
            try:
                cfg = json.loads(cfg_path.resolve().read_text())
                if cfg.get("model_type") == "rt_detr_v2":
                    cfg["model_type"] = "rt_detr"
                    cfg_path.resolve().write_text(json.dumps(cfg, indent=2))
            except Exception:
                pass  # Model not cached yet — no-op


def auto_heal_environment():
    # ---------------------------------------------------------------------
    # PREFLIGHT: on Python < 3.13 the compiled extensions in ctranslate2 /
    # PyTorch may need the NumPy 1.x ABI, so force-downgrade before any
    # import.  Python 3.13+ has no NumPy 1.x wheels and the current stack
    # supports NumPy 2, so those interpreters keep the modern versions.
    # ---------------------------------------------------------------------
    _ensure_numpy_v1()

    # ---------------------------------------------------------------------
    # PREFLIGHT: scipy >= 1.13 also demands NumPy >= 2 — pin it back too
    # on interpreters that use the NumPy 1.x stack.
    # ---------------------------------------------------------------------
    _ensure_scipy_compat()

    # ---------------------------------------------------------------------
    # PREFLIGHT: pandas 3.x also requires NumPy >= 2 — keep pandas 2.x on
    # the interpreters that use the NumPy 1.x stack.
    # ---------------------------------------------------------------------
    _ensure_pandas_compat()

    # ---------------------------------------------------------------------
    # PREFLIGHT: transformers (used by docling's layout engine) requires
    # PyTorch >= 2.4.  Upgrade if needed.
    # ---------------------------------------------------------------------
    _ensure_torch_v2_4_plus()

    # ---------------------------------------------------------------------
    # PREFLIGHT: on platforms where torch >= 2.4 is unavailable (macOS
    # Intel), force docling to use docling_layout_default instead of the
    # Transformers-based layout-object-detection engine.  The latter
    # requires both torch >= 2.4 AND the rt_detr_v2 model architecture
    # (transformers >= 4.48), which is impossible to satisfy on Intel Mac.
    # ---------------------------------------------------------------------
    # ---------------------------------------------------------------------
    # PREFLIGHT: on platforms where torch >= 2.4 is unavailable (macOS
    # Intel), the latest docling-layout-heron model uses `rt_detr_v2` in
    # its config.json, which transformers < 4.48 doesn't recognise.  The
    # ONNX engine only needs the id2label mapping from the config (not
    # the architecture), so patch `rt_detr_v2` → `rt_detr` (supported by
    # transformers 4.47) in any cached model snapshots.  Also force
    # docling to use the ONNX Runtime layout engine.
    # ---------------------------------------------------------------------
    global _FORCE_DOCLING_DEFAULT_LAYOUT
    if (PRISM_ENV_DIR / ".torch_fallback_active").exists():
        _FORCE_DOCLING_DEFAULT_LAYOUT = True
        _patch_hf_model_configs()
        
    # Modules to check
    # Maps: "import_module_name": "pip_package_name"
    numpy_spec, scipy_spec, pandas_spec = _pinned_specs()
    standard_required = {
        "yt_dlp": "yt-dlp",
        "tqdm": "tqdm",
        "pypdf": "pypdf",
        "pypdfium2": "pypdfium2",
        "pymupdf": "PyMuPDF",
        "crawl4ai": "crawl4ai",
        "faster_whisper": "faster-whisper",
        "docling": "docling",
        "pandas": pandas_spec,
        "numpy": numpy_spec,
        "scipy": scipy_spec,
        "PIL": "Pillow",
        "cv2": "opencv-python",
        "pydantic_settings": "pydantic-settings",
        "typer": "typer",
        "requests": "requests",
        "bs4": "beautifulsoup4",
    }

    # find_spec() only checks that a distribution is importable; it does not
    # execute the package.  Importing docling/crawl4ai here made startup slow
    # and caused any import-time error to be mistaken for a missing package.
    missing_standard = [
        package
        for module_name, package in standard_required.items()
        if not _module_available(module_name)
    ]

    missing_torch = not _module_available("torch")

    if missing_standard or missing_torch:
        print(f"\n[Prism Self-Healing] Environment needs repair.")
        try:
            # Upgrade pip first
            subprocess.check_call(pip_install_args("--upgrade", "pip"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            # Install Standard Packages
            if missing_standard:
                print(f"Installing missing packages: {missing_standard}")
                subprocess.check_call(pip_install_args(*missing_standard))

            # Install Torch Packages
            if missing_torch:
                print("Installing torch, torchvision, torchaudio (this may take a while)...")
                subprocess.check_call(pip_install_args("torch", "torchvision", "torchaudio"))

            # Nothing heavy has been imported yet, so the current process can
            # safely continue with the newly installed packages.  Restarting
            # via os.execv is broken on Windows (spawn + immediate exit), which
            # made the host treat the still-running child as a finished job.
            importlib.invalidate_caches()
            print("[Prism Self-Healing] Environment repaired. Continuing…\n")
        except Exception as e:
            print(f"[Prism Self-Healing ERROR] Failed to auto-install: {e}")
            print("Repair Prism's Python environment and try again.\n")
            raise SystemExit(1) from e


_ENV_LOCK_TOKEN, _ENV_LOCK_OWNS = _acquire_env_lock()
try:
    bootstrap_isolated_environment()
    auto_heal_environment()
    _write_env_ready_marker()
finally:
    _release_env_lock(_ENV_LOCK_TOKEN, _ENV_LOCK_OWNS)

if "--bootstrap-only" in sys.argv:
    print("[Prism Ingestion] Extractor environment ready.")
    raise SystemExit(0)

import re
import json
import time
import gc
import shutil
import urllib.request
import concurrent.futures
import argparse
import logging
from datetime import datetime
from pathlib import Path
import yt_dlp

# Lazy-load docling to prevent crashes during auto-healing
def get_docling_imports():
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.datamodel.base_models import InputFormat
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    return DocumentConverter, PdfFormatOption, PdfPipelineOptions, InputFormat, PyPdfiumDocumentBackend


# Suppress non-critical warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TORCH_COMPILE_DISABLE"] = "1"
os.environ["TORCHDYNAMO_DISABLE"] = "1"

from tqdm import tqdm
from pypdf import PdfReader, PdfWriter

# Crawl4AI Import
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

# ==========================================
# 1. SETUP BASE PATHS & ENGINE LOADERS
# ==========================================

SCRIPT_DIR = Path(__file__).parent.resolve()
OUTPUT_DIR = SCRIPT_DIR / "prism_output"
DOWNLOADS_DIR = SCRIPT_DIR / "downloads"
LOGS_DIR = SCRIPT_DIR / "logs"


class TeeStream:
    """Duplicates stdout/stderr to a timestamped log file in the logs directory."""
    def __init__(self, original_stream, log_file):
        self.terminal = original_stream
        self.log_file = log_file

    def write(self, message):
        self.terminal.write(message)
        if message:
            clean_msg = message.replace('\r', '')
            if clean_msg:
                try:
                    with open(self.log_file, "a", encoding="utf-8") as f:
                        f.write(clean_msg)
                except Exception:
                    pass

    def flush(self):
        self.terminal.flush()

    def isatty(self):
        return getattr(self.terminal, 'isatty', lambda: False)()


def setup_logging():
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_file = LOGS_DIR / f"prism_{timestamp}.log"
    
    # Redirect stdout and stderr so ALL prints, logs, and errors are captured
    sys.stdout = TeeStream(sys.__stdout__, log_file)
    sys.stderr = TeeStream(sys.__stderr__, log_file)
    
    print(f"==================================================")
    print(f"PRISM INGESTION PIPELINE LOG")
    print(f"Date/Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Log Destination: {log_file.resolve()}")
    print(f"==================================================\n")
    
    # Configure the standard logger
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file, encoding='utf-8'),
            logging.StreamHandler(sys.__stdout__)  # Log directly to raw stdout to avoid Tee duplication
        ]
    )
    
    return logging.getLogger("Prism")

WHISPER_MODEL = None
CONVERTER_NO_OCR = None
CONVERTER_WITH_OCR = None

# Use the ONNX Runtime layout engine (no transformers/torch required) on
# platforms where PyTorch >= 2.4 cannot be installed (macOS Intel).
# Set by auto_heal_environment() when the .torch_fallback_active marker exists.
_FORCE_DOCLING_DEFAULT_LAYOUT = False

def get_whisper():
    """Lazy loader for Faster-Whisper."""
    global WHISPER_MODEL
    if WHISPER_MODEL is None:
        try:
            import torch
            from faster_whisper import WhisperModel
            print("Initializing Faster-Whisper local model...")
            device = "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float16" if torch.cuda.is_available() else "int8"
            WHISPER_MODEL = WhisperModel("small", device=device, compute_type=compute_type)
        except Exception as e:
            logger.error(f"CRITICAL: Cannot initialize transcription (missing torch/faster-whisper or build error): {e}")
            WHISPER_MODEL = False # Mark as permanently unavailable
    return WHISPER_MODEL if WHISPER_MODEL is not False else None

def get_docling(enable_ocr=False):
    """Lazy loader for Optimized Docling Engine."""
    global CONVERTER_NO_OCR, CONVERTER_WITH_OCR
    
    # Dynamically import docling components to prevent startup crashes
    DocumentConverter, PdfFormatOption, PdfPipelineOptions, InputFormat, PyPdfiumDocumentBackend = get_docling_imports()

    def _mk_options():
        """Shared pipeline-options constructor."""
        pipeline_options = PdfPipelineOptions()
        pipeline_options.generate_picture_images = False
        pipeline_options.generate_table_images = False
        # On Intel Mac (torch 2.2.2 max), the transformers-based layout
        # engine fails because it needs torch>=2.4 AND rt_detr_v2 support
        # (transformers>=4.48).  Use the ONNX Runtime engine instead —
        # onnxruntime is already installed, and the ONNX-exported model
        # needs neither torch nor transformers.  Also checks the marker
        # file directly (not just the module global) so subprocess
        # workers pick it up too.
        if _FORCE_DOCLING_DEFAULT_LAYOUT or \
           (PRISM_ENV_DIR / ".torch_fallback_active").exists():
            from docling.datamodel.object_detection_engine_options import \
                OnnxRuntimeObjectDetectionEngineOptions
            pipeline_options.layout_options.engine_options = \
                OnnxRuntimeObjectDetectionEngineOptions()
        return pipeline_options
    
    if enable_ocr:
        if CONVERTER_WITH_OCR is None:
            pipeline_options = _mk_options()
            pipeline_options.do_ocr = True
    
            CONVERTER_WITH_OCR = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(
                        pipeline_options=pipeline_options,
                        backend=PyPdfiumDocumentBackend
                    ),
                    InputFormat.IMAGE: PdfFormatOption(
                        pipeline_options=pipeline_options,
                        backend=PyPdfiumDocumentBackend
                    ),
                }
            )
        return CONVERTER_WITH_OCR
    else:
        if CONVERTER_NO_OCR is None:
            pipeline_options = _mk_options()
            pipeline_options.do_ocr = False
    
            CONVERTER_NO_OCR = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(
                        pipeline_options=pipeline_options,
                        backend=PyPdfiumDocumentBackend
                    ),
                    InputFormat.IMAGE: PdfFormatOption(
                        pipeline_options=pipeline_options,
                        backend=PyPdfiumDocumentBackend
                    ),
                }
            )
        return CONVERTER_NO_OCR


EXTRACTOR_VERSION = "2026.09.05-pdf-text-v2"


def _extract_pymupdf_text_layer(pdf_path: str) -> dict[int, str]:
    """Extract selectable PDF text with PyMuPDF."""
    try:
        import pymupdf
    except ImportError:
        import fitz as pymupdf

    extracted: dict[int, str] = {}
    with pymupdf.open(pdf_path) as document:
        for page_number, page in enumerate(document, start=1):
            text = (page.get_text("text") or "").strip()
            if not text:
                blocks = page.get_text("blocks") or []
                text = "\n".join(
                    str(block[4]).strip()
                    for block in blocks
                    if len(block) > 4 and str(block[4]).strip()
                ).strip()
            if not text:
                words = page.get_text("words") or []
                text = " ".join(
                    str(word[4]).strip()
                    for word in words
                    if len(word) > 4 and str(word[4]).strip()
                ).strip()
            if text:
                extracted[page_number] = text
    return extracted


def _extract_pdfium_text_layer(pdf_path: str) -> dict[int, str]:
    """Extract PDF text with PDFium when pypdf cannot decode a text layer."""
    import pypdfium2

    extracted: dict[int, str] = {}
    document = pypdfium2.PdfDocument(pdf_path)
    try:
        for page_number in range(len(document)):
            page = document[page_number]
            text_page = page.get_textpage()
            try:
                text = (text_page.get_text_range() or "").strip()
            finally:
                text_page.close()
                page.close()
            if text:
                extracted[page_number + 1] = text
    finally:
        document.close()
    return extracted


def _extract_pdf_text_layer(reader: PdfReader, pdf_path: str | None = None) -> str:
    """Extract selectable PDF text without layout/OCR image placeholders."""
    page_text_by_number: dict[int, str] = {}
    if pdf_path:
        try:
            page_text_by_number.update(_extract_pymupdf_text_layer(pdf_path))
            print(f"PyMuPDF extracted text from {len(page_text_by_number)} pages.")
        except Exception as exc:
            print(f"WARNING: PyMuPDF text extraction failed: {exc}")

    # Fill pages PyMuPDF could not decode with pypdf, then PDFium as a final
    # native-engine fallback. This preserves text from mixed-content PDFs.
    for page_number, page in enumerate(reader.pages, start=1):
        if page_number in page_text_by_number:
            continue
        try:
            page_text = (page.extract_text() or "").strip()
        except Exception as exc:
            print(f"WARNING: Could not extract text from PDF page {page_number} with pypdf: {exc}")
            page_text = ""
        if page_text:
            page_text_by_number[page_number] = page_text

    if pdf_path and len(page_text_by_number) < len(reader.pages):
        try:
            pdfium_text = _extract_pdfium_text_layer(pdf_path)
            for page_number, page_text in pdfium_text.items():
                page_text_by_number.setdefault(page_number, page_text)
        except Exception as exc:
            print(f"WARNING: PDFium text fallback failed: {exc}")

    pages = [
        f"### Page {page_number}\n\n{page_text_by_number[page_number]}"
        for page_number in sorted(page_text_by_number)
    ]
    print(
        f"Selectable text extraction recovered {len(page_text_by_number)}/{len(reader.pages)} "
        f"pages ({sum(len(text) for text in page_text_by_number.values())} characters)."
    )
    return "\n\n---\n\n".join(pages)


# Worker function for process pool execution
def _docling_worker(pdf_path: str, ocr_preference: str = "adaptive") -> str:
    # Explicit OCR-off mode should preserve the PDF text layer directly. The
    # Docling layout exporter may emit an image placeholder for a page even
    # when that page contains selectable text.
    if ocr_preference.lower() in ["off", "n", "no"]:
        return _extract_pdf_text_layer(PdfReader(pdf_path), pdf_path)

    # Pass 1: Try without OCR unless force-on
    docling_no_ocr = get_docling(enable_ocr=False)
    
    # If forced on, we skip the adaptive check and just use OCR
    if ocr_preference.lower() in ["on", "o"]:
        docling_ocr = get_docling(enable_ocr=True)
        res = docling_ocr.convert(pdf_path)
        return res.document.export_to_markdown()

    res = docling_no_ocr.convert(pdf_path)
    content = res.document.export_to_markdown()

    # If forced off, we don't try OCR at all. Otherwise, check content.
    if ocr_preference.lower() in ["adaptive", "a"]:
        # Calculate meaningful text content
        total_words = len(content.split())
        # Identify lines that are page markers (e.g., "Page 1", "page 31", "P. 1", "Page-1")
        marker_lines = re.findall(r'(?i)^\s*(page|p\.?)\s*[-.]?\s*\d+\s*$', content, flags=re.MULTILINE)
        
        # Count words contributed by markers
        marker_words = sum(len(line.split()) for line in marker_lines)
        
        # Meaningful content is total minus page markers
        meaningful_words = total_words - marker_words
        
        # Simple check: If meaningful content is too short, try OCR
        if meaningful_words < 50:
            logger.info(f"Low meaningful text content found in {pdf_path} ({meaningful_words} words). Retrying with OCR...")
            docling_ocr = get_docling(enable_ocr=True)
            res = docling_ocr.convert(pdf_path)
            content = res.document.export_to_markdown()
    
    return content


def safe_write_file(file_path: Path, content: str, encoding: str = "utf-8"):
    """Writes content to a local temp file first, then moves it to the final destination to avoid network share permission issues."""
    try:
        temp_dir = Path(os.environ.get("TEMP", "/tmp"))
        temp_file = temp_dir / f"prism_{int(time.time())}_{file_path.name}"
        
        with open(temp_file, "w", encoding=encoding) as f:
            f.write(content)
        
        # Ensure target directory exists
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Move temp file to final destination (overwrite if exists)
        shutil.move(str(temp_file), str(file_path))
    except Exception as e:
        print(f"CRITICAL ERROR writing file {file_path}: {e}")
        # Final attempt: try direct write if move fails
        try:
            with open(file_path, "w", encoding=encoding) as f:
                f.write(content)
        except Exception as e2:
            print(f"FAILED direct write fallback: {e2}")

def sanitize_filename(name: str) -> str:
    """Removes invalid OS filename characters from string."""
    name = re.sub(r'[\\/*?:"<>|]', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def clean_vtt_text(vtt_text: str) -> str:
    """Cleans VTT/SRT/TTML caption files by removing timestamps, tags, and metadata."""
    if not vtt_text:
        return ""
    # Strip HTML/XML tags
    text = re.sub(r'<[^>]+>', ' ', vtt_text)
    # Strip WebVTT headers / metadata
    text = re.sub(r'WEBVTT.*?\n', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'Kind:.*?\n', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'Language:.*?\n', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'STYLE[\s\S]*?\n\n', '\n\n', text, flags=re.IGNORECASE)
    # Remove timestamps (e.g., 00:00:00.000 --> 00:00:00.000 or 00:00.000 --> 00:00.000)
    text = re.sub(r'\d{1,2}:?\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{1,2}:?\d{2}:\d{2}[\.,]\d{3}.*', '', text)
    text = re.sub(r'\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{2}:\d{2}[\.,]\d{3}.*', '', text)
    # Strip positioning attributes (e.g., align:start position:0%)
    text = re.sub(r'align:\S+|position:\S+|line:\S+|size:\S+', '', text)
    # Remove duplicate adjacent lines (common in VTT rolling captions)
    lines = text.splitlines()
    clean_lines = []
    last_line = ""
    for line in lines:
        line = line.strip()
        if not line or line.isdigit():
            continue
        if line != last_line:
            clean_lines.append(line)
            last_line = line
    
    return " ".join(clean_lines).strip()


# ==========================================
# 3. LOCAL EVALUATION & ROUTING ENGINE
# ==========================================

def inspect_text_quality(text: str) -> dict:
    """Calculates word count and punctuation density locally."""
    if not text:
        return {"words": 0, "punc_ratio": 0.0, "score": 0.0}

    words = text.split()
    total_words = len(words)
    if total_words == 0:
        return {"words": 0, "punc_ratio": 0.0, "score": 0.0}

    punctuation_count = len(re.findall(r"[.,!?]", text))
    punc_ratio = punctuation_count / total_words
    score = total_words + (punc_ratio * 300)

    return {"words": total_words, "punc_ratio": punc_ratio, "score": score}


def select_best_extract_locally(native_sub: str, whisper_sub: str) -> tuple[str, str, str]:
    """Compares Native vs Whisper extracts locally."""
    native_stats = inspect_text_quality(native_sub)
    whisper_stats = inspect_text_quality(whisper_sub)

    if native_stats["words"] == 0 and whisper_stats["words"] > 0:
        return "Whisper ASR", whisper_sub, "Native captions were empty. Selected Whisper transcript."
    if whisper_stats["words"] == 0 and native_stats["words"] > 0:
        return "yt-dlp Native", native_sub, "Whisper transcript empty. Selected Native captions."

    print("\nLocal Quality Comparison:")
    print(f"   - yt-dlp Native Captions: {native_stats['words']} words | Punc Ratio: {native_stats['punc_ratio']:.2f}")
    print(f"   - Faster-Whisper ASR:    {whisper_stats['words']} words | Punc Ratio: {whisper_stats['punc_ratio']:.2f}")

    if whisper_stats["words"] > (native_stats["words"] * 1.25) and whisper_stats["punc_ratio"] >= 0.02:
        return "Whisper ASR", whisper_sub, f"Whisper is significantly more complete ({whisper_stats['words']} vs {native_stats['words']} words)."

    if native_stats["words"] > (native_stats["words"] * 1.25) and native_stats["punc_ratio"] >= 0.02:
        return "yt-dlp Native", native_sub, f"Native captions are significantly more complete ({native_stats['words']} vs {native_stats['words']} words)."

    if native_stats["score"] >= whisper_stats["score"]:
        return "yt-dlp Native", native_sub, "Native captions selected (Higher quality score/structure)."
    else:
        return "Whisper ASR", whisper_sub, "Whisper transcript selected (Higher quality score/structure)."


# ==========================================
# 4. EXTRACTION MODULES WITH PROGRESS BARS
# ==========================================

def _install_playwright_chromium():
    """Install the browser used by the active Prism Python environment.

    Crawl4AI installs the Python Playwright package, but it does not always
    download Playwright's separately managed browser binaries. This is safe to
    run only after a launch failure and keeps the repair tied to the interpreter
    that is actually running this extractor.
    """
    print("[Crawl4AI] Chromium browser is missing. Installing it now...")
    result = subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium"],
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Playwright could not install Chromium. "
            "Run `python -m playwright install chromium` and try again."
        )


def process_web_url(url: str, item_raw_folder: Path, main_extractions_folder: Path) -> bool:
    """Crawls a web page using Crawl4AI and converts it to clean markdown."""
    print(f"Web URL detected. Routing to Crawl4AI pipeline: {url}")

    import asyncio

    async def crawl():
        config = CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            word_count_threshold=10,
            remove_overlay_elements=True,
        )
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url, config=config)
            if not result.success:
                raise ValueError(f"Crawl failed: {result.error_message}")
            page_title = result.metadata.get("title", "Web Page")
            return result.markdown, page_title

    try:
        with tqdm(total=1, desc="[Crawl4AI Web Scraping]", leave=False) as pbar:
            try:
                content, title = asyncio.run(crawl())
            except Exception as first_error:
                # A missing Playwright executable is repairable. Install once,
                # then retry the crawl before falling back to plain HTTP.
                if "Executable doesn't exist" not in str(first_error):
                    raise
                print(f"WARNING: Crawl4AI browser launch failed: {first_error}")
                _install_playwright_chromium()
                content, title = asyncio.run(crawl())
            pbar.update(1)

        if not content or not content.strip():
            raise ValueError("Crawl4AI returned empty content.")

        raw_out_file = item_raw_folder / "crawl4ai_raw.md"
        safe_write_file(raw_out_file, f"# Raw Web Crawl: {url}\n\n{content}")

        sanitized_title = sanitize_filename(title)
        master_out_file = main_extractions_folder / f"{sanitized_title}.md"
        safe_write_file(master_out_file, f"# {title}\n\n**Source URL:** {url}\n\n---\n\n{content}")
        print(f"Successfully crawled and saved: {title}")
        return True

    except Exception as e:
        print(f"ERROR: Crawl4AI failed for {url}: {e}")
        try:
            print("Falling back to simple text extraction...")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req) as response:
                html = response.read().decode("utf-8", errors="ignore")
            # Remove non-content elements before stripping tags. A response
            # containing only scripts/styles is not a valid extracted note.
            html = re.sub(r"<(script|style|noscript)[^>]*>.*?</(?:script|style|noscript)>", " ", html, flags=re.IGNORECASE | re.DOTALL)
            text = re.sub(r"<[^>]*>", " ", html)
            content = " ".join(text.split())
            if len(content) < 80:
                raise ValueError("Fallback returned too little readable text.")
            master_out_file = main_extractions_folder / f"fallback_{int(time.time())}.md"
            safe_write_file(master_out_file, f"# Fallback Web Extract\n\n**Source:** {url}\n\n---\n\n{content}")
            print(f"Fallback web extraction saved: {master_out_file}")
            return True
        except Exception as e2:
            print(f"CRITICAL: Fallback also failed: {e2}")
            return False


def transcribe_audio_whisper(audio_path: str) -> str:
    """Transcribes audio using Faster-Whisper with real-time ETA progress bar."""
    whisper = get_whisper()
    if not whisper:
        return "Audio transcription failed: Required libraries (torch/faster-whisper) not installed."
        
    try:
        segments, info = whisper.transcribe(audio_path, beam_size=1, vad_filter=True)
        
        total_duration = round(info.duration, 2)
        transcript_text = []
        last_timestamp = 0.0

        print(f"Audio Duration: {total_duration}s | Language: {info.language.upper()}")
        with tqdm(total=total_duration, unit="s", desc="[Audio Speech-to-Text]", leave=False) as pbar:
            for segment in segments:
                transcript_text.append(segment.text.strip())
                segment_length = segment.end - last_timestamp
                pbar.update(segment_length)
                last_timestamp = segment.end
            if last_timestamp < total_duration:
                pbar.update(total_duration - last_timestamp)
        
        result_text = " ".join(transcript_text).strip()
        
        if not result_text:
            print("WARNING: vad_filter=True returned no text. Retrying without VAD...")
            segments, info = whisper.transcribe(audio_path, beam_size=1, vad_filter=False)
            transcript_text = [segment.text.strip() for segment in segments]
            result_text = " ".join(transcript_text).strip()

        return result_text
    except Exception as e:
        print(f"ERROR: Whisper transcription failed: {e}")
        return ""


def process_youtube_url(video_url: str, item_raw_folder: Path, main_extractions_folder: Path, preferred_method: str = "auto"):
    """Fetches native captions and Whisper ASR transcripts, respecting user preference with fallback."""
    # Only process if it's actually a YouTube URL
    if "youtube.com" not in video_url.lower() and "youtu.be" not in video_url.lower():
        return process_web_url(video_url, item_raw_folder, main_extractions_folder)

    # Normalize preference method aliases
    preferred_method = preferred_method.lower().strip()
    if preferred_method in ["yt-dlp", "yt_dlp", "native", "captions", "caption"]:
        preferred_method = "captions"
    elif preferred_method in ["whisper", "asr", "whisper_asr"]:
        preferred_method = "whisper"
    elif preferred_method not in ["auto", "captions", "whisper"]:
        preferred_method = "auto"

    DOWNLOADS_DIR.mkdir(exist_ok=True)
    native_text = ""
    whisper_text = ""
    video_title = "YouTube Video"
    
    # Define priorities based on preference
    # "auto": native -> whisper (original logic)
    # "captions": native (primary), whisper (fallback)
    # "whisper": whisper (primary), native (fallback)
    
    # Step A: Fetch Native Captions via yt-dlp
    ydl_opts_subs = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        # Explicitly include common English variants
        "subtitleslangs": ["en.*", "en", "en-US", "en-GB", "en-orig", "en-ca"], 
        "quiet": True,
    }
    
    should_try_native = (preferred_method == "auto" or preferred_method == "captions")
    
    if should_try_native:
        try:
            with tqdm(total=1, desc="[Fetching Subtitle Stream]", leave=False) as pbar:
                with yt_dlp.YoutubeDL(ydl_opts_subs) as ydl:
                    info = ydl.extract_info(video_url, download=False)
                    video_title = info.get("title", "YouTube Video")
                    
                    # Combine manual subtitles and auto-generated ones
                    manual_subs = info.get("subtitles") or {}
                    auto_subs = info.get("automatic_captions") or {}
                    all_subs = {**auto_subs, **manual_subs}
                    
                    # Log available captions for debugging
                    available_keys = list(all_subs.keys())
                    if available_keys:
                        print(f"DEBUG: Available captions: {available_keys}")

                    # Priority: Manual English variants -> Auto English variants -> Any Manual -> Any Auto
                    # Explicitly check for en-orig as a high-priority variant
                    target_sub_key = (
                        next((k for k in manual_subs if k == "en-orig"), None) or
                        next((k for k in manual_subs if k.startswith("en")), None) or
                        next((k for k in auto_subs if k.startswith("en")), None) or
                        (next(iter(manual_subs.keys()), None) if manual_subs else None) or
                        (next(iter(auto_subs.keys()), None) if auto_subs else None)
                    )
                    target_sub = all_subs.get(target_sub_key) if target_sub_key else None
                    
                    if target_sub:
                        # Priority 1: json3 format for cleaner parsing
                        json3_url = next((fmt.get("url") for fmt in target_sub if fmt.get("ext") == "json3"), None)
                        if json3_url:
                            try:
                                req = urllib.request.urlopen(json3_url)
                                data = json.loads(req.read().decode("utf-8"))
                                parts = [
                                    seg.get("utf8", "")
                                    for event in data.get("events", []) if "segs" in event
                                    for seg in event["segs"]
                                ]
                                native_text = " ".join(parts).strip()
                            except Exception as json_err:
                                print(f"DEBUG: Failed parsing json3 captions: {json_err}")
                                native_text = ""

                        # Fallback: try vtt/srv1/ttml/srt or any available format if json3 missing or empty
                        if not native_text:
                            for fmt in target_sub:
                                fmt_url = fmt.get("url")
                                fmt_ext = fmt.get("ext", "unknown")
                                if not fmt_url:
                                    continue
                                try:
                                    print(f"DEBUG: Attempting caption fallback format ({fmt_ext})...")
                                    req = urllib.request.urlopen(fmt_url)
                                    raw_sub_data = req.read().decode("utf-8", errors="ignore")
                                    cleaned = clean_vtt_text(raw_sub_data)
                                    if cleaned:
                                        native_text = cleaned
                                        break
                                except Exception as fmt_err:
                                    print(f"DEBUG: Failed downloading format {fmt_ext}: {fmt_err}")

                pbar.update(1)
        except Exception as e:
            print(f"WARNING: Native caption stream skipped: {e}")

    # Step B: Download Audio Track and transcribe with Whisper
    audio_file = DOWNLOADS_DIR / f"temp_{int(time.time())}.mp3"
    
    should_try_whisper = (preferred_method == "auto" or preferred_method == "whisper" or (preferred_method == "captions" and not native_text))
    
    if should_try_whisper:
        pbar_dl = tqdm(total=100, unit="%", desc="[Downloading Audio Track]", leave=False)
        def yt_dlp_hook(d):
            if d['status'] == 'downloading':
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 1
                downloaded = d.get('downloaded_bytes', 0)
                percent = int((downloaded / total) * 100)
                pbar_dl.n = percent
                pbar_dl.refresh()
            elif d['status'] == 'finished':
                pbar_dl.n = 100
                pbar_dl.refresh()

        ydl_opts_audio = {
            "format": "bestaudio/best",
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
            "outtmpl": str(audio_file.with_suffix("")),
            "progress_hooks": [yt_dlp_hook],
            "quiet": True,
        }

        download_success = False
        try:
            with yt_dlp.YoutubeDL(ydl_opts_audio) as ydl:
                info = ydl.extract_info(video_url, download=True)
                if not video_title or video_title == "YouTube Video":
                    video_title = info.get("title", "YouTube Video")
            pbar_dl.close()
            whisper_text = transcribe_audio_whisper(str(audio_file))
            if audio_file.exists():
                audio_file.unlink()
            download_success = True
        except Exception as e:
            pbar_dl.close()
            print(f"WARNING: Standard MP3 download failed (FFmpeg might be missing): {e}")

        if not download_success:
            # Fallback: Download raw audio directly (FFmpeg not required)
            print("Attempting raw audio download fallback (no FFmpeg)...")
            pbar_dl_fallback = tqdm(total=100, unit="%", desc="[Downloading Audio Fallback]", leave=False)
            
            def yt_dlp_hook_fallback(d):
                if d['status'] == 'downloading':
                    total = d.get('total_bytes') or d.get('total_bytes_estimate') or 1
                    downloaded = d.get('downloaded_bytes', 0)
                    percent = int((downloaded / total) * 100)
                    pbar_dl_fallback.n = percent
                    pbar_dl_fallback.refresh()
                elif d['status'] == 'finished':
                    pbar_dl_fallback.n = 100
                    pbar_dl_fallback.refresh()

            raw_audio_file = DOWNLOADS_DIR / f"temp_raw_{int(time.time())}.%(ext)s"
            ydl_opts_raw = {
                "format": "bestaudio/best",
                "outtmpl": str(raw_audio_file),
                "progress_hooks": [yt_dlp_hook_fallback],
                "quiet": True,
            }
            try:
                with yt_dlp.YoutubeDL(ydl_opts_raw) as ydl:
                    info = ydl.extract_info(video_url, download=True)
                    if not video_title or video_title == "YouTube Video":
                        video_title = info.get("title", "YouTube Video")
                    filename = ydl.prepare_filename(info)
                pbar_dl_fallback.close()
                whisper_text = transcribe_audio_whisper(filename)
                if os.path.exists(filename):
                    os.unlink(filename)
            except Exception as e_fallback:
                pbar_dl_fallback.close()
                print(f"WARNING: Fallback Whisper pipeline also failed: {e_fallback}")

    # Step C: Local Evaluation / Winner Selection
    # If "auto", we use the original quality comparison
    if preferred_method == "auto":
        winner_name, winner_text, reason = select_best_extract_locally(native_text, whisper_text)
    elif preferred_method == "captions":
        if native_text:
            winner_name, winner_text, reason = "yt-dlp Native", native_text, "Preferred method (Captions) succeeded."
        elif whisper_text:
            winner_name, winner_text, reason = "Whisper ASR", whisper_text, "Preferred (Captions) failed, fell back to Whisper."
        else:
            winner_name, winner_text, reason = "None", "", "Both extraction methods failed."
    elif preferred_method == "whisper":
        if whisper_text:
            winner_name, winner_text, reason = "Whisper ASR", whisper_text, "Preferred method (Whisper) succeeded."
        elif native_text:
            winner_name, winner_text, reason = "yt-dlp Native", native_text, "Preferred (Whisper) failed, fell back to Captions."
        else:
            winner_name, winner_text, reason = "None", "", "Both extraction methods failed."
    else:
        # Default to "auto" logic if method is unknown or empty
        winner_name, winner_text, reason = select_best_extract_locally(native_text, whisper_text)
        reason = f"Invalid preference method '{preferred_method}', defaulted to Auto selection."

    print(f"[Local Decision]: Chosen Winner -> {winner_name} ({reason})")
    
    # Save outputs (identical to original)
    is_native_selected = "[SELECTED]" if winner_name == "yt-dlp Native" else "[NOT SELECTED]"
    is_whisper_selected = "[SELECTED]" if winner_name == "Whisper ASR" else "[NOT SELECTED]"
    
    native_out_file = item_raw_folder / f"yt_dlp_native_{is_native_selected.lower().strip('[]')}.md"
    safe_write_file(native_out_file, f"# {video_title} (yt-dlp Native Captions) {is_native_selected}\n\n{native_text or 'No native captions available.'}")
    
    whisper_out_file = item_raw_folder / f"whisper_asr_{is_whisper_selected.lower().strip('[]')}.md"
    safe_write_file(whisper_out_file, f"# {video_title} (Faster-Whisper ASR) {is_whisper_selected}\n\n{whisper_text or 'No Whisper transcript available.'}")
    
    meta_file = item_raw_folder / "extraction_meta.json"
    safe_write_file(meta_file, json.dumps({
        "title": video_title,
        "url": video_url,
        "selected_service": winner_name,
        "reason": reason,
        "timestamp": time.time()
    }, indent=2), encoding="utf-8")

    sanitized_title = sanitize_filename(video_title)
    master_out_file = main_extractions_folder / f"{sanitized_title}.md"
    safe_write_file(master_out_file,
        f"# {video_title}\n\n"
        f"{winner_text or 'No content extracted.'}"
    )

    # Sidecar metadata: keeps extraction info out of the note body so it can
    # only ever surface in the app's Note Metadata UI. Stored in a dedicated
    # "note metadata" folder inside the vault — never next to the notes.
    meta_folder = main_extractions_folder / "note metadata"
    meta_folder.mkdir(parents=True, exist_ok=True)
    meta_sidecar_file = meta_folder / f"{sanitized_title}.md.meta.json"
    safe_write_file(meta_sidecar_file, json.dumps({
        "source": video_url,
        "engine": winner_name
    }, indent=2), encoding="utf-8")


def process_local_file(file_path: str, item_raw_folder: Path, main_extractions_folder: Path, ocr_preference: str = "adaptive"):
    """Processes local documents/media via Docling or Whisper, routing cleanly."""
    path = Path(file_path).resolve()
    if not path.exists():
        print(f"ERROR: Local file does not exist: {path}")
        return

    # Audio & Video Media Extensions to Route to Faster-Whisper ASR
    media_extensions = {".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".mp4", ".mov", ".mkv", ".avi", ".webm"}
    is_media_file = path.suffix.lower() in media_extensions

    content = ""

    if is_media_file:
        # Transcribe local media with Whisper
        print(f"Media File Detected ({path.suffix.upper()}). Routing to Faster-Whisper ASR pipeline...")
        content = transcribe_audio_whisper(str(path))
        
        # Save raw to item-specific folder
        raw_out_file = item_raw_folder / "whisper_asr_raw.md"
        safe_write_file(raw_out_file, f"# Raw Whisper ASR: {path.name}\n\n{content}")
            
        # Save clean winning note
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        safe_write_file(master_out_file, 
            f"# Transcript: {path.name}\n\n"
            f"**Source File:** `{path.name}`\n"
            f"**Engine:** `Faster-Whisper ASR`\n\n"
            f"---\n\n"
            f"{content}"
        )
            
    elif path.suffix.lower() == ".pdf":
        # Safe Handling for Large PDFs
        reader = PdfReader(str(path))
        total_pages = len(reader.pages)

        ocr_disabled = ocr_preference.lower() in ["off", "n", "no"]
        if ocr_disabled:
            print("OCR disabled. Extracting the PDF's selectable text layer directly...")
            content = _extract_pdf_text_layer(reader, str(path))
            if not content.strip():
                diagnostic = (
                    "No selectable text could be decoded from this PDF with PyMuPDF, "
                    "pypdf, or PDFium. If text is visible/selectable in Preview, "
                    "rebuild and reinstall Prism so the packaged extractor is current."
                )
                print(f"ERROR: {diagnostic}")
                content = f"[PDF extraction produced no text] {diagnostic}"
        elif total_pages > 100:
            print(f"Large PDF Detected ({total_pages} pages). Processing in 50-page chunks in parallel with process timeout safety...")
            chunk_size = 50
            DOWNLOADS_DIR.mkdir(exist_ok=True)
            
            # Create all temp chunk files first
            chunk_files = []
            for start in range(0, total_pages, chunk_size):
                end = min(start + chunk_size, total_pages)
                writer = PdfWriter()
                for i in range(start, end):
                    writer.add_page(reader.pages[i])
                temp_chunk_path = DOWNLOADS_DIR / f"temp_chunk_{start}_{end}.pdf"
                with open(temp_chunk_path, "wb") as f:
                    writer.write(f)
                chunk_files.append((start, end, temp_chunk_path))
                
            # Run parallel execution using a shared ProcessPoolExecutor outside the loop
            results_dict = {}
            max_workers = min(4, len(chunk_files)) # process chunks in parallel using up to 4 worker processes
            
            with tqdm(total=total_pages, unit="page", desc="[Docling PDF Parsing]", leave=False) as pbar:
                with concurrent.futures.ProcessPoolExecutor(max_workers=max_workers) as executor:
                    # Submit all chunks to pool
                    future_to_chunk = {
                        executor.submit(_docling_worker, str(p), ocr_preference): (start, end, p)
                        for start, end, p in chunk_files
                    }
                    
                    # Gather results as they complete
                    for future in concurrent.futures.as_completed(future_to_chunk):
                        start, end, p = future_to_chunk[future]
                        chunk_md = None
                        try:
                            # 90 seconds timeout per chunk
                            chunk_md = future.result(timeout=90)
                        except concurrent.futures.TimeoutError:
                            print(f"\nWARNING: Chunk pages {start+1}-{end} timed out. Falling back to raw text extraction...")
                        except Exception as err:
                            print(f"\nWARNING: Chunk pages {start+1}-{end} failed layout conversion ({err}). Falling back to raw text extraction...")
                        
                        # Fallback if docling failed or timed out
                        if chunk_md is None:
                            fallback_text = []
                            for i in range(start, end):
                                page_text = reader.pages[i].extract_text() or ""
                                fallback_text.append(f"### Page {i+1}\n\n{page_text}")
                            chunk_md = "\n\n".join(fallback_text)
                            
                        results_dict[start] = chunk_md
                        pbar.update(end - start)
                        
                        # Cleanup temp file
                        if p.exists():
                            p.unlink()
            
            # Sort by start page to maintain order
            full_markdown = [results_dict[start] for start in sorted(results_dict.keys())]
            content = "\n\n---\n\n".join(full_markdown)
            gc.collect()
        elif total_pages <= 100:
            with tqdm(total=total_pages, unit="page", desc="[Docling PDF Parsing]", leave=False) as pbar:
                content = _docling_worker(str(path), ocr_preference=ocr_preference)
                pbar.update(total_pages)
        # Save raw to raw_service_files folder
        raw_out_file = item_raw_folder / "docling_raw.md"
        safe_write_file(raw_out_file, f"# Raw Docling Extraction: {path.name}\n\n{content}")
        
        # Save clean note to main extractions directory
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        safe_write_file(master_out_file, f"# Note: {path.stem}\n\n**Source File:** `{path.name}`\n\n{content}")

            
    else:
        # standard office files layout extraction via Docling
        with tqdm(total=1, desc=f"[Docling Parsing {path.suffix.upper()}]", leave=False) as pbar:
            enable_ocr = (ocr_preference == "on")
            docling = get_docling(enable_ocr=enable_ocr)
            if not docling:
                content = "Office conversion failed: 'docling' not installed."
            else:
                result = docling.convert(str(path))
                content = result.document.export_to_markdown()
            pbar.update(1)
            
        # Save raw to raw_service_files folder
        raw_out_file = item_raw_folder / "docling_raw.md"
        safe_write_file(raw_out_file, f"# Raw Docling Extraction: {path.name}\n\n{content}")
        
        # Save clean note to main extractions directory
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        safe_write_file(master_out_file, f"# Note: {path.stem}\n\n**Source File:** `{path.name}`\n\n{content}")



def open_file_picker() -> list[str]:
    """Opens system file explorer modal when Tk is available."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:
        raise RuntimeError(
            "The interactive file picker requires Tk. "
            "Use CLI ingestion with --files/--urls, or install a Python build with Tk support."
        ) from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)

    files = filedialog.askopenfilenames(
        title="Prism - Select Local File(s)",
        filetypes=[
            ("All Supported Files", "*.pdf *.docx *.pptx *.xlsx *.mp3 *.wav *.m4a *.mp4 *.mov *.png *.jpg *.jpeg *.html"),
            ("PDF Documents", "*.pdf"),
            ("Audio / Speech", "*.mp3 *.wav *.m4a *.flac"),
            ("Video Files", "*.mp4 *.mov *.mkv *.avi"),
            ("Office Documents", "*.docx *.pptx *.xlsx"),
            ("Images / OCR", "*.png *.jpg *.jpeg *.webp"),
            ("All Files", "*.*")
        ]
    )
    return list(files)


# ==========================================
# 5. MAIN PIPELINE ROUTER
# ==========================================

def run_prism():
    global logger
    logger = setup_logging()
    print(f"Extractor version: {EXTRACTOR_VERSION}")
    print(f"Extractor path: {Path(__file__).resolve()}")
    
    # Parse Command Line Arguments first (For automation / Prism App button integration)
    parser = argparse.ArgumentParser(description="Prism Master Extractor Pipeline")
    parser.add_argument("--vault", type=str, help="Outputs clean final notes directly to this folder")
    parser.add_argument("--files", type=str, nargs="+", help="Automated batch files processing list")
    parser.add_argument(
        "--files-from",
        type=str,
        help="JSON manifest containing local files to process (avoids command-line length limits)",
    )
    parser.add_argument("--urls", type=str, nargs="+", help="Automated batch URLs processing list")
    parser.add_argument("--yt_method", type=str, default="auto", help="YouTube extraction method: 'auto', 'captions', or 'whisper'")
    parser.add_argument("--ocr", type=str, default="adaptive", choices=["on", "off", "adaptive"], help="OCR mode: 'on', 'off', or 'adaptive' (default)")
    
    args = parser.parse_args()

    # Determine Output Directory paths
    main_extractions_folder = OUTPUT_DIR / "main_extractions"
    raw_service_folder = OUTPUT_DIR / "raw_service_files"

    if args.vault:
        # Override clean notes destination directly to Prism note vault
        main_extractions_folder = Path(args.vault).resolve()
        logger.info(f"Note vault specified! Redirecting final clean notes to: {main_extractions_folder}")

    # Ensure directories are created
    main_extractions_folder.mkdir(parents=True, exist_ok=True)
    raw_service_folder.mkdir(parents=True, exist_ok=True)

    sources = [] # Will be list of (path, ocr_mode)
    automated_mode = False
    default_ocr_pref = args.ocr

    # CLI / Automated Mode Trigger
    if args.files or args.files_from or args.urls:
        automated_mode = True
        
        # If OCR mode is passed via CLI, we need to respect it
        # Note: When called via Tauri/Rust, the OCR mode is passed via the --yt_method argument
        # because the Rust backend reuses the yt_method slot for OCR mode when ingest_type is 'file'.
        
        # Let's check args.yt_method to see if it contains an OCR override
        ocr_mode_from_args = args.yt_method if args.yt_method in ["A", "O", "N"] else args.ocr
        
        all_sources = []
        if args.files:
            all_sources.extend(args.files)
        if args.files_from:
            try:
                manifest = json.loads(Path(args.files_from).read_text(encoding="utf-8"))
                if not isinstance(manifest, list) or not all(isinstance(v, str) for v in manifest):
                    raise ValueError("expected a JSON array of strings")
                all_sources.extend(manifest)
            except (OSError, ValueError) as exc:
                print(f"ERROR: Could not read --files-from manifest: {exc}")
                raise SystemExit(2) from exc
        if args.urls:
            all_sources.extend(args.urls)
        
        # Check for OCR override in filename
        for s in all_sources:
            if "|" in s:
                path, mode = s.split("|", 1)
                sources.append((path, mode))
            else:
                sources.append((s, ocr_mode_from_args))

        logger.info(f"Batch mode activated via CLI! Loaded {len(sources)} sources to extract.")
    else:
        # Standard Interactive Terminal Menu Mode
        logger.info("\n" + "="*50)
        logger.info("PRISM UNIFIED INGESTION SYSTEM")
        logger.info("="*50)
        logger.info("OCR Mode Settings: [A] Adaptive (Default) | [O] Force OCR ON | [N] Force OCR OFF")
        ocr_mode = input("Select OCR Mode [A, O, or N]: ").strip().upper()
        ocr_pref = "adaptive" if ocr_mode == "A" else "on" if ocr_mode == "O" else "off"
        
        logger.info("\nSources:")
        logger.info("1. Select Local File(s) (Opens File Explorer)")
        logger.info("2. Process YouTube URL(s) / Web Link(s)")

        choice = input("\nSelect Option [1 or 2]: ").strip()
        print(choice)

        if choice == "1":
            logger.info("\nOpening System File Explorer...")
            files = open_file_picker()
            if not files:
                logger.warning("WARNING: No file selected. Exiting.")
                return
            for f in files:
                sources.append((f, ocr_pref))
        elif choice == "2":
            raw_urls = input("\nEnter YouTube URL(s) (comma-separated for multiple): ").strip()
            print(raw_urls)
            if raw_urls:
                for u in raw_urls.split(","):
                    if u.strip():
                        sources.append((u.strip(), ocr_pref))
            else:
                logger.warning("WARNING: No URL entered. Exiting.")
                return
        else:
            logger.error(f"ERROR: Invalid selection '{choice}'. Exiting.")
            return

    total_batch_start = time.time()
    total_items = len(sources)

    logger.info(f"\nProcessing {total_items} item(s)...")

    # Overall Batch Progress Bar
    failed_items = 0
    with tqdm(total=total_items, desc="[Batch Progress]", unit="item") as batch_pbar:
        for idx, (source, ocr_mode) in enumerate(sources, start=1):
            item_start_time = time.time()
            
            # Isolated item-specific folder inside raw service files directory
            item_raw_folder = raw_service_folder / f"item_{idx}_{int(time.time())}"
            item_raw_folder.mkdir(parents=True, exist_ok=True)

            logger.info(f"\n" + "-"*50)
            logger.info(f"Processing Item [{idx}/{total_items}]: {source}")
            logger.info(f"OCR Mode: {ocr_mode}")
            logger.info("-" * 50)

            # Route Logic
            if source.startswith("http://") or source.startswith("https://"):
                item_succeeded = process_youtube_url(source, item_raw_folder, main_extractions_folder, preferred_method=args.yt_method if args.yt_method else "auto")
            else:
                process_local_file(source, item_raw_folder, main_extractions_folder, ocr_preference=ocr_mode)
                item_succeeded = True

            if item_succeeded is False:
                failed_items += 1
                logger.error(f"Item #{idx} failed: no usable extraction was produced.")

            item_elapsed = time.time() - item_start_time
            logger.info(f"\nItem #{idx} Finished in {item_elapsed:.2f}s")
            logger.info(f"Main Clean Extraction: {main_extractions_folder.absolute()}")
            logger.info(f"Raw Service Files: {item_raw_folder.absolute()}")

            batch_pbar.update(1)

    total_elapsed = time.time() - total_batch_start
    logger.info("\n" + "="*50)
    if failed_items:
        logger.error(f"{failed_items} OF {total_items} ITEM(S) FAILED.")
    else:
        logger.info(f"ALL {total_items} ITEM(S) COMPLETED SUCCESSFULLY!")
    logger.info(f"Total Execution Time: {total_elapsed:.2f}s")
    logger.info(f"Clean Notes Folder: {main_extractions_folder.absolute()}")
    logger.info(f"Raw Services Folder: {raw_service_folder.absolute()}")
    logger.info("="*50)
    if failed_items:
        raise SystemExit(1)


if __name__ == "__main__":
    import multiprocessing
    # Required for macOS and Windows subprocess stability within PyPdfium chunk pools
    multiprocessing.set_start_method("spawn", force=True)
    multiprocessing.freeze_support()
    run_prism()
