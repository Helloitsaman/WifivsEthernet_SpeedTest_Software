#!/usr/bin/env python3
"""
Wired-Like Wi-Fi Lab - local server
===================================
Serves the web app in ./web and a tiny speed-test API. Standard library only.

    python server.py              # http://localhost:8080
    python server.py --port 9000

Run it on a machine plugged into the network by Ethernet. Then open the page
from any laptop/phone on the same network (the LAN address is printed below)
to measure that device's real Wi-Fi performance.

API
  GET  /api/ping                 -> tiny JSON (latency / jitter probes)
  GET  /api/download?bytes=N     -> N random bytes (download throughput)
  POST /api/upload               -> discards body, returns byte count (upload)
  POST /api/heartbeat            -> {"id","name","result"} register a device
  GET  /api/clients              -> devices seen in the last 15 s (density view)
  POST /api/trigger              -> tell every connected device to start a test together
"""

import argparse
import json
import mimetypes
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
BLOCK = os.urandom(1024 * 1024)          # 1 MiB of random data, reused for downloads
MAX_DOWNLOAD = 500 * 1024 * 1024         # 500 MiB cap per request
CLIENT_TTL = 15                          # seconds a device stays "online" after a heartbeat

clients = {}
clients_lock = threading.Lock()
group_test = {"id": 0, "at": 0.0}       # "start on all devices" signal for density tests


class Handler(BaseHTTPRequestHandler):
    server_version = "WiredLikeLab/1.0"
    protocol_version = "HTTP/1.1"

    # ---------------- helpers ----------------
    def log_message(self, fmt, *args):
        # keep the console quiet except for page loads
        if not self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self, limit=None):
        length = int(self.headers.get("Content-Length") or 0)
        if limit is not None and length > limit:
            length = limit
        remaining, total, data = length, 0, b""
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 256 * 1024))
            if not chunk:
                break
            total += len(chunk)
            remaining -= len(chunk)
            if limit is not None:
                data += chunk
        return total, data

    # ---------------- routes ----------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/ping":
            return self._json({"t": time.time()})
        if url.path == "/api/download":
            return self._download(parse_qs(url.query))
        if url.path == "/api/clients":
            return self._clients()
        return self._static(url.path)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/api/upload":
            t0 = time.perf_counter()
            n, _ = self._read_body()
            return self._json({"bytes": n, "server_seconds": time.perf_counter() - t0})
        if url.path == "/api/heartbeat":
            _, raw = self._read_body(limit=64 * 1024)
            try:
                msg = json.loads(raw or b"{}")
            except ValueError:
                return self._json({"error": "bad json"}, 400)
            cid = str(msg.get("id", ""))[:64]
            if not cid:
                return self._json({"error": "missing id"}, 400)
            with clients_lock:
                prev = clients.get(cid, {})
                clients[cid] = {
                    "id": cid,
                    "name": str(msg.get("name") or prev.get("name") or "device")[:40],
                    "ip": self.client_address[0],
                    "ua": (self.headers.get("User-Agent") or "")[:120],
                    "seen": time.time(),
                    "result": msg.get("result") or prev.get("result"),
                }
            return self._json({"ok": True, "group": group_test, "server_time": time.time()})
        if url.path == "/api/trigger":
            self._read_body(limit=1024)
            group_test["id"] += 1
            group_test["at"] = time.time() + 4.0   # everyone starts 4 s from now
            return self._json({"ok": True, "group": group_test, "server_time": time.time()})
        self._json({"error": "not found"}, 404)

    def _download(self, q):
        try:
            n = int(q.get("bytes", ["10485760"])[0])
        except ValueError:
            n = 10 * 1024 * 1024
        n = max(1, min(n, MAX_DOWNLOAD))
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(n))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        sent = 0
        try:
            while sent < n:
                chunk = BLOCK[: min(len(BLOCK), n - sent)]
                self.wfile.write(chunk)
                sent += len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client aborted the test early: normal

    def _clients(self):
        now = time.time()
        with clients_lock:
            for k in [k for k, v in clients.items() if now - v["seen"] > CLIENT_TTL]:
                del clients[k]
            data = sorted(clients.values(), key=lambda c: c["name"])
        self._json({"clients": data, "count": len(data), "server_time": now})

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._json({"error": "not found"}, 404)
        with open(full, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main():
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    p = argparse.ArgumentParser(description="Wired-Like Wi-Fi Lab server")
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--bind", default="0.0.0.0")
    a = p.parse_args()

    httpd = ThreadingHTTPServer((a.bind, a.port), Handler)
    httpd.daemon_threads = True
    print("\n  Wired-Like Wi-Fi Lab is running\n")
    print(f"  On this computer : http://localhost:{a.port}")
    for ip in lan_ips():
        print(f"  From other devices: http://{ip}:{a.port}")
    print("\n  Press Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        httpd.server_close()


if __name__ == "__main__":
    main()
