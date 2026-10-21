/* live.js - real browser speed test against server.py (latency, jitter, throughput, bufferbloat, density) */
(function () {
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const nocache = () => 'r=' + Math.random().toString(36).slice(2);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: keep in memory */ } },
  };
  function sessionId() {
    try {
      let id = sessionStorage.getItem('wll-id');
      if (!id) { id = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('wll-id', id); }
      return id;
    } catch (e) { return Math.random().toString(36).slice(2, 10); }
  }

  const state = {
    online: false, running: false, id: sessionId(), lastGroup: null,
    history: store.get('wll-history', []), last: null,
    idle: [], loaded: [],
  };

  function guessName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Mac OS X/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'Linux PC';
    return 'Device';
  }

  // ------------------------------------------------------------------ stats
  function pct(arr, p) {
    const s = arr.slice().sort((a, b) => a - b);
    if (!s.length) return NaN;
    const k = (s.length - 1) * p / 100, f = Math.floor(k), c = Math.ceil(k);
    return f === c ? s[f] : s[f] + (s[c] - s[f]) * (k - f);
  }
  function meanAbsDelta(arr) {
    if (arr.length < 2) return 0;
    let s = 0; for (let i = 1; i < arr.length; i++) s += Math.abs(arr[i] - arr[i - 1]);
    return s / (arr.length - 1);
  }
  function grade(idleP50, loadedP50) {
    const d = loadedP50 - idleP50;
    if (!isFinite(d)) return '–';
    if (d < 5) return 'A+';
    if (d < 30) return 'A';
    if (d < 60) return 'B';
    if (d < 200) return 'C';
    if (d < 400) return 'D';
    return 'F';
  }
  const fmtMs = v => !isFinite(v) ? '–' : v < 10 ? v.toFixed(1) + ' ms' : Math.round(v) + ' ms';
  const fmtMbps = v => !isFinite(v) ? '–' : v >= 100 ? v.toFixed(0) : v.toFixed(1);

  // ------------------------------------------------------------------ probes
  async function pingOnce() {
    const t0 = performance.now();
    const r = await fetch('/api/ping?' + nocache(), { cache: 'no-store' });
    await r.json();
    return performance.now() - t0;
  }

  async function pingSeries(n, onSample) {
    const out = [];
    await pingOnce().catch(() => {});                       // warm-up (connection setup)
    for (let i = 0; i < n; i++) {
      try { const v = await pingOnce(); out.push(v); onSample && onSample(v, i); } catch (e) { /* count as gap */ }
      await sleep(60);
    }
    return out;
  }

  /** parallel streaming download; returns Mbps after a 1 s TCP warm-up */
  async function download(seconds, streams, onRate) {
    const ctrl = new AbortController();
    let bytes = 0, stop = false;
    const t0 = performance.now();
    const samples = [];
    const worker = async () => {
      while (!stop) {
        try {
          const res = await fetch(`/api/download?bytes=${50 * 1024 * 1024}&${nocache()}`, { cache: 'no-store', signal: ctrl.signal });
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
          }
        } catch (e) { if (stop) return; await sleep(100); }
      }
    };
    const workers = Array.from({ length: streams }, worker);
    let warmBytes = 0, warmT = t0 + 1000;
    const timer = setInterval(() => {
      const now = performance.now();
      samples.push([now, bytes]);
      while (samples.length > 2 && now - samples[0][0] > 1000) samples.shift();
      const [ta, ba] = samples[0];
      const rate = now > ta ? (bytes - ba) * 8 / ((now - ta) / 1000) / 1e6 : 0;
      if (now >= warmT && !warmBytes) { warmBytes = bytes; warmT = now; }
      onRate && onRate(rate, (now - t0) / (seconds * 1000));
    }, 150);
    await sleep(seconds * 1000);
    stop = true; ctrl.abort(); clearInterval(timer);
    await Promise.allSettled(workers);
    const end = performance.now();
    return (bytes - warmBytes) * 8 / ((end - warmT) / 1000) / 1e6;
  }

  /** parallel upload with XHR progress events */
  async function upload(seconds, streams, onRate) {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, i + 65536));
    const blob = new Blob([chunk]);
    let bytes = 0, stop = false;
    const xhrs = new Set();
    const t0 = performance.now();
    const samples = [];
    const worker = () => new Promise(resolve => {
      const go = () => {
        if (stop) return resolve();
        const x = new XMLHttpRequest();
        let lastLoaded = 0;
        x.upload.onprogress = e => { bytes += e.loaded - lastLoaded; lastLoaded = e.loaded; };
        x.onloadend = () => { xhrs.delete(x); go(); };
        x.open('POST', '/api/upload?' + nocache());
        xhrs.add(x);
        x.send(blob);
      };
      go();
    });
    const workers = Array.from({ length: streams }, worker);
    let warmBytes = 0, warmT = t0 + 1000;
    const timer = setInterval(() => {
      const now = performance.now();
      samples.push([now, bytes]);
      while (samples.length > 2 && now - samples[0][0] > 1000) samples.shift();
      const [ta, ba] = samples[0];
      const rate = now > ta ? (bytes - ba) * 8 / ((now - ta) / 1000) / 1e6 : 0;
      if (now >= warmT && !warmBytes) { warmBytes = bytes; warmT = now; }
      onRate && onRate(rate, (now - t0) / (seconds * 1000));
    }, 150);
    await sleep(seconds * 1000);
    stop = true; clearInterval(timer);
    const end = performance.now();
    xhrs.forEach(x => x.abort());
    await Promise.race([Promise.allSettled(workers), sleep(1500)]);
    return (bytes - warmBytes) * 8 / ((end - warmT) / 1000) / 1e6;
  }

  // ------------------------------------------------------------------ UI
  function setPhase(text, step) {
    $('phase').textContent = text;
    document.querySelectorAll('#steps span').forEach(s => {
      const order = ['ping', 'down', 'up', 'loaded'];
      const i = order.indexOf(s.dataset.step), j = order.indexOf(step);
      s.classList.toggle('active', s.dataset.step === step);
      s.classList.toggle('done', step === 'done' ? true : j > i);
    });
  }
  function gauge(v, opt) { Charts.gauge($('gauge'), v, opt); }
  function drawPings() { Charts.pings($('pingchart'), state.idle, state.loaded); }

  function showResult(r) {
    $('r-ping').textContent = fmtMs(r.ping);
    $('r-jit').textContent = fmtMs(r.jitter);
    $('r-down').textContent = fmtMbps(r.down);
    $('r-up').textContent = fmtMbps(r.up);
    $('r-loaded').textContent = fmtMs(r.loadedP99);
    $('r-grade').textContent = r.grade;
    $('res-time').textContent = r.name + ' · ' + (r.conn === 'wired' ? 'Wired' : 'Wi-Fi') + ' · ' + new Date(r.time).toLocaleTimeString();
  }

  async function runTest() {
    if (state.running || !state.online) return;
    state.running = true;
    $('start').disabled = true; $('start').textContent = 'Testing…';
    state.idle = []; state.loaded = []; drawPings();
    ['r-ping', 'r-jit', 'r-down', 'r-up', 'r-loaded', 'r-grade'].forEach(id => { $(id).textContent = '–'; });
    try {
      setPhase('Measuring idle latency…', 'ping');
      const idle = await pingSeries(30, v => { state.idle.push(v); drawPings(); gauge(v, { text: v.toFixed(1), unit: 'ms latency', color: Charts.colors.accent }); });
      const ping = pct(idle, 50), jitter = meanAbsDelta(idle);
      $('r-ping').textContent = fmtMs(ping); $('r-jit').textContent = fmtMs(jitter);

      setPhase('Download: 4 streams, 8 s…', 'down');
      const down = await download(8, 4, r => gauge(r, { unit: 'Mbps download', color: Charts.colors.accent }));
      $('r-down').textContent = fmtMbps(down);

      setPhase('Upload: 4 streams, 8 s…', 'up');
      const up = await upload(8, 4, r => gauge(r, { unit: 'Mbps upload', color: Charts.colors.ok }));
      $('r-up').textContent = fmtMbps(up);

      setPhase('Latency while the link is saturated…', 'loaded');
      let loadDone = false;
      const dl = download(6, 4, null).then(() => { loadDone = true; });
      await sleep(1000);
      while (!loadDone) {
        try { const v = await pingOnce(); state.loaded.push(v); drawPings(); gauge(v, { text: v.toFixed(0), unit: 'ms under load', color: Charts.colors.bad }); } catch (e) { /* ignore */ }
        await sleep(100);
      }
      await dl;
      const loadedP50 = pct(state.loaded, 50), loadedP99 = pct(state.loaded, 99);

      const r = {
        id: Date.now(), name: $('dev-name').value.trim() || guessName(), conn: $('conn').value, time: Date.now(),
        ping, p99idle: pct(idle, 99), jitter, down, up, loadedP50, loadedP99, grade: grade(ping, loadedP50),
      };
      state.last = r;
      state.history.unshift(r); state.history = state.history.slice(0, 30);
      store.set('wll-history', state.history);
      showResult(r);
      gauge(down, { unit: 'Mbps download', color: Charts.colors.accent });
      setPhase('Done. Bufferbloat grade ' + r.grade, 'done');
      renderHistory(); renderCompare(); heartbeat();
    } catch (e) {
      setPhase('Test failed: ' + (e.message || e), null);
    } finally {
      state.running = false;
      $('start').disabled = false; $('start').textContent = 'Start test';
    }
  }

  function renderHistory() {
    const h = state.history;
    $('hist').innerHTML = h.length
      ? '<tr><th>Time</th><th>Device</th><th>Link</th><th>Ping</th><th>Jitter</th><th>Down</th><th>Up</th><th>Loaded p99</th><th>Grade</th></tr>' +
        h.map(r => `<tr><td>${new Date(r.time).toLocaleTimeString()}</td><td>${esc(r.name)}</td><td>${r.conn === 'wired' ? 'Wired' : 'Wi-Fi'}</td><td>${fmtMs(r.ping)}</td><td>${fmtMs(r.jitter)}</td><td>${fmtMbps(r.down)}</td><td>${fmtMbps(r.up)}</td><td>${fmtMs(r.loadedP99)}</td><td>${r.grade}</td></tr>`).join('')
      : '<tr><td class="hint">No runs yet.</td></tr>';
    const opt = r => `<option value="${r.id}">${new Date(r.time).toLocaleTimeString()} · ${esc(r.name)} · ${r.conn === 'wired' ? 'Wired' : 'Wi-Fi'}</option>`;
    const a = $('cmp-a'), b = $('cmp-b'), va = a.value, vb = b.value;
    const wired = h.filter(r => r.conn === 'wired'), wifi = h.filter(r => r.conn !== 'wired');
    a.innerHTML = (wired.length ? wired : h).map(opt).join('') || '<option value="">no runs</option>';
    b.innerHTML = (wifi.length ? wifi : h).map(opt).join('') || '<option value="">no runs</option>';
    if (va && [...a.options].some(o => o.value === va)) a.value = va;
    if (vb && [...b.options].some(o => o.value === vb)) b.value = vb;
  }

  function renderCompare() {
    const A = state.history.find(r => String(r.id) === $('cmp-a').value);
    const B = state.history.find(r => String(r.id) === $('cmp-b').value);
    if (!A || !B || A === B) { $('cmp-out').innerHTML = '<p class="hint">Needs one wired run and one Wi-Fi run.</p>'; return; }
    const score = WifiSim.wiredLikeness({ p50: B.ping, p99: B.loadedP99, jitter: B.jitter, loss: 0, ethP50: A.ping, ethP99: A.loadedP99, ethJitter: A.jitter });
    const row = (k, a, b, f) => `<tr><td>${k}</td><td>${f(a)}</td><td>${f(b)}</td></tr>`;
    $('cmp-out').innerHTML = `<div class="score">${score.toFixed(0)}%</div><p class="hint" style="margin-top:0">wired-likeness of the Wi-Fi run (latency, tail latency under load and jitter vs the wired run)</p>
      <table><tr><td></td><td><b>Wired</b></td><td><b>Wi-Fi</b></td></tr>
      ${row('Idle latency', A.ping, B.ping, fmtMs)}${row('Jitter', A.jitter, B.jitter, fmtMs)}
      ${row('Loaded p99', A.loadedP99, B.loadedP99, fmtMs)}${row('Download', A.down, B.down, v => fmtMbps(v) + ' Mbps')}
      ${row('Upload', A.up, B.up, v => fmtMbps(v) + ' Mbps')}</table>`;
  }

  // ------------------------------------------------------------------ density: devices online
  async function heartbeat() {
    if (!state.online) return;
    const r = state.last;
    try {
      const res = await fetch('/api/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.id, name: $('dev-name').value.trim() || guessName(),
          result: r ? { down: r.down, up: r.up, ping: r.ping, jitter: r.jitter, loadedP99: r.loadedP99, grade: r.grade, conn: r.conn } : null }),
      });
      const j = await res.json();
      if (j.group) {
        if (state.lastGroup === null) state.lastGroup = j.group.id;            // ignore triggers from before we joined
        else if (j.group.id > state.lastGroup) {
          state.lastGroup = j.group.id;
          const delay = Math.max(0, (j.group.at - j.server_time) * 1000);
          setPhase(`Group test starts in ${Math.ceil(delay / 1000)} s…`, null);
          setTimeout(runTest, delay);
        }
      }
    } catch (e) { /* server went away; checkServer will notice */ }
  }

  async function refreshClients() {
    if (!state.online) return;
    try {
      const j = await (await fetch('/api/clients?' + nocache(), { cache: 'no-store' })).json();
      $('n-online').textContent = j.count;
      $('clients').innerHTML = j.clients.length
        ? '<tr><th>Device</th><th>Address</th><th>Ping</th><th>Down</th><th>Up</th><th>Grade</th></tr>' +
          j.clients.map(c => {
            const r = c.result || {};
            return `<tr><td>${esc(c.name)}${c.id === state.id ? ' <span class="pill pass">you</span>' : ''}</td><td>${esc(c.ip)}</td><td>${fmtMs(r.ping)}</td><td>${fmtMbps(r.down)}</td><td>${fmtMbps(r.up)}</td><td>${r.grade || '–'}</td></tr>`;
          }).join('')
        : '<tr><td class="hint">No devices yet.</td></tr>';
    } catch (e) { /* ignore */ }
  }

  async function checkServer() {
    let ok = false;
    if (location.protocol.startsWith('http')) {
      try { const r = await fetch('/api/ping?' + nocache(), { cache: 'no-store' }); ok = r.ok; } catch (e) { ok = false; }
    }
    state.online = ok;
    $('offline').hidden = ok;
    $('start').disabled = !ok || state.running;
    $('group').disabled = !ok;
    return ok;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function init() {
    try { $('dev-name').value = localStorage.getItem('wll-name') || ''; } catch (e) { /* ignore */ }
    $('dev-name').placeholder = guessName();
    $('dev-name').addEventListener('change', () => { try { localStorage.setItem('wll-name', $('dev-name').value); } catch (e) { /* ignore */ } heartbeat(); });
    $('start').addEventListener('click', runTest);
    $('group').addEventListener('click', async () => {
      try { await fetch('/api/trigger', { method: 'POST' }); setPhase('Group test requested…', null); heartbeat(); } catch (e) { /* ignore */ }
    });
    $('clear-hist').addEventListener('click', () => { state.history = []; store.set('wll-history', []); renderHistory(); renderCompare(); });
    $('cmp-a').addEventListener('change', renderCompare);
    $('cmp-b').addEventListener('change', renderCompare);
    renderHistory(); renderCompare();
    gauge(0, { text: '0', unit: 'Mbps' }); drawPings();
    checkServer().then(ok => { if (ok) { heartbeat(); refreshClients(); } });
    setInterval(async () => { if (await checkServer()) { heartbeat(); refreshClients(); } }, 3000);
  }

  window.LiveTest = { init, redraw() { if (!state.running) gauge(state.last ? state.last.down : 0, { unit: 'Mbps', text: state.last ? undefined : '0' }); drawPings(); } };
})();
