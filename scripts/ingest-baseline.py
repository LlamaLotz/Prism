"""Capture pure legacy contracts without importing/bootstrap-installing the extractor.
Fixtures are generated text authored for this project; no user documents are read.
"""
import ast, json, pathlib, re, time
root = pathlib.Path(__file__).resolve().parents[1]
source = root / 'Extractor Final/master_extractor.py'
tree = ast.parse(source.read_text())
names = {'sanitize_filename', 'clean_vtt_text', 'inspect_text_quality'}
module = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[])
ns = {'re': re}
exec(compile(module, str(source), 'exec'), ns)
cases = {'sanitize_filename': [' A/B: C? ', 'Résumé — notes'], 'clean_vtt_text': ['WEBVTT\n\n00:00.000 --> 00:01.000\nHello world.\nHello world.\n'], 'inspect_text_quality': ['', 'One two, three!']}
results = {name: [{'input': value, 'expected': ns[name](value)} for value in values] for name, values in cases.items()}
out = root / 'src-tauri/src/ingest/tests/fixtures/legacy-contracts.json'
out.write_text(json.dumps(results, indent=2, ensure_ascii=False) + '\n')
print(out)
