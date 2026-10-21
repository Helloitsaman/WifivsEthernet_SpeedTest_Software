# Wired-Like Wi-Fi Lab

An interactive website for the topic **achieving "wired-like" wireless performance, managing high-density device connectivity, and reducing jitter in enterprise deployments**.

It has three tabs:

1. **Simulator** – an animated enterprise floor with up to 300 devices and 4 access points. Change the Wi-Fi generation (5/6/7/8), number of devices, background traffic and neighbour interference. Turn features on and off (OFDMA, MU-MIMO, multi-link operation, scheduled access, frame preemption, multi-AP coordination). Latency, p99 latency, jitter, loss, fairness and a **wired-likeness score** update live against a simulated Ethernet reference. **Compare generations** runs the same scenario on Wi-Fi 5, 6, 7 and 8.
2. **Live speed test** – a real test of your own network: idle latency, jitter, download, upload, latency under load (bufferbloat grade). Save a wired run and a Wi-Fi run and compare them. Open the page on several phones and laptops, then press **Start on all devices** to test many devices at once (high density).
3. **How it works** – what the model does, what the live test measures, and the papers behind it.

Only Python 3 is needed. No `pip install`.

## Run it (Windows PowerShell)

```powershell
cd wired-like-wifi-lab
python server.py
```

Then open **http://localhost:8080** in your browser.

To test a phone or another laptop on Wi-Fi, open the second address the server prints, for example `http://192.168.1.10:8080`, on that device. If Windows Firewall asks, click **Allow**.

Stop the server with **Ctrl+C**. Use another port if 8080 is busy:

```powershell
python server.py --port 9000
```

You can also double-click `run.bat`.

## Run it (macOS / Linux)

```bash
cd wired-like-wifi-lab
python3 server.py
```

## Getting meaningful real-world results

- Run `server.py` on a computer **plugged in by Ethernet**, so the Wi-Fi hop is the only wireless part being measured.
- Test the same laptop twice: once on Ethernet (set Connection to *Wired*), once on Wi-Fi. The **Wired vs Wi-Fi** panel gives the wired-likeness score.
- For the density test, open the page on as many devices as you can, give each a name, and press **Start on all devices**.
- Testing on the same computer as the server (`localhost`) shows very high speeds, because no network is involved.

## Command-line tool

`cli/wifi_perf.py` is the earlier command-line version (TCP/UDP throughput, RFC 3550 jitter, density test):

```powershell
python cli/wifi_perf.py server
python cli/wifi_perf.py client --host 127.0.0.1 --label wired
```

## Files

```
wired-like-wifi-lab/
├── server.py        web server + speed-test API (Python standard library)
├── run.bat          Windows shortcut for "python server.py"
├── web/
│   ├── index.html   page layout
│   ├── style.css    styles
│   ├── sim.js       Wi-Fi channel-access model
│   ├── charts.js    canvas charts and gauge
│   ├── live.js      live speed test
│   └── app.js       simulator UI and animation
└── cli/wifi_perf.py command-line tester
```

The simulator is a simplified teaching model, not a standards-accurate simulator like ns-3. Use it to explore trends, not to quote absolute numbers.
