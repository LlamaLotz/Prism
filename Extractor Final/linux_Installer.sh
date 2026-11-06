#!/usr/bin/env bash
set -e

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
echo "The extractor creates and populates it automatically on the first"
echo "ingestion run, using Python 3.10+ installed on this system. This keeps"
echo "the system Python untouched and avoids version conflicts."
echo

echo "Linux setup complete! Run: python3 master_extractor.py"
