#!/usr/bin/env bash
set -euo pipefail

echo "===================================================="
echo "PRISM EXTRACTOR INSTALLER - macOS"
echo "===================================================="

# Finder-launched Tauri apps do not inherit the user's shell PATH. Resolve
# Homebrew from its standard Apple Silicon and Intel locations explicitly.
if [ -x "/opt/homebrew/bin/brew" ]; then
    BREW_BIN="/opt/homebrew/bin/brew"
elif [ -x "/usr/local/bin/brew" ]; then
    BREW_BIN="/usr/local/bin/brew"
elif command -v brew >/dev/null 2>&1; then
    BREW_BIN="$(command -v brew)"
else
    echo "Homebrew not found. Installing Homebrew..."
    if ! command -v curl >/dev/null 2>&1; then
        echo "ERROR: curl is required to install Homebrew."
        exit 1
    fi

    # Homebrew may request the administrator password through macOS during the
    # install. NONINTERACTIVE prevents the script from waiting on optional
    # prompts while still allowing the required sudo authorization.
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    if [ -x "/opt/homebrew/bin/brew" ]; then
        BREW_BIN="/opt/homebrew/bin/brew"
    elif [ -x "/usr/local/bin/brew" ]; then
        BREW_BIN="/usr/local/bin/brew"
    else
        echo "ERROR: Homebrew installation completed but brew could not be located."
        exit 1
    fi
fi

BREW_PREFIX="$($BREW_BIN --prefix)"
export PATH="$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$PATH"

echo "Using Homebrew: $BREW_BIN"
echo "Installing FFmpeg and Python 3.12..."
"$BREW_BIN" install ffmpeg python@3.12

PYTHON_BIN="$($BREW_BIN --prefix python@3.12)/bin/python3.12"
if [ ! -x "$PYTHON_BIN" ]; then
    echo "ERROR: Python 3.12 was installed but could not be found at: $PYTHON_BIN"
    exit 1
fi

PYTHON_VERSION="$($PYTHON_BIN --version 2>&1)"
case "$PYTHON_VERSION" in
    "Python 3.12."*) ;;
    *)
        echo "ERROR: Expected Python 3.12, found: $PYTHON_VERSION"
        exit 1
        ;;
esac

echo "Using $PYTHON_VERSION at $PYTHON_BIN"
echo "Configuring Rust targets for universal macOS builds (Intel + Apple Silicon)..."
if command -v rustup >/dev/null 2>&1; then
    rustup target add aarch64-apple-darwin x86_64-apple-darwin 2>/dev/null || true
fi

echo "Installing Python libraries..."
"$PYTHON_BIN" -m pip install --break-system-packages --upgrade \
    yt-dlp \
    faster-whisper \
    torch \
    crawl4ai \
    docling \
    omniroute \
    tqdm

echo "Setting up Playwright for Crawl4AI..."
"$PYTHON_BIN" -m playwright install chromium

echo "macOS setup complete. The extractor will use Python 3.12 automatically."
