"""Build and stage the standalone worker. Release assets must come from a pinned lock.

The lock is a JSON object with target and assets. Each asset specifies source (a
local file or HTTPS URL), path relative to runtime, sha256, and license. Archives
must be expanded and pinned per file before use; this script never blindly extracts.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tempfile, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--release', action='store_true')
parser.add_argument('--target')
parser.add_argument('--assets-lock', type=pathlib.Path)
parser.add_argument('--features', default='pdfium,ml,browser')
args = parser.parse_args()
target = args.target or subprocess.check_output(['rustc', '-vV'], text=True).split('host: ')[1].splitlines()[0]
manifest = ROOT / 'src-tauri/src/ingest/Cargo.toml'
command = ['cargo', 'build', '--locked', '--manifest-path', str(manifest), '--features', args.features]
if args.release:
    command.append('--release')
if args.target:
    command += ['--target', args.target]
subprocess.run(command, check=True)
if not args.release and not args.assets_lock:
    raise SystemExit(0)
if not args.assets_lock:
    raise SystemExit('Release staging requires --assets-lock; release gate remains closed.')
lock = json.loads(args.assets_lock.read_text())
if lock['target'] != target:
    raise SystemExit('Asset target does not match worker target')
parent = ROOT / 'src-tauri'
with tempfile.TemporaryDirectory(prefix='ingest-stage-', dir=parent) as temp:
    stage = pathlib.Path(temp)
    entries = []
    for asset in lock['assets']:
        relative = pathlib.PurePosixPath(asset['path'])
        if relative.is_absolute() or '..' in relative.parts or not asset.get('license') or len(asset['sha256']) != 64:
            raise SystemExit('Invalid pinned asset entry')
        destination = stage / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        source = asset['source']
        if source.startswith('https://'):
            with urllib.request.urlopen(source, timeout=60) as response, destination.open('wb') as output:
                shutil.copyfileobj(response, output)
        else:
            shutil.copyfile(args.assets_lock.parent / source, destination)
        digest = hashlib.file_digest(destination.open('rb'), 'sha256').hexdigest()
        if digest != asset['sha256']:
            raise SystemExit(f'Checksum mismatch: {relative}')
        if relative.parts[0] == 'bin':
            destination.chmod(0o755)
        entries.append({k: asset[k] for k in ('path', 'sha256', 'license')})
    suffix = '.exe' if 'windows' in target else ''
    required = {f'bin/{name}{suffix}' for name in ('yt-dlp', 'ffmpeg', 'tesseract', 'chromium')}
    required |= {'models/ggml-small-q8_0.bin', 'models/ggml-silero-v5.1.2.bin', 'models/eng.traineddata'}
    if 'metal' in args.features or 'cuda' in args.features:
        required.add('models/ggml-small.bin')
    supplied = {entry['path'] for entry in entries}
    if not required <= supplied or not any('pdfium' in p for p in supplied):
        raise SystemExit(f'Runtime incomplete: missing binaries/PDFium: {required - supplied}')
    build = manifest.parent / 'target'
    if args.target:
        build /= args.target
    worker = build / ('release' if args.release else 'debug') / f'prism-ingest{suffix}'
    dest = stage / 'bin' / worker.name
    dest.parent.mkdir(exist_ok=True)
    shutil.copy2(worker, dest)
    entries.append({'path': f'bin/{worker.name}', 'sha256': hashlib.file_digest(dest.open('rb'), 'sha256').hexdigest(), 'license': 'Project license'})
    (stage / 'THIRD_PARTY_NOTICES.txt').write_text('\n\n'.join(f"{entry['path']}\n{entry['license']}" for entry in entries))
    (stage / 'manifest.json').write_text(json.dumps({'version': 1, 'target': target, 'assets': entries}, indent=2) + '\n')
    output = parent / 'ingest-runtime'
    if output.exists():
        raise SystemExit(f'{output} already exists; move it aside before staging a new verified runtime')
    shutil.copytree(stage, output)
print(output)
