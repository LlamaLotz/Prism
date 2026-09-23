"""Transport-policy unit tests, using the bundled Python and no network.
Usage: python3 scripts/test-prism-gateway.py <runtime-directory>
"""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'manifest.json').read_text())
code = r'''
import base64
import json
import socket
import subprocess
import httpx
import requests
calls = []
def denied(client, request, **kwargs):
    calls.append(request)
    assert str(request.url) == 'http://127.0.0.1:9999/proxy'
    assert request.headers['Authorization'] == 'Bearer fixture-token'
    payload = json.loads(request.content)
    assert payload['url'].startswith('https://fixture.invalid')
    return httpx.Response(403, json={'error': 'Strict Local blocks external processing'}, request=request)
async def adenied(client, request, **kwargs):
    return denied(client, request, **kwargs)
httpx.Client.send = denied
httpx.AsyncClient.send = adenied
from prism_gateway import install
install()
for operation in [
    lambda: httpx.post('https://fixture.invalid/chat', json={'content':'private note'}),
    lambda: requests.post('https://fixture.invalid/speech', json={'text':'private note'}),
    lambda: socket.getaddrinfo('fixture.invalid', 443),
    lambda: socket.socket().connect(('192.0.2.1',443)),
    lambda: socket.socket().connect_ex(('192.0.2.1',443)),
    lambda: subprocess.Popen(['curl','https://fixture.invalid']),
    lambda: subprocess.Popen('curl https://fixture.invalid', shell=True),
]:
    try: operation()
    except PermissionError: pass
    else: raise AssertionError('Expected the policy to reject this operation')
import asyncio
async def async_case():
    async with httpx.AsyncClient() as client:
        try: await client.post('https://fixture.invalid/embeddings',json={'input':'private note'})
        except PermissionError: return
        raise AssertionError('Async transport bypassed the gateway')
asyncio.run(async_case())
assert len(calls)==3
for call in calls:
    payload=json.loads(call.content)
    assert b'private note' in base64.b64decode(payload['body'])
print('PASS: sync/async HTTP, requests, DNS, sockets and subprocesses enforce gateway policy')
'''
env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(root/'lib'),str(root)]),
       'PYTHONDONTWRITEBYTECODE':'1','PRISM_MODEL_GATEWAY':'http://127.0.0.1:9999/proxy',
       'PRISM_MODEL_GATEWAY_TOKEN':'fixture-token','PRISM_LOCAL_PORTS':'9999'}
subprocess.run([str(root/manifest['pythonExecutable']), '-c', code],env=env,check=True)
