"""Fixed-fixture PDF baseline. Runs legacy functions without bootstrap or model installs.
Run with ~/.prism/env/bin/python; pass a release-built worker for performance gates.
The first run is recorded separately; subsequent runs report a warm median.
"""
import argparse, ast, contextlib, hashlib, io, json, pathlib, statistics, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--worker', type=pathlib.Path, required=True)
p.add_argument('--runs', type=int, default=5)
p.add_argument('--output', type=pathlib.Path, required=True)
p.add_argument('--enforce', action='store_true')
a = p.parse_args()
fixture = ROOT / 'src-tauri/src/ingest/tests/fixtures/text-150.pdf'
from pypdf import PdfReader
source = ROOT / 'Extractor Final/master_extractor.py'
tree = ast.parse(source.read_text())
names = {'_extract_pdf_text_layer', '_extract_pymupdf_text_layer', '_extract_pdfium_text_layer'}
ns = {'PdfReader': PdfReader}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[]), str(source), 'exec'), ns)
legacy, native = [], []
with tempfile.TemporaryDirectory() as temp:
    vault = pathlib.Path(temp)/'vault'
    for i in range(max(2,a.runs)):
        start=time.perf_counter()
        with contextlib.redirect_stdout(io.StringIO()):
            text=ns['_extract_pdf_text_layer'](PdfReader(str(fixture)),str(fixture))
        legacy.append(time.perf_counter()-start)
        start=time.perf_counter()
        proc=subprocess.run([str(a.worker.resolve()),'--files',str(fixture),'--ocr','off','--no-fallback','--vault',str(vault)],capture_output=True,text=True)
        if proc.returncode:
            raise SystemExit(proc.stdout+proc.stderr)
        native.append(time.perf_counter()-start)
    extracted=(vault/'text-150.md').read_text()
    assert all(f'Prism fixture page {page}.' in extracted for page in range(1,151))
result={'fixture_sha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'legacy_seconds':legacy,'native_seconds':native,'warm_speedup':statistics.median(legacy[1:])/statistics.median(native[1:]),'note':'Legacy measurements exclude Python bootstrap/import time. Native measurements include worker startup. RSS and disk profiling require the platform benchmark runner.'}
a.output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
if a.enforce and result['warm_speedup']<3:
    raise SystemExit('PDF speed gate failed; keep release opt-in')
