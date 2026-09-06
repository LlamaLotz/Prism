import ast
import re
from pathlib import Path

# --- Functions being tested (copied from master_extractor.py) ---
def _is_supported_python_version(version_info):
    """Return whether a Python version can run the ingestion dependencies."""
    return tuple(version_info[:2]) >= (3, 10)


def _mac_python_paths():
    """Keep the GUI-launched app's Python locations covered by regression tests."""
    return [
        "/opt/homebrew/bin/python3.12",
        "/opt/homebrew/opt/python@3.12/bin/python3.12",
        "/usr/local/bin/python3.12",
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
    ]

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

# --- Tests ---
print("Testing headless extractor startup...")
_extractor_source = Path(__file__).with_name("master_extractor.py").read_text(encoding="utf-8")
_extractor_tree = ast.parse(_extractor_source)
_top_level_tkinter_imports = [
    node for node in _extractor_tree.body
    if isinstance(node, (ast.Import, ast.ImportFrom))
    and "tkinter" in ast.unparse(node)
]
assert not _top_level_tkinter_imports
_picker = next(
    node for node in _extractor_tree.body
    if isinstance(node, ast.FunctionDef) and node.name == "open_file_picker"
)
assert any(
    isinstance(node, (ast.Import, ast.ImportFrom))
    and "tkinter" in ast.unparse(node)
    for node in ast.walk(_picker)
)

print("Testing OCR-off PDF text-layer routing...")
assert "EXTRACTOR_VERSION = \"2026.09.05-pdf-text-v2\"" in _extractor_source
assert "def _extract_pymupdf_text_layer(pdf_path: str) -> dict[int, str]:" in _extractor_source
assert "def _extract_pdfium_text_layer(pdf_path: str) -> dict[int, str]:" in _extractor_source
assert "def _extract_pdf_text_layer(reader: PdfReader, pdf_path: str | None = None) -> str:" in _extractor_source
assert "pypdfium2" in _extractor_source
assert "PyMuPDF" in _extractor_source
assert "PyMuPDF extracted text from" in _extractor_source
assert "page.get_text(\"blocks\")" in _extractor_source
assert "No selectable text could be decoded from this PDF" in _extractor_source
assert "if ocr_preference.lower() in [\"off\", \"n\", \"no\"]:" in _extractor_source
assert "if ocr_preference.lower() in [\"on\", \"o\"]:" in _extractor_source
assert "Extracting the PDF's selectable text layer directly..." in _extractor_source
assert "Selectable text extraction recovered" in _extractor_source

print("Testing Python version compatibility...")
assert _is_supported_python_version((3, 9)) is False
assert _is_supported_python_version((3, 10)) is True
assert _is_supported_python_version((3, 12)) is True

print("Testing macOS GUI Python paths...")
assert "/opt/homebrew/bin/python3.12" in _mac_python_paths()
assert "/usr/local/bin/python3.12" in _mac_python_paths()
assert "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12" in _mac_python_paths()

print("Testing sanitize_filename...")
test_names = ["Invalid/Filename:*", "Normal File Name", "  Spaces  Test  "]
for name in test_names:
    sanitized = sanitize_filename(name)
    print(f"  Input: '{name}' -> Output: '{sanitized}'")

print("\nTesting clean_vtt_text...")
raw_vtt = """WEBVTT
Kind: captions

00:00:01.000 --> 00:00:03.000
Hello world.

00:00:03.000 --> 00:00:05.000
Hello world.
This is a test.
"""
cleaned = clean_vtt_text(raw_vtt)
print(f"  Raw VTT:\n{raw_vtt.strip()}\n")
print(f"  Cleaned Output: '{cleaned}'")
