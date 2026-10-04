// hrv.js - SDNN & RMSSD from a PPG/rPPG signal. No dependencies.
// Works in the browser (<script> or ES module) and in Node.
//
// computeHRV(signal, timestamps)
//   signal:     array of numbers (pulse/BVP waveform, e.g. green channel)
//   timestamps: array of times in SECONDS (same length), or a number = fps
// returns { ok, nBeats, meanHR, meanIBI, sdnn, rmssd, sdsd, pnn50, pnn20, sd1, sd2, sd1sd2,
//           vlf, lf, hf, tp, lfhf, lfNu, hfNu, breathingRate }
//   ms for time metrics, % for pnn/Nu, ms^2 for power. Frequency metrics need >= 30 s of beats.
// Use a window of 30-60 s. Returns ok:false if too few clean beats.

function computeHRV(signal, timestamps, opts = {}) {
  const minBeats = opts.minBeats ?? 20;
  const n = signal.length;
  const ts = typeof timestamps === "number"
    ? Array.from({ length: n }, (_, i) => i / timestamps)
    : timestamps;
  const fail = { ok: false, nBeats: 0 };
  if (n < 30 || ts.length !== n) return fail;

  const fps = (n - 1) / (ts[n - 1] - ts[0]);

  // 1. Band-pass (0.7-3 Hz) via difference of moving averages
  const ma = (x, w) => {
    const out = new Array(x.length), h = Math.max(1, Math.floor(w / 2));
    let sum = 0, cnt = 0, lo = 0, hi = -1;
    for (let i = 0; i < x.length; i++) {
      while (hi < Math.min(x.length - 1, i + h)) { hi++; sum += x[hi]; cnt++; }
      while (lo < i - h) { sum -= x[lo]; lo++; cnt--; }
      out[i] = sum / cnt;
    }
    return out;
  };
  const fast = ma(signal, Math.round(fps / 3));      // low-pass ~3 Hz
  const slow = ma(signal, Math.round(fps / 0.7));    // trend ~0.7 Hz
  const s = fast.map((v, i) => v - slow[i]);

  // 2. Peak detection with 0.33 s refractory period + parabolic refinement
  const sd = Math.sqrt(s.reduce((a, v) => a + v * v, 0) / n);
  const minDist = Math.round(0.33 * fps);
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (s[i] > s[i - 1] && s[i] >= s[i + 1] && s[i] > 0.2 * sd) {
      if (peaks.length && i - peaks[peaks.length - 1].i < minDist) {
        if (s[i] > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { i, v: s[i] };
      } else peaks.push({ i, v: s[i] });
    }
  }
  const t = peaks.map(({ i }) => {
    const a = s[i - 1], b = s[i], c = s[i + 1], d = a - 2 * b + c;
    const off = d !== 0 ? 0.5 * (a - c) / d : 0;
    return ts[i] + off * (ts[i + 1] - ts[i]);
  });

  // 3. Inter-beat intervals (ms) + artifact rejection
  let ibi = [];
  for (let i = 1; i < t.length; i++) ibi.push((t[i] - t[i - 1]) * 1000);
  ibi = ibi.filter(v => v >= 300 && v <= 1500);
  if (!ibi.length) return fail;
  const med = [...ibi].sort((a, b) => a - b)[Math.floor(ibi.length / 2)];
  // keep intervals within 25% of the median
  const clean = ibi.filter(v => Math.abs(v - med) <= 0.25 * med);
  if (clean.length < minBeats) return { ...fail, nBeats: clean.length };

  // 4. Time-domain metrics
  const okIbi = v => Math.abs(v - med) <= 0.25 * med;
  const mean = clean.reduce((a, v) => a + v, 0) / clean.length;
  const sdnn = Math.sqrt(clean.reduce((a, v) => a + (v - mean) ** 2, 0) / (clean.length - 1));
  const diffs = [];                       // successive differences, clean pairs only
  for (let i = 1; i < ibi.length; i++)
    if (okIbi(ibi[i]) && okIbi(ibi[i - 1])) diffs.push(ibi[i] - ibi[i - 1]);
  const dm = diffs.length ? diffs.reduce((a, v) => a + v, 0) / diffs.length : 0;
  const rmssd = diffs.length ? Math.sqrt(diffs.reduce((a, v) => a + v * v, 0) / diffs.length) : null;
  const sdsd = diffs.length > 1
    ? Math.sqrt(diffs.reduce((a, v) => a + (v - dm) ** 2, 0) / (diffs.length - 1)) : null;
  const pct = th => diffs.length ? 100 * diffs.filter(d => Math.abs(d) > th).length / diffs.length : null;
  const sd1 = sdsd != null ? sdsd / Math.SQRT2 : null;                    // Poincare
  const sd2 = sdsd != null ? Math.sqrt(Math.max(0, 2 * sdnn ** 2 - 0.5 * sdsd ** 2)) : null;

  // 5. Frequency-domain: resample IBI series to 4 Hz, Hann window, direct DFT
  let freq = { vlf: null, lf: null, hf: null, tp: null, lfhf: null, lfNu: null, hfNu: null, breathingRate: null };
  const bt = [], bv = [];                 // (time s, ibi ms) for valid intervals
  { let k = 0; for (let i = 1; i < t.length; i++) {
      const v = (t[i] - t[i - 1]) * 1000;
      if (v >= 300 && v <= 1500) { if (okIbi(v)) { bt.push(t[i]); bv.push(v); } }
    } }
  if (bt.length >= 20 && bt[bt.length - 1] - bt[0] >= 30) {
    const fs = 4, N = Math.floor((bt[bt.length - 1] - bt[0]) * fs);
    const x = new Array(N); let j = 0;
    for (let i = 0; i < N; i++) {
      const tt = bt[0] + i / fs;
      while (j < bt.length - 2 && bt[j + 1] < tt) j++;
      const w = (tt - bt[j]) / (bt[j + 1] - bt[j]);
      x[i] = bv[j] + w * (bv[j + 1] - bv[j]);
    }
    const xm = x.reduce((a, v) => a + v, 0) / N;
    const xw = x.map((v, i) => (v - xm) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))));
    const winPow = xw.length ? x.reduce((a, _, i) => a + (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))) ** 2, 0) : 1;
    const df = 0.005, band = { vlf: 0, lf: 0, hf: 0 };
    let peakP = 0, peakF = null;
    for (let f = 0.0033; f < 0.4; f += df) {
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) { const a = 2 * Math.PI * f * i / fs; re += xw[i] * Math.cos(a); im -= xw[i] * Math.sin(a); }
      const p = (re * re + im * im) / (fs * winPow) * df;      // ms^2
      if (f < 0.04) band.vlf += p; else if (f < 0.15) band.lf += p; else band.hf += p;
      if (f >= 0.1 && p > peakP) { peakP = p; peakF = f; }
    }
    const tp = band.vlf + band.lf + band.hf;
    freq = { vlf: band.vlf, lf: band.lf, hf: band.hf, tp,
             lfhf: band.hf ? band.lf / band.hf : null,
             lfNu: 100 * band.lf / (band.lf + band.hf), hfNu: 100 * band.hf / (band.lf + band.hf),
             breathingRate: peakF ? peakF * 60 : null };   // rough estimate; keep your own RR
  }

  return { ok: true, nBeats: clean.length,
           meanHR: 60000 / mean, meanIBI: mean,
           sdnn, rmssd, sdsd, pnn50: pct(50), pnn20: pct(20), sd1, sd2,
           sd1sd2: sd2 ? sd1 / sd2 : null, ...freq };
}

if (typeof module !== "undefined") module.exports = { computeHRV };
