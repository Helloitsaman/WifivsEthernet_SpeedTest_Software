#!/usr/bin/env python3
"""
wifi_perf.py - Enterprise Wi-Fi "wired-like" performance tester
=================================================================
Measures the three things the research focuses on:
  1. Wired-like performance  -> throughput, latency, p95/p99 (worst-case) latency
  2. High-density connectivity -> N concurrent clients/flows, per-flow fairness
  3. Jitter                    -> RFC 3550 jitter + mean |ΔRTT| + packet loss

Pure Python standard library (no installs). Run the SERVER on a wired machine
(ideally plugged into the same switch as the AP), and the CLIENT on the device(s)
under test (laptop on Ethernet, then the same laptop on Wi-Fi).

USAGE
-----
  # On the wired server machine:
  python wifi_perf.py server

  # On the client (wired first, then Wi-Fi, same command, different --label):
  python wifi_perf.py client --host 192.168.1.10 --test all --label wired
  python wifi_perf.py client --host 192.168.1.10 --test all --label wifi

  # Density test: 20 parallel clients/flows with background TCP load
  python wifi_perf.py client --host 192.168.1.10 --test density --clients 20 --label wifi

  # Compare the two runs -> "wired-likeness" score
  python wifi_perf.py compare results_wired.json results_wifi.json

Tests:
  tcp      - TCP throughput (upload & download), multiple parallel streams
  udp      - UDP latency / jitter / loss at a fixed packet rate (VoIP-like: 50 pps)
  loaded   - UDP latency measured WHILE a TCP flood runs (bufferbloat / latency under load)
  density  - N concurrent UDP flows (simulated stations) + background TCP -> fairness, worst-case
  all      - tcp + udp + loaded
"""

import argparse
import json
import math
import os
import socket
import statistics
import struct
import sys
import threading
import time
from datetime import datetime

TCP_PORT = 5201
UDP_PORT = 5202
CHUNK = 128 * 1024
# UDP probe header: magic(4) flow_id(4) seq(8) send_ns(8)
HDR = struct.Struct("!IIqq")
MAGIC = 0x57465046  # "WFPF"


# --------------------------------------------------------------------------- #
# Server
# --------------------------------------------------------------------------- #
def tcp_client_handler(conn: socket.socket, addr):
    """First byte from client selects direction: 'U' = client uploads, 'D' = client downloads."""
    try:
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        mode = conn.recv(1)
        if mode == b"U":
            while conn.recv(CHUNK):
                pass
        elif mode == b"D":
            dur = struct.unpack("!d", _recv_exact(conn, 8))[0]
            buf = os.urandom(CHUNK)
            end = time.monotonic() + dur
            while time.monotonic() < end:
                conn.sendall(buf)
    except (ConnectionError, OSError):
        pass
    finally:
        conn.close()


def _recv_exact(conn, n):
    data = b""
    while len(data) < n:
        part = conn.recv(n - len(data))
        if not part:
            raise ConnectionError("closed")
        data += part
    return data


def run_tcp_server(bind):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((bind, TCP_PORT))
    srv.listen(256)
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=tcp_client_handler, args=(conn, addr), daemon=True).start()


def run_udp_echo(bind):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    s.bind((bind, UDP_PORT))
    while True:
        data, addr = s.recvfrom(65535)
        if len(data) >= HDR.size and HDR.unpack_from(data)[0] == MAGIC:
            s.sendto(data, addr)  # echo unchanged -> client computes RTT


def server(args):
    print(f"[server] TCP throughput on :{TCP_PORT}, UDP echo on :{UDP_PORT}  (Ctrl+C to stop)")
    threading.Thread(target=run_tcp_server, args=(args.bind,), daemon=True).start()
    threading.Thread(target=run_udp_echo, args=(args.bind,), daemon=True).start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n[server] stopped")


