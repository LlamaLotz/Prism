"""Route packaged Notebook HTTP clients through Prism's authenticated gateway.

Installed before importing upstream. Unknown network clients fail closed. Local
SurrealDB/API sockets are explicitly allowlisted by the native supervisor.
"""
import base64
import json
import os
import socket
import urllib.parse


def install():
    endpoint = os.environ.get("PRISM_MODEL_GATEWAY")
    token = os.environ.get("PRISM_MODEL_GATEWAY_TOKEN")
    if not endpoint or not token:
        raise RuntimeError("Prism model gateway is required")
    allowed = {int(p) for p in os.environ["PRISM_LOCAL_PORTS"].split(",")}
    gateway = urllib.parse.urlsplit(endpoint)
    allowed.add(gateway.port)

    def local(host, port):
        return host in ("127.0.0.1", "localhost", "::1") and int(port or 0) in allowed

    original_lookup = socket.getaddrinfo
    def lookup(host, port, *args, **kwargs):
        if not local(host, port):
            raise PermissionError("Notebook DNS requests must use Prism's gateway")
        return original_lookup(host, port, *args, **kwargs)
    socket.getaddrinfo = lookup
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    def connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6) and not local(address[0], address[1]):
            raise PermissionError("Notebook network requests must use Prism's gateway")
        return original_connect(sock, address)
    def connect_ex(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6) and not local(address[0], address[1]):
            raise PermissionError("Notebook network requests must use Prism's gateway")
        return original_connect_ex(sock, address)
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex

    import subprocess
    original_popen = subprocess.Popen
    def popen(args, *positional, **kwargs):
        if kwargs.get("shell") or isinstance(args, (str, bytes)):
            raise PermissionError("Notebook shell execution is disabled")
        name = os.path.basename(str(args[0])).lower().removesuffix(".exe")
        if name.startswith("ffmpeg") or name == "ffprobe":
            # A playlist may contain remote URLs even when its own path is local.
            args = [args[0], "-protocol_whitelist", "file,pipe,fd", *args[1:]]
        elif name not in ("uname", "tesseract", "pdftotext", "pdftoppm"):
            raise PermissionError(f"Notebook subprocess is not approved: {name}")
        return original_popen(args, *positional, **kwargs)
    subprocess.Popen = popen

    import httpx
    sync_send = httpx.Client.send
    async_send = httpx.AsyncClient.send

    def payload(url, method, headers, body):
        return {"url": str(url), "method": method, "headers": list(headers),
                "body": base64.b64encode(body).decode("ascii")}

    def decoded(response, request):
        if response.status_code != 200:
            raise PermissionError("Prism blocked this request: " + response.text[:300])
        value = response.json()
        # The gateway materializes the body; stale wire encodings must not be reused.
        headers = [(k, v) for k, v in value["headers"] if k.lower() not in
                   ("transfer-encoding", "content-length")]
        return httpx.Response(value["status"], headers=headers,
                              content=base64.b64decode(value["body"]), request=request)

    def send(client, request, **kwargs):
        if local(request.url.host, request.url.port):
            return sync_send(client, request, **kwargs)
        body = request.read()
        with httpx.Client(trust_env=False, timeout=660) as proxy:
            req = proxy.build_request("POST", endpoint, headers={"Authorization": f"Bearer {token}"},
                                      json=payload(request.url, request.method, request.headers.multi_items(), body))
            response = sync_send(proxy, req)
            return decoded(response, request)

    async def asend(client, request, **kwargs):
        if local(request.url.host, request.url.port):
            return await async_send(client, request, **kwargs)
        body = await request.aread()
        async with httpx.AsyncClient(trust_env=False, timeout=660) as proxy:
            req = proxy.build_request("POST", endpoint, headers={"Authorization": f"Bearer {token}"},
                                      json=payload(request.url, request.method, request.headers.multi_items(), body))
            response = await async_send(proxy, req)
            return decoded(response, request)

    httpx.Client.send = send
    httpx.AsyncClient.send = asend

    try:
        import requests
    except ImportError:
        return
    original = requests.Session.send
    def requests_send(session, request, **kwargs):
        url = urllib.parse.urlsplit(request.url)
        if local(url.hostname, url.port):
            return original(session, request, **kwargs)
        body = request.body or b""
        if hasattr(body, "read"):
            body = body.read()
        if isinstance(body, str):
            body = body.encode()
        with httpx.Client(trust_env=False, timeout=660) as proxy:
            req = proxy.build_request("POST", endpoint, headers={"Authorization": f"Bearer {token}"},
                                      json=payload(request.url, request.method, request.headers.items(), body))
            value = sync_send(proxy, req)
        response = decoded(value, httpx.Request(request.method, request.url))
        result = requests.Response()
        result.status_code = response.status_code
        result._content = response.content
        result.headers.update(response.headers)
        result.url = request.url
        result.request = request
        return result
    requests.Session.send = requests_send
