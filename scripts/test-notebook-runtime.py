#!/usr/bin/env python3
"""Offline runtime contract smoke test; only loopback networking is used.

Run with the payload path as argv[1]. Every service uses throwaway data and
credentials. Exercises the actual packaged Python, database, API and worker.
"""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    root = Path(sys.argv[1]).resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    python = root / manifest["pythonExecutable"]
    children = []
    # A local deterministic provider exercises the actual model and media
    # pipeline without API keys, network access, or billable AI requests.
    audio_sample = subprocess.check_output([str(root / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")), "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.5", "-f", "mp3", "pipe:1"])
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            if self.path.endswith('/audio/speech'):
                self.send_response(200); self.send_header('Content-Type', 'audio/mpeg'); self.end_headers(); self.wfile.write(audio_sample); return
            if self.path.endswith('/embeddings'):
                inputs = body.get('input', ['test'])
                count = len(inputs) if isinstance(inputs, list) else 1
                result = {'object': 'list', 'model': 'smoke-embedding', 'data': [{'object': 'embedding', 'index': i, 'embedding': [0.1] * 8} for i in range(count)], 'usage': {'prompt_tokens': 1, 'total_tokens': 1}}
            else:
                prompt = json.dumps(body.get('messages', []))
                if '"segments"' in prompt.replace('\\"', '"') and '"transcript"' not in prompt.replace('\\"', '"'):
                    content = json.dumps({'segments': [{'name': 'Introduction', 'description': 'A brief test', 'size': 'short'}]})
                elif '"transcript"' in prompt.replace('\\"', '"'):
                    content = json.dumps({'transcript': [{'speaker': 'Host', 'dialogue': 'Prism runtime test.'}]})
                else:
                    content = 'Prism runtime test response.'
                result = {'id': 'chatcmpl-smoke', 'object': 'chat.completion', 'created': 1, 'model': 'smoke-chat', 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
            payload = json.dumps(result).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="prism-notebook-smoke-") as temp:
        temp = Path(temp)
        db_port, api_port = port(), port()
        password = secrets.token_hex(32)
        env = {**os.environ, "PRISM_NOTEBOOK_DATA": str(temp / "data"), "SURREAL_URL": f"ws://127.0.0.1:{db_port}/rpc", "SURREAL_USER": "prism", "SURREAL_PASS": password, "SURREAL_PASSWORD": password, "SURREAL_NAMESPACE": "open_notebook", "SURREAL_DATABASE": "open_notebook", "OPEN_NOTEBOOK_PASSWORD": password, "OPEN_NOTEBOOK_ENCRYPTION_KEY": secrets.token_hex(32), "PYTHONNOUSERSITE": "1", "CORS_ORIGINS": "tauri://localhost"}
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def request(path, body=None, method=None, authenticated=True, raw=None, content_type=None, as_text=False):
            headers = {"Authorization": f"Bearer {password}"} if authenticated else {}
            if body is not None:
                raw = json.dumps(body).encode()
                headers["Content-Type"] = "application/json"
            if content_type:
                headers["Content-Type"] = content_type
            r = urllib.request.Request(f"http://127.0.0.1:{api_port}{path}", data=raw, headers=headers, method=method)
            with opener.open(r, timeout=30) as response:
                data = response.read()
                return data.decode() if as_text else json.loads(data) if data else None

        def wait(url):
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                if any(c.poll() is not None for c in children):
                    raise RuntimeError("A bundled service exited")
                try:
                    with opener.open(url, timeout=2) as response:
                        if response.status == 200:
                            return
                except (urllib.error.URLError, TimeoutError):
                    pass
                time.sleep(.25)
            raise TimeoutError(url)

        with (temp / "services.log").open("w+") as log:
            try:
                children.append(subprocess.Popen([str(root / manifest["surrealExecutable"]), "start", "--bind", f"127.0.0.1:{db_port}", "--user", "prism", "--log", "error", f"rocksdb:{temp / 'surreal.db'}"], env=env, stdout=log, stderr=log))
                wait(f"http://127.0.0.1:{db_port}/health")
                children.append(subprocess.Popen([str(python), "-B", str(root / "launcher.py"), "api", str(api_port)], env=env, stdout=log, stderr=log))
                wait(f"http://127.0.0.1:{api_port}/health")
                children.append(subprocess.Popen([str(python), "-B", str(root / "launcher.py"), "worker"], env=env, stdout=log, stderr=log))
                time.sleep(2)
                assert all(c.poll() is None for c in children), "Worker startup failed"
                try:
                    request("/api/notebooks", authenticated=False)
                    raise AssertionError("API accepted unauthenticated request")
                except urllib.error.HTTPError as error:
                    assert error.code == 401
                notebook = request("/api/notebooks", {"name": "Runtime smoke", "description": "Temporary verification"})
                assert notebook["id"]
                assert request("/api/notebooks")[0]["name"] == "Runtime smoke"
                boundary = "PrismSmokeBoundary"
                fields = {"type": "text", "content": "Prism's packaged runtime can process a text source.", "title": "Smoke source", "notebook_id": notebook["id"], "embed": "false", "async_processing": "true"}
                multipart = "".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k, v in fields.items()) + f"--{boundary}--\r\n"
                source = request("/api/sources", raw=multipart.encode(), content_type=f"multipart/form-data; boundary={boundary}")
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    detail = request(f"/api/sources/{source['id']}")
                    if detail.get("full_text"):
                        break
                    time.sleep(1)
                else:
                    raise AssertionError(f"Worker did not ingest source: {detail}")
                assert "packaged runtime" in detail["full_text"]
                assert request("/api/capabilities") is not None
                assert isinstance(request("/api/providers"), list)
                assert isinstance(request("/api/transformations"), list)
                assert isinstance(request("/api/podcasts/episodes"), list)
                assert isinstance(request("/api/speaker-profiles"), list)
                assert isinstance(request("/api/episode-profiles"), list)
                credential = request('/api/credentials', {'name': 'Smoke provider', 'provider': 'openai', 'api_key': 'smoke-only', 'base_url': f'http://127.0.0.1:{provider.server_port}/v1', 'modalities': ['language', 'embedding', 'text_to_speech']})
                registered = {}
                for role, name in [('language', 'smoke-chat'), ('embedding', 'smoke-embedding'), ('text_to_speech', 'tts-1')]:
                    registered[role] = request('/api/models', {'name': name, 'provider': 'openai', 'type': role, 'credential': credential['id']})['id']
                request('/api/models/defaults', {'default_chat_model': registered['language'], 'default_transformation_model': registered['language'], 'default_embedding_model': registered['embedding'], 'default_text_to_speech_model': registered['text_to_speech']}, method='PUT')
                note = request('/api/notes', {'title': 'Smoke note', 'content': 'An independent note.', 'notebook_id': notebook['id']})
                request(f"/api/notes/{note['id']}", {'content': 'Updated smoke note'}, method='PUT')
                assert request(f"/api/notes/{note['id']}")['content'] == 'Updated smoke note'
                session = request('/api/chat/sessions', {'notebook_id': notebook['id'], 'title': 'Smoke chat'})
                context = request('/api/chat/context', {'notebook_id': notebook['id'], 'context_config': {'sources': {source['id']: 'full content'}, 'notes': {}}})
                chat = request('/api/chat/execute', {'session_id': session['id'], 'message': 'What is this source about?', 'context': context['context']})
                assert any('runtime test response' in m['content'] for m in chat['messages'])
                source_session = request(f"/api/sources/{source['id']}/chat/sessions", {'source_id': source['id'], 'title': 'Source smoke'})
                streamed = request(f"/api/sources/{source['id']}/chat/sessions/{source_session['id']}/messages", {'message': 'Summarize this source'}, as_text=True)
                assert 'runtime test response' in streamed and '"type": "error"' not in streamed
                assert request('/api/search', {'query': 'runtime', 'type': 'text', 'notebook_id': notebook['id']})['total_count'] > 0
                transform = request('/api/transformations', {'name': 'smoke-transform', 'title': 'Smoke', 'description': 'Smoke', 'prompt': 'Summarize the input', 'apply_default': False})
                transformed = request('/api/transformations/execute', {'transformation_id': transform['id'], 'input_text': 'Source material'})
                assert transformed['output']
                speaker = request('/api/speaker-profiles', {'name': 'smoke-speaker', 'voice_model': registered['text_to_speech'], 'speakers': [{'name': 'Host', 'voice_id': 'alloy', 'backstory': 'Test host', 'personality': 'Clear'}]})
                profile = request('/api/episode-profiles', {'name': 'smoke-episode', 'speaker_config': speaker['id'], 'outline_llm': registered['language'], 'transcript_llm': registered['language'], 'default_briefing': 'Make three short segments', 'num_segments': 3})
                podcast = request('/api/podcasts/generate', {'episode_profile': profile['name'], 'speaker_profile': speaker['name'], 'episode_name': 'Smoke podcast', 'content': 'Prism processes research locally.'})
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    rows = request('/api/podcasts/episodes')
                    episode = next((e for e in rows if e['name'] == 'Smoke podcast'), None)
                    if episode and episode.get('audio_file'):
                        break
                    if episode and episode.get('job_status') == 'failed':
                        raise AssertionError(f"Podcast failed: {episode.get('error_message')}")
                    time.sleep(1)
                else:
                    raise AssertionError(f"Podcast did not produce audio: {podcast}")
                audio_request = urllib.request.Request(f"http://127.0.0.1:{api_port}/api/podcasts/episodes/{episode['id']}/audio", headers={'Authorization': f'Bearer {password}'})
                with opener.open(audio_request, timeout=10) as response:
                    assert len(response.read()) > 100
                jobs = request('/api/commands/jobs')
                assert jobs and any(j['command_name'] == 'generate_podcast' for j in jobs), 'Job list must query the real queue'
                assert request('/api/commands/jobs?status_filter=failed') == []
                request('/api/prism/drain', {}, method='POST')
                children[-1].wait(timeout=20)
                # Queued work remains cancelable after the worker drains.
                queued = request('/api/embed', {'item_id': source['id'], 'item_type': 'source', 'async_processing': True})
                cancelled = request(f"/api/commands/jobs/{queued['command_id']}", method='DELETE')
                assert cancelled['cancelled']
                assert request('/api/commands/jobs?status_filter=canceled')
                schema = request("/openapi.json")
                (root / "openapi.json").write_text(json.dumps(schema, indent=2) + "\n")
                request(f"/api/notebooks/{notebook['id']}", method="DELETE")
                (root / 'smoke-tested.json').write_text(json.dumps({'revision': manifest['revision'], 'target': manifest['target'], 'provider': 'local deterministic fixture', 'checks': ['startup', 'authentication', 'ingestion', 'notes', 'chat', 'transformations', 'podcast-audio', 'jobs', 'drain', 'cancellation']}, indent=2) + '\n')
                print("PASS: packaged database, API, authentication, migrations, worker ingestion, notes, chat, transformations, podcast audio, job status, drain and cancellation (local provider fixture)")
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-12000:].replace(password, "[redacted]"), file=sys.stderr)
                raise
            finally:
                for child in reversed(children):
                    if child.poll() is not None:
                        continue
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                provider.shutdown()


if __name__ == "__main__":
    main()