# --------------------------------------------------------------------------- #
# Client: TCP throughput
# --------------------------------------------------------------------------- #
def _tcp_stream(host, direction, duration, result, idx):
    total = 0
    try:
        s = socket.create_connection((host, TCP_PORT), timeout=10)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        s.sendall(direction)
        t0 = time.monotonic()
        if direction == b"U":
            buf = os.urandom(CHUNK)
            end = t0 + duration
            while time.monotonic() < end:
                s.sendall(buf)
                total += len(buf)
        else:
            s.sendall(struct.pack("!d", duration))
            s.settimeout(duration + 5)
            while True:
                d = s.recv(CHUNK)
                if not d:
                    break
                total += len(d)
        elapsed = time.monotonic() - t0
        s.close()
    except OSError as e:
        print(f"  [tcp stream {idx}] error: {e}")
        elapsed = duration
    result[idx] = (total, elapsed)


def tcp_throughput(host, direction, duration, streams):
    result = [None] * streams
    threads = [threading.Thread(target=_tcp_stream, args=(host, direction, duration, result, i))
               for i in range(streams)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    per_stream = [(b * 8 / e / 1e6) if e > 0 else 0 for b, e in result if result]
    return {
        "direction": "upload" if direction == b"U" else "download",
        "streams": streams,
        "total_mbps": round(sum(per_stream), 2),
        "per_stream_mbps": [round(x, 2) for x in per_stream],
        "jain_fairness": round(jain(per_stream), 4),
    }


# --------------------------------------------------------------------------- #
# Client: UDP latency / jitter / loss
# --------------------------------------------------------------------------- #
def udp_probe(host, duration, pps, payload, flow_id=0):
    """Send `pps` packets/s for `duration`s, measure RTT for each echoed packet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    s.settimeout(0.001)
    payload = max(payload, HDR.size)
    pad = b"\x00" * (payload - HDR.size)
    interval = 1.0 / pps
    rtts = {}          # seq -> rtt_ms
    sent = 0
    start = time.monotonic()
    next_send = start
    end = start + duration

    def drain():
        while True:
            try:
                data, _ = s.recvfrom(65535)
            except (socket.timeout, BlockingIOError):
                return
            except OSError:
                return
            if len(data) < HDR.size:
                continue
            magic, fid, seq, t_ns = HDR.unpack_from(data)
            if magic == MAGIC and fid == flow_id:
                rtts[seq] = (time.monotonic_ns() - t_ns) / 1e6

    while time.monotonic() < end:
        now = time.monotonic()
        if now >= next_send:
            pkt = HDR.pack(MAGIC, flow_id, sent, time.monotonic_ns()) + pad
            try:
                s.sendto(pkt, (host, UDP_PORT))
            except OSError:
                pass
            sent += 1
            next_send += interval
        drain()
    # grace period for late packets
    grace_end = time.monotonic() + 1.0
    while time.monotonic() < grace_end:
        drain()
    s.close()
    return summarize_rtts(rtts, sent)


def summarize_rtts(rtts: dict, sent: int):
    if not rtts:
        return {"sent": sent, "received": 0, "loss_pct": 100.0}
    ordered = [rtts[k] for k in sorted(rtts)]
    # RFC 3550 interarrival jitter estimator (applied to RTT variation)
    j = 0.0
    for a, b in zip(ordered, ordered[1:]):
        j += (abs(b - a) - j) / 16.0
    diffs = [abs(b - a) for a, b in zip(ordered, ordered[1:])] or [0.0]
    srt = sorted(ordered)
    return {
        "sent": sent,
        "received": len(ordered),
        "loss_pct": round(100 * (sent - len(ordered)) / sent, 3) if sent else 0,
        "rtt_min_ms": round(srt[0], 3),
        "rtt_avg_ms": round(statistics.mean(srt), 3),
        "rtt_p50_ms": round(pct(srt, 50), 3),
        "rtt_p95_ms": round(pct(srt, 95), 3),
        "rtt_p99_ms": round(pct(srt, 99), 3),
        "rtt_max_ms": round(srt[-1], 3),
        "rtt_stdev_ms": round(statistics.pstdev(srt), 3),
        "jitter_rfc3550_ms": round(j, 3),
        "jitter_mean_abs_delta_ms": round(statistics.mean(diffs), 3),
    }


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    k = (len(sorted_vals) - 1) * p / 100
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def jain(xs):
    """Jain's fairness index: 1.0 = perfectly fair share among flows/stations."""
    xs = [x for x in xs if x is not None]
    if not xs or sum(xs) == 0:
        return 0.0
    return sum(xs) ** 2 / (len(xs) * sum(x * x for x in xs))


def background_tcp(host, duration, streams):
    """TCP flood in background threads (both directions) to load the link."""
    threads = []
    for i in range(streams):
        d = b"U" if i % 2 == 0 else b"D"
        threads.append(threading.Thread(target=_tcp_stream,
                                        args=(host, d, duration, [None] * streams, i),
                                        daemon=True))
    for t in threads:
        t.start()
    return threads


def print_block(title, d):
    print(f"\n== {title} ==")
    for k, v in d.items():
        if isinstance(v, list) and len(v) > 8:
            v = f"{v[:8]} ... ({len(v)} items)"
        print(f"  {k:28s}: {v}")


# --------------------------------------------------------------------------- #
# Test runners
# --------------------------------------------------------------------------- #
def test_tcp(a):
    print(f"[tcp] {a.duration}s, {a.streams} stream(s) each direction ...")
    up = tcp_throughput(a.host, b"U", a.duration, a.streams)
    print_block("TCP upload", up)
    down = tcp_throughput(a.host, b"D", a.duration, a.streams)
    print_block("TCP download", down)
    return {"tcp_upload": up, "tcp_download": down}


def test_udp(a):
    print(f"[udp] idle latency/jitter: {a.pps} pps x {a.payload} B for {a.duration}s ...")
    r = udp_probe(a.host, a.duration, a.pps, a.payload)
    print_block("UDP idle latency / jitter", r)
    return {"udp_idle": r}


def test_loaded(a):
    print(f"[loaded] latency/jitter under {a.streams * 2} background TCP streams ...")
    bg = background_tcp(a.host, a.duration + 2, a.streams * 2)
    time.sleep(1.5)  # let TCP ramp up and fill queues
    r = udp_probe(a.host, a.duration, a.pps, a.payload)
    for t in bg:
        t.join(timeout=a.duration + 10)
    print_block("UDP latency UNDER LOAD", r)
    return {"udp_loaded": r}


def test_density(a):
    n = a.clients
    print(f"[density] {n} concurrent flows (simulated stations) + {a.bg_streams} bg TCP streams ...")
    results = [None] * n

    def flow(i):
        results[i] = udp_probe(a.host, a.duration, a.pps, a.payload, flow_id=i + 1)

    bg = background_tcp(a.host, a.duration + 2, a.bg_streams) if a.bg_streams else []
    if bg:
        time.sleep(1.5)
    threads = [threading.Thread(target=flow, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for t in bg:
        t.join(timeout=a.duration + 10)

    ok = [r for r in results if r and r.get("received")]
    delivered = [r["received"] / r["sent"] for r in results if r and r["sent"]]
    agg = {
        "flows": n,
        "flows_with_data": len(ok),
        "avg_loss_pct": round(statistics.mean(r["loss_pct"] for r in results), 3),
        "worst_flow_loss_pct": round(max(r["loss_pct"] for r in results), 3),
        "avg_p50_ms": round(statistics.mean(r["rtt_p50_ms"] for r in ok), 3) if ok else None,
        "worst_flow_p99_ms": round(max(r["rtt_p99_ms"] for r in ok), 3) if ok else None,
        "avg_jitter_ms": round(statistics.mean(r["jitter_rfc3550_ms"] for r in ok), 3) if ok else None,
        "worst_flow_jitter_ms": round(max(r["jitter_rfc3550_ms"] for r in ok), 3) if ok else None,
        "delivery_fairness_jain": round(jain(delivered), 4),
        "per_flow_p99_ms": [r.get("rtt_p99_ms") for r in results],
    }
    print_block(f"DENSITY ({n} flows)", agg)
    return {"density": agg, "density_per_flow": results}


def client(a):
    meta = {"label": a.label, "host": a.host, "timestamp": datetime.now().isoformat(),
            "hostname": socket.gethostname(), "params": {k: v for k, v in vars(a).items()
                                                         if k not in ("func",)}}
    out = {"meta": meta}
    tests = {"tcp": [test_tcp], "udp": [test_udp], "loaded": [test_loaded],
             "density": [test_density], "all": [test_tcp, test_udp, test_loaded]}[a.test]
    for fn in tests:
        out.update(fn(a))
    fname = a.out or f"results_{a.label}.json"
    with open(fname, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n[saved] {fname}")
    verdict(out)


# --------------------------------------------------------------------------- #
# Verdict vs. targets (from the low-latency Wi-Fi literature)
# --------------------------------------------------------------------------- #
TARGETS = {  # use case: (max latency ms, max jitter ms, max loss %)
    "VoIP / video calls": (150, 30, 1.0),
    "Cloud gaming": (50, 10, 0.1),
    "VR / AR": (20, 5, 0.1),
    "Industrial automation": (10, 1, 0.01),
}


def verdict(out):
    r = out.get("udp_loaded") or out.get("udp_idle")
    if out.get("density"):
        d = out["density"]
        r = {"rtt_p99_ms": d["worst_flow_p99_ms"], "jitter_rfc3550_ms": d["worst_flow_jitter_ms"],
             "loss_pct": d["worst_flow_loss_pct"]}
    if not r or r.get("rtt_p99_ms") is None:
        return
    print("\n== Use-case readiness (p99 RTT / jitter / loss, worst case measured) ==")
    for name, (lat, jit, loss) in TARGETS.items():
        ok = r["rtt_p99_ms"] <= lat and r["jitter_rfc3550_ms"] <= jit and r["loss_pct"] <= loss
        print(f"  {name:24s}: {'PASS' if ok else 'FAIL'}  "
              f"(target ≤{lat} ms, ≤{jit} ms jitter, ≤{loss}% loss)")


# --------------------------------------------------------------------------- #
# Compare wired vs wireless runs
# --------------------------------------------------------------------------- #
def compare(a):
    w, x = json.load(open(a.wired)), json.load(open(a.wireless))
    print(f"\nWired: {w['meta']['label']}   vs   Wireless: {x['meta']['label']}\n")
    rows = []

    def row(name, wv, xv, higher_better):
        if wv is None or xv is None:
            return
        if higher_better:
            ratio = xv / wv if wv else 0
        else:
            ratio = wv / xv if xv else 0
        rows.append((name, wv, xv, min(ratio, 1.0)))

    for k in ("tcp_upload", "tcp_download"):
        if k in w and k in x:
            row(f"{k} Mbps", w[k]["total_mbps"], x[k]["total_mbps"], True)
    for k in ("udp_idle", "udp_loaded"):
        if k in w and k in x:
            for m in ("rtt_p50_ms", "rtt_p99_ms", "jitter_rfc3550_ms"):
                # floor at 0.1 ms so tiny wired values don't explode the ratio
                row(f"{k} {m}", max(w[k].get(m, 0), 0.1), max(x[k].get(m, 0), 0.1), False)
    print(f"  {'metric':34s} {'wired':>10s} {'wireless':>10s} {'score':>7s}")
    for name, wv, xv, s in rows:
        print(f"  {name:34s} {wv:10.3f} {xv:10.3f} {s * 100:6.1f}%")
    if rows:
        score = statistics.mean(r[3] for r in rows) * 100
        print(f"\n  Wired-likeness score: {score:.1f}%  (100% = indistinguishable from wired)")


# --------------------------------------------------------------------------- #
def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest="cmd", required=True)

    s = sp.add_parser("server")
    s.add_argument("--bind", default="0.0.0.0")
    s.set_defaults(func=server)

    c = sp.add_parser("client")
    c.add_argument("--host", required=True)
    c.add_argument("--test", choices=["tcp", "udp", "loaded", "density", "all"], default="all")
    c.add_argument("--duration", type=float, default=10, help="seconds per test")
    c.add_argument("--streams", type=int, default=4, help="parallel TCP streams")
    c.add_argument("--pps", type=int, default=50, help="UDP probe packets/s (50 = VoIP-like)")
    c.add_argument("--payload", type=int, default=160, help="UDP payload bytes (160 = G.711 20ms)")
    c.add_argument("--clients", type=int, default=10, help="concurrent flows for density test")
    c.add_argument("--bg-streams", type=int, default=4, help="background TCP streams in density test")
    c.add_argument("--label", default="run")
    c.add_argument("--out")
    c.set_defaults(func=client)

    m = sp.add_parser("compare")
    m.add_argument("wired")
    m.add_argument("wireless")
    m.set_defaults(func=compare)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
