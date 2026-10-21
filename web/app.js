/* app.js - tabs + simulator UI */
(function () {
  const $ = id => document.getElementById(id);
  const W = window.WifiSim, C = Charts.colors;

  // ------------------------------------------------------------------ tabs
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', b === btn); });
    document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    requestAnimationFrame(() => { drawCharts(true); LiveTest.redraw(); });
  }));

  // ------------------------------------------------------------------ simulator state
  const sim = new W.Sim({ gen: 'wifi7', devices: 60, aps: 2, load: 0.3, obss: 0.2, features: W.bestFeatures('wifi7') });
  let playing = true, lastStats = null, anims = [], lastCompare = null;

  const PRESETS = {
    office:  { gen: 'wifi7', devices: 60,  aps: 2, load: 0.3,  obss: 0.2 },
    hall:    { gen: 'wifi6', devices: 180, aps: 3, load: 0.15, obss: 0.3 },
    factory: { gen: 'wifi7', devices: 40,  aps: 2, load: 0.2,  obss: 0.1, extra: { preempt: true } },
    arena:   { gen: 'wifi7', devices: 300, aps: 4, load: 0.4,  obss: 0.6 },
  };

  // ------------------------------------------------------------------ controls
  function renderFeatures() {
    const g = sim.cfg.gen, box = $('features');
    box.innerHTML = '';
    W.FEATURES.forEach(f => {
      const ok = W.allowed(g, f.key);
      const lab = document.createElement('label');
      lab.className = 'toggle' + (ok ? '' : ' disabled');
      lab.title = ok ? '' : `Needs ${W.GENS[f.min].label} or newer`;
      lab.innerHTML = `<span class="t-name">${f.name}</span><span class="t-std">${ok ? f.std : 'needs ' + W.GENS[f.min].label}</span>`;
      const inp = document.createElement('input');
      inp.type = 'checkbox'; inp.checked = !!sim.cfg.features[f.key]; inp.disabled = !ok;
      inp.setAttribute('aria-label', f.name);
      inp.addEventListener('change', () => { sim.set({ features: { [f.key]: inp.checked } }); });
      lab.appendChild(inp);
      box.appendChild(lab);
    });
  }
  function setGen(gen, features) {
    sim.set({ gen, features: features || W.bestFeatures(gen) });
    document.querySelectorAll('#gen button').forEach(b => b.classList.toggle('on', b.dataset.gen === gen));
    $('gen-desc').textContent = W.GENS[gen].desc;
    renderFeatures();
  }
  function syncSliders() {
    const c = sim.cfg;
    $('devices').value = c.devices; $('v-devices').textContent = c.devices;
    $('aps').value = c.aps; $('v-aps').textContent = c.aps;
    $('load').value = Math.round(c.load * 100); $('v-load').textContent = Math.round(c.load * 100) + '%';
    $('obss').value = Math.round(c.obss * 100); $('v-obss').textContent = Math.round(c.obss * 100) + '%';
  }

  document.querySelectorAll('#gen button').forEach(b => b.addEventListener('click', () => setGen(b.dataset.gen)));
  const bind = (id, fn) => $(id).addEventListener('input', e => { fn(+e.target.value); syncSliders(); });
  bind('devices', v => sim.set({ devices: v }));
  bind('aps', v => sim.set({ aps: v }));
  bind('load', v => sim.set({ load: v / 100 }));
  bind('obss', v => sim.set({ obss: v / 100 }));

  document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset];
    sim.set({ devices: p.devices, aps: p.aps, load: p.load, obss: p.obss });
    setGen(p.gen, Object.assign(W.bestFeatures(p.gen), p.extra || {}));
    syncSliders(); sim.reset(); anims = []; clearCompare();
  }));
  $('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; });
  $('reset').addEventListener('click', () => {
    sim.set({ devices: 60, aps: 2, load: 0.3, obss: 0.2 });
    setGen('wifi7'); syncSliders(); sim.reset(); anims = []; clearCompare();
  });
  function clearCompare() {
    lastCompare = null;
    $('compare').textContent = 'Run';
    $('gencmp-caption').textContent = 'Runs the current scenario on every generation with its best features on.';
  }
  $('compare').addEventListener('click', () => {
    $('compare').disabled = true; $('compare').textContent = 'Running…';
    setTimeout(() => {
      lastCompare = W.compareGenerations({ devices: sim.cfg.devices, aps: sim.cfg.aps, load: sim.cfg.load, obss: sim.cfg.obss });
      drawCompare();
      const best = lastCompare.reduce((a, b) => (b.score > a.score ? b : a));
      $('gencmp-caption').textContent = `${sim.cfg.devices} devices, ${sim.cfg.aps} AP${sim.cfg.aps > 1 ? 's' : ''}, ${Math.round(sim.cfg.load * 100)}% bulk traffic: ${best.label} is most wired-like (${best.score.toFixed(0)}%). Research-only frame preemption is left off.`;
      $('compare').disabled = false; $('compare').textContent = 'Run again';
    }, 20);
  });

  // ------------------------------------------------------------------ formatting
  const ms = v => !isFinite(v) ? '–' : v < 10 ? v.toFixed(1) + ' ms' : Math.round(v) + ' ms';
  const mbps = v => v >= 1000 ? (v / 1000).toFixed(1) + ' Gbps' : v.toFixed(0) + ' Mbps';
  const latColor = v => v < 10 ? C.good : v < 50 ? C.ok : C.bad;

  function updateKpis(s) {
    $('k-score').textContent = s.score.toFixed(0) + '%';
    $('k-score-bar').style.width = Math.max(2, s.score) + '%';
    $('k-score-bar').style.background = s.score >= 70 ? C.good : s.score >= 35 ? C.ok : C.bad;
    $('k-tput').textContent = mbps(s.tput);
    $('k-p50').textContent = ms(s.p50); $('k-p50-eth').textContent = 'wired ' + ms(s.ethP50);
    $('k-p99').textContent = ms(s.p99); $('k-p99-eth').textContent = 'wired ' + ms(s.ethP99);
    $('k-jit').textContent = ms(s.jitter); $('k-jit-eth').textContent = 'wired ' + ms(s.ethJitter);
    $('k-loss').textContent = s.loss < 0.01 ? '0%' : s.loss.toFixed(2) + '%';
    $('k-fair').textContent = s.fairness.toFixed(2);
    $('ready').innerHTML = s.ready.map(r => `<tr><td>${r.name}</td><td><span class="pill ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span></td><td class="r">≤${r.p99} ms · ≤${r.jitter} ms · ≤${r.loss}%</td></tr>`).join('');

    const ap = sim.apState || [];
    $('floor-caption').textContent = ap.map((a, i) => `AP${i + 1}: ${a.n} devices, channel busy ${Math.round(a.busy * 100)}%, collisions ${Math.round(a.pColl * 100)}%`).join(' · ');
    const bulk = sim.devs.filter(d => d.bulk).length;
    $('bars-caption').textContent = bulk
      ? `${bulk} devices downloading share the airtime; the other ${sim.devs.length - bulk} run voice/control flows (~0.06 Mbps each). Fair share = equal bars.`
      : 'No bulk traffic: raise "Background bulk traffic" to see how airtime is shared.';
  }

  // ------------------------------------------------------------------ charts
  function drawCharts(force) {
    if (!document.getElementById('tab-sim').classList.contains('active') && !force) return;
    const s = lastStats; if (!s) return;
    const pts = sim.pkts, stride = Math.max(1, Math.floor(pts.length / 3000));
    const sample = []; for (let i = 0; i < pts.length; i += stride) sample.push(pts[i]);
    Charts.timeline($('timeline'), sample, { now: sim.t, span: 10, refs: [
      { v: s.ethP99, color: C.eth, label: 'Ethernet p99 ' + ms(s.ethP99) },
      { v: s.p99, color: C.accent, label: 'Wi-Fi p99 ' + ms(s.p99), dash: [5, 4] },
    ] });
    Charts.cdf($('cdf'), [{ values: s.ethSorted, color: C.eth }, { values: s.wifiSorted, color: C.accent }]);
    const bulk = sim.devs.filter(d => d.bulk).map(d => d.tput).sort((a, b) => b - a).slice(0, 80);
    Charts.bars($('bars'), bulk.map(v => ({ v, color: C.accent })), { xLabel: bulk.length ? 'devices downloading, Mbps' : '' });
    if (lastCompare) drawCompare();
    else Charts.grouped($('gencmp'), [], []);
  }
  function drawCompare() {
    const r = lastCompare;
    Charts.grouped($('gencmp'), r.map(x => ({ label: x.label, sub: `p99 ${ms(x.p99)}`, values: [x.score, x.p99, x.jitter], highlight: x.gen === sim.cfg.gen })), [
      { name: 'wired-like %', color: C.good, max: 100, fmt: v => v.toFixed(0) },
      { name: 'p99 latency', color: C.ok, max: Math.max(...r.map(x => x.p99)) * 1.15, fmt: null },
      { name: 'jitter', color: C.eth, max: Math.max(...r.map(x => x.jitter)) * 1.15, fmt: null },
    ]);
  }

  // ------------------------------------------------------------------ floor plan
  function drawFloor(now) {
    const { ctx, w, h } = Charts.setup($('floor'));
    // walls / rooms (decorative)
    ctx.strokeStyle = '#1F2630'; ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w * 0.36, 6); ctx.lineTo(w * 0.36, h * 0.26);
    ctx.moveTo(w * 0.64, 6); ctx.lineTo(w * 0.64, h * 0.26);
    ctx.moveTo(6, h * 0.26); ctx.lineTo(w * 0.3, h * 0.26);
    ctx.moveTo(w * 0.42, h * 0.26); ctx.lineTo(w - 6, h * 0.26);
    ctx.stroke();
    ctx.fillStyle = '#4A5361'; ctx.font = "11px 'IBM Plex Mono', monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('MEETING', 14, 14); ctx.fillText('SWITCH', w * 0.36 + 8, 14); ctx.fillText('MEETING', w * 0.64 + 8, 14);

    // APs + coverage (clipped to the floor)
    const ap = sim.apState || [];
    ctx.save(); ctx.beginPath(); ctx.rect(7, 7, w - 14, h - 14); ctx.clip();
    sim.apPos.forEach((p, i) => {
      const x = p[0] * w, y = p[1] * h, r = sim.cellR * w * 0.8;
      const busy = ap[i] ? ap[i].busy : 0;
      ctx.fillStyle = `rgba(76, 201, 240, ${0.04 + busy * 0.1})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(76, 201, 240, 0.25)'; ctx.setLineDash([4, 5]);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      // backhaul cable to switch
      ctx.strokeStyle = 'rgba(183, 148, 246, 0.35)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(w * 0.5, h * 0.13); ctx.stroke();
      ctx.lineWidth = 1;
    });
    ctx.restore();
    // switch
    ctx.fillStyle = C.eth; ctx.fillRect(w * 0.5 - 16, h * 0.13 - 6, 32, 12);

    // devices
    for (const d of sim.devs) {
      const x = d.x * w, y = d.y * h;
      ctx.fillStyle = latColor(d.ema);
      if (d.bulk) ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
      else { ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill(); }
    }

    // packets in flight
    anims = anims.filter(a => now - a.start < 700);
    for (const a of anims) {
      const k = (now - a.start) / 700;
      if (k < 0) continue;
      const p = sim.apPos[a.d.ap]; if (!p) continue;
      const x0 = a.d.x * w, y0 = a.d.y * h, x1 = p[0] * w, y1 = p[1] * h;
      if (a.lost) {
        ctx.strokeStyle = C.bad; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x0 - 5, y0 - 5); ctx.lineTo(x0 + 5, y0 + 5); ctx.moveTo(x0 + 5, y0 - 5); ctx.lineTo(x0 - 5, y0 + 5); ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = 1;
        continue;
      }
      ctx.fillStyle = latColor(a.v); ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, 2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // AP icons on top
    sim.apPos.forEach((p, i) => {
      const x = p[0] * w, y = p[1] * h;
      ctx.fillStyle = '#0D1117'; ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.accent; ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('AP' + (i + 1), x, y + 0.5);
    });
    ctx.lineWidth = 1;
    ctx.fillStyle = C.muted; ctx.font = "11px 'IBM Plex Mono', monospace"; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('■ downloading   ● voice / control', w - 14, h - 12);
  }

  // ------------------------------------------------------------------ loop
  let acc = 0, last = performance.now(), statT = 0, chartT = 0;
  function frame(now) {
    const dt = Math.min(500, now - last); last = now;
    const visible = document.getElementById('tab-sim').classList.contains('active');
    if (playing) {
      acc += dt;
      while (acc >= W.TICK * 1000) {
        acc -= W.TICK * 1000;
        const a = sim.step();
        if (visible) a.forEach(p => anims.push(Object.assign(p, { start: now + Math.random() * 100 })));
      }
    }
    if (visible) {
      if (now - statT > 400 || !lastStats) { statT = now; lastStats = sim.stats(); updateKpis(lastStats); }
      if (now - chartT > 250) { chartT = now; drawCharts(); }
      drawFloor(now);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ boot
  setGen('wifi7'); syncSliders();
  for (let i = 0; i < 30; i++) sim.step();     // pre-fill so charts are not empty
  lastStats = sim.stats(); updateKpis(lastStats);
  window.addEventListener('resize', () => { drawCharts(true); LiveTest.redraw(); });
  requestAnimationFrame(frame);
  LiveTest.init();
})();
