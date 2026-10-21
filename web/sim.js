/* sim.js - simplified enterprise Wi-Fi channel-access model (no DOM; also runs in Node)
 *
 * Each tick (100 ms) every device sends one small real-time packet. Its latency is
 * built from: backhaul + airtime + channel-access wait (contention, busy channel,
 * neighbour networks, retries) + AP queueing. Features change those terms the way
 * the research describes. A switched-Ethernet path is sampled alongside as the
 * "wired" reference. This is a teaching model, not ns-3.
 */
(function (root) {
  const GENS = {
    wifi5: { label: 'Wi-Fi 5', std: '802.11ac', phy: 867, ru: 1,
      desc: '802.11ac · 80 MHz, 256-QAM, downlink MU-MIMO. Classic contention (DCF/EDCA).' },
    wifi6: { label: 'Wi-Fi 6', std: '802.11ax', phy: 1201, ru: 9,
      desc: '802.11ax · OFDMA resource units and uplink MU-MIMO: built for dense rooms.' },
    wifi7: { label: 'Wi-Fi 7', std: '802.11be', phy: 2882, ru: 16,
      desc: '802.11be · 320 MHz, 4096-QAM, multi-link operation, restricted TWT, first TSN hooks.' },
    wifi8: { label: 'Wi-Fi 8', std: '802.11bn', phy: 2882, ru: 16,
      desc: '802.11bn (Ultra High Reliability, in development) · adds multi-AP coordination.' },
  };
  const GEN_ORDER = ['wifi5', 'wifi6', 'wifi7', 'wifi8'];

  const FEATURES = [
    { key: 'qos', name: 'Traffic prioritization', std: 'WMM / SCS queues', min: 'wifi5' },
    { key: 'mumimo', name: 'MU-MIMO', std: 'multi-user spatial streams', min: 'wifi5' },
    { key: 'ofdma', name: 'OFDMA', std: '802.11ax resource units', min: 'wifi6' },
    { key: 'mlo', name: 'Multi-link operation', std: '802.11be, 2 bands at once', min: 'wifi7' },
    { key: 'sched', name: 'Scheduled access', std: 'R-TWT / TSN 802.1Qbv slots', min: 'wifi7' },
    { key: 'preempt', name: 'Frame preemption', std: 'TSN 802.1Qbu (research)', min: 'wifi7' },
    { key: 'mapc', name: 'Multi-AP coordination', std: '802.11bn Co-TDMA / Co-SR', min: 'wifi8' },
  ];

  const TARGETS = [
    { name: 'Voice / video calls', p99: 150, jitter: 30, loss: 1 },
    { name: 'Cloud gaming', p99: 50, jitter: 10, loss: 0.1 },
    { name: 'VR / AR', p99: 20, jitter: 5, loss: 0.1 },
    { name: 'Industrial control', p99: 10, jitter: 1, loss: 0.01 },
  ];

  const AP_LAYOUTS = {
    1: [[0.5, 0.5]],
    2: [[0.27, 0.5], [0.73, 0.5]],
    3: [[0.2, 0.3], [0.8, 0.3], [0.5, 0.75]],
    4: [[0.27, 0.28], [0.73, 0.28], [0.27, 0.72], [0.73, 0.72]],
  };

  const MAX_DEVICES = 300;
  const TICK = 0.1;          // seconds of simulated time per step
  const WINDOW = 10;         // seconds of packets kept
  const STATS_WINDOW = 5;    // seconds used for KPIs

  function allowed(gen, key) {
    const f = FEATURES.find(x => x.key === key);
    return GEN_ORDER.indexOf(gen) >= GEN_ORDER.indexOf(f.min);
  }
  /** everything the generation supports, except research-only frame preemption */
  function bestFeatures(gen) {
    const o = {};
    FEATURES.forEach(f => { o[f.key] = allowed(gen, f.key) && f.key !== 'preempt'; });
    return o;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rnd = Math.random;
  const expo = mean => -Math.log(1 - rnd()) * mean;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const k = (sorted.length - 1) * p / 100, f = Math.floor(k), c = Math.ceil(k);
    return f === c ? sorted[f] : sorted[f] + (sorted[c] - sorted[f]) * (k - f);
  }
  function jain(xs) {
    const s = xs.reduce((a, b) => a + b, 0), q = xs.reduce((a, b) => a + b * b, 0);
    return xs.length && q > 0 ? (s * s) / (xs.length * q) : 1;
  }

  class Sim {
    constructor(cfg) {
      this.cfg = Object.assign({ gen: 'wifi7', devices: 60, aps: 2, load: 0.3, obss: 0.2, features: bestFeatures('wifi7'), seed: 7 }, cfg);
      const r = mulberry32(this.cfg.seed);
      this.pool = [];
      for (let i = 0; i < MAX_DEVICES; i++) {
        this.pool.push({ x: 0.04 + r() * 0.92, y: 0.06 + r() * 0.88, rank: r(), ema: 1, jit: 0, last: null, tput: 0, lost: 0, sent: 0 });
      }
      this.reset();
    }

    reset() {
      this.t = 0;
      this.pkts = [];          // {t, v, lost, d}
      this.eth = [];           // {t, v}
      this.ethJit = 0; this.ethLast = null;
      this.pool.forEach(d => { d.ema = 1; d.jit = 0; d.last = null; d.lost = 0; d.sent = 0; d.tput = 0; });
      this.layout();
    }

    set(cfg) {
      const prev = this.cfg;
      this.cfg = Object.assign({}, prev, cfg);
      if (cfg.features) this.cfg.features = Object.assign({}, prev.features, cfg.features);
      // features not available on this generation are forced off
      FEATURES.forEach(f => { if (!allowed(this.cfg.gen, f.key)) this.cfg.features[f.key] = false; });
      this.layout();
    }

    layout() {
      const c = this.cfg;
      this.apPos = AP_LAYOUTS[c.aps];
      this.cellR = 0.62 / Math.sqrt(c.aps);
      this.devs = this.pool.slice(0, c.devices);
      this.devs.forEach(d => {
        let best = 0, bd = 9;
        this.apPos.forEach((p, i) => { const dd = Math.hypot(d.x - p[0], (d.y - p[1]) * 0.66); if (dd < bd) { bd = dd; best = i; } });
        d.ap = best;
        d.dist = bd;
        d.rf = clamp(1 - 0.75 * bd / this.cellR, 0.15, 1);   // MCS falls with distance
        d.bulk = d.rank < c.load;
      });
    }

    /** advance one tick; returns a sample of packets for animation */
    step() {
      const c = this.cfg, F = c.features, gen = GENS[c.gen];
      this.t += TICK;
      const now = this.t;
      const obssEff = clamp(c.obss + 0.08 * (c.aps - 1), 0, 1) * (F.mapc ? 0.25 : 1);
      const anim = [];
      this.apState = [];

      for (let a = 0; a < c.aps; a++) {
        const devs = this.devs.filter(d => d.ap === a);
        const n = devs.length;
        if (!n) { this.apState.push({ n: 0, bulk: 0, busy: obssEff * 0.4, pColl: 0, cap: 0 }); continue; }
        const bulkDevs = devs.filter(d => d.bulk);
        const bulk = bulkDevs.length;

        // --- contention ---
        let contenders = bulk + Math.max(1, n * 0.1);
        if (F.ofdma) contenders = Math.max(1, contenders / gen.ru);
        if (F.mumimo) contenders *= 0.85;
        const pColl = Math.min(0.7, 1 - Math.exp(-0.012 * (contenders - 1)));

        // --- capacity ---
        const mult = (F.mumimo ? (c.gen === 'wifi5' ? 1.1 : 1.25) : 1)
          * (F.ofdma ? 1 + 0.2 * Math.min(1, n / 12) : 1)
          * (F.mlo ? 1.75 : 1)
          * (1 - 0.6 * pColl);
        const capOf = rf => gen.phy * 0.62 * rf * mult;

        // --- channel busy fraction ---
        const overhead = n * (F.ofdma ? 0.0006 : 0.0015);            // beacons, probes, control frames, rt traffic
        const own = Math.min(0.95, (bulk > 0 ? 0.5 + 0.3 * c.load : 0.04) + overhead);
        const busy = Math.min(0.97, own + obssEff * 0.4 * (1 - own));
        const txopMax = F.preempt ? 0.5 : (bulk > 0 ? 4.0 : 1.0);
        const schedOk = clamp(1 - n * 0.002 - c.load * 0.1 - obssEff * (F.mapc ? 0.05 : 0.4), 0.4, 0.99);
        const bloat = bulk > 0 ? (F.qos ? 0.15 : 2 + 30 * c.load) : 0.05;

        this.apState.push({ n, bulk, busy, pColl, cap: capOf(1) });

        // --- throughput (airtime-fair among bulk devices, DCF adds unfairness) ---
        const unfair = pColl * (F.ofdma ? 0.4 : 0.8);
        devs.forEach(d => {
          if (d.bulk) {
            const noise = 1 + (rnd() * 2 - 1) * unfair;
            const inst = capOf(d.rf) / bulk * noise;
            d.tput = d.tput ? d.tput * 0.8 + inst * 0.2 : inst;
          } else {
            d.tput = 0.064;   // 160-byte packets at 50 pps: a voice-like flow
          }
        });

        // --- one real-time packet per device ---
        for (const d of devs) {
          const airtime = 0.04 + (200 * 8) / (gen.phy * d.rf * 1000);
          let wait;
          if (F.sched && rnd() < schedOk) {
            wait = rnd() * 0.25;                                   // reserved service period
          } else {
            const w1 = accessWait(busy, pColl, txopMax);
            const w2 = F.mlo ? accessWait(busy * 0.8, pColl, txopMax) : null;
            wait = w1 == null ? w2 : (w2 == null ? w1 : Math.min(w1, w2));
          }
          const queue = rnd() < 0.5 ? expo(bloat) : 0;          // downlink half queues at the AP
          d.sent++;
          let lost = wait == null;
          let v = lost ? NaN : 0.3 + airtime + wait + queue;
          if (!lost && v > 500) { lost = true; v = NaN; }
          if (lost) d.lost++;
          else {
            if (d.last != null) d.jit += (Math.abs(v - d.last) - d.jit) / 16;   // RFC 3550 estimator
            d.last = v;
            d.ema = d.ema * 0.7 + v * 0.3;
          }
          this.pkts.push({ t: now, v, lost, d: d });
          if (anim.length < 60 && rnd() < 60 / Math.max(60, c.devices)) anim.push({ d, v, lost });
        }
      }

      // --- wired reference: switched gigabit Ethernet ---
      const nEth = Math.min(80, Math.max(10, c.devices));
      for (let i = 0; i < nEth; i++) {
        const v = 0.12 + expo(0.02) + (c.load > 0 && rnd() < 0.3 ? expo(0.05 + 0.4 * c.load) : 0);
        if (this.ethLast != null) this.ethJit += (Math.abs(v - this.ethLast) - this.ethJit) / 16;
        this.ethLast = v;
        this.eth.push({ t: now, v });
      }

      // trim windows
      const cut = now - WINDOW;
      if (this.pkts.length && this.pkts[0].t < cut) this.pkts = this.pkts.filter(p => p.t >= cut);
      if (this.eth.length && this.eth[0].t < cut) this.eth = this.eth.filter(p => p.t >= cut);
      return anim;

      function accessWait(busy, pColl, txopMax) {
        let w = rnd() * 15 * 0.009;                                 // initial backoff (9 µs slots)
        let k = busy > 0 ? Math.floor(Math.log(1 - rnd()) / Math.log(busy)) : 0;
        k = Math.min(k, 80);
        for (let j = 0; j < k; j++) w += 0.2 + rnd() * txopMax;     // wait out others' transmissions
        let r = 0;
        while (rnd() < pColl) {                                     // collision -> retry with bigger window
          r++;
          if (r > 6) return null;
          w += rnd() * 16 * Math.pow(2, r) * 0.009 + 0.2 + (rnd() < busy ? rnd() * txopMax : 0);
        }
        return w;
      }
    }

    stats() {
      const now = this.t, from = now - STATS_WINDOW;
      const recent = this.pkts.filter(p => p.t >= from);
      const got = recent.filter(p => !p.lost).map(p => p.v).sort((a, b) => a - b);
      const lossPct = recent.length ? 100 * (recent.length - got.length) / recent.length : 0;
      const eth = this.eth.filter(p => p.t >= from).map(p => p.v).sort((a, b) => a - b);
      const jit = this.devs.length ? this.devs.reduce((s, d) => s + d.jit, 0) / this.devs.length : 0;
      const bulkT = this.devs.filter(d => d.bulk).map(d => d.tput);
      const fairness = bulkT.length >= 2 ? jain(bulkT) : jain(this.devs.map(d => d.sent ? 1 - d.lost / d.sent : 1));
      const s = {
        p50: percentile(got, 50), p99: percentile(got, 99), jitter: jit, loss: lossPct,
        tput: this.devs.reduce((a, d) => a + d.tput, 0),
        ethP50: percentile(eth, 50), ethP99: percentile(eth, 99), ethJitter: this.ethJit,
        fairness, wifiSorted: got, ethSorted: eth,
      };
      s.score = wiredLikeness(s);
      s.ready = TARGETS.map(tg => ({ ...tg, pass: s.p99 <= tg.p99 && s.jitter <= tg.jitter && s.loss <= tg.loss }));
      return s;
    }
  }

  /** 100% = indistinguishable from the wired reference */
  function wiredLikeness(s) {
    if (!isFinite(s.p50)) return 0;
    const r = (eth, wifi, floor) => Math.min(1, Math.max(eth, floor) / Math.max(wifi, floor));
    const base = (r(s.ethP50, s.p50, 1) + r(s.ethP99, s.p99, 1) + r(s.ethJitter, s.jitter, 0.5)) / 3;
    return 100 * base * Math.max(0, 1 - s.loss / 2);
  }

  /** run the same scenario on every generation with its best features */
  function compareGenerations(cfg, seconds = 4) {
    return GEN_ORDER.map(gen => {
      const sim = new Sim(Object.assign({}, cfg, { gen, features: bestFeatures(gen) }));
      for (let i = 0; i < seconds / TICK; i++) sim.step();
      const s = sim.stats();
      return { gen, label: GENS[gen].label, p99: s.p99, jitter: s.jitter, loss: s.loss, score: s.score, tput: s.tput };
    });
  }

  const api = { Sim, GENS, GEN_ORDER, FEATURES, TARGETS, allowed, bestFeatures, compareGenerations, wiredLikeness, percentile, jain, TICK, WINDOW };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WifiSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
