#!/usr/bin/env bash
set -e

export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing System Dependencies (FFmpeg & Tkinter)..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg python3-tk
elif command -v dnf &> /dev/null; then
    sudo dnf install -y ffmpeg python3-tkinter
elif command -v pacman &> /dev/null; then
    sudo pacman -S --noconfirm ffmpeg python-tk
fi

echo "===================================================="
echo "Python packages"
echo "===================================================="
echo "Prism keeps its Python packages in an isolated environment at"
echo "  $HOME/.prism/env"
echo "Preparing that environment now. This is a one-time download and can"
echo "take several minutes on a slow connection."
echo "===================================================="
python3 "$SCRIPT_DIR/master_extractor.py" --bootstrap-only

echo
echo "[SUCCESS] Extractor environment ready."
echo "Linux setup complete! Run: python3 master_extractor.py"
