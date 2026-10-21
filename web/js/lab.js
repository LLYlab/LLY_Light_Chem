/**
 * 连续检验台：用已知答案的合成光谱反向考核算法。
 * 与 tests/core.test.mjs 的区别：这里每次换随机参数，考的是"稳不稳"。
 */
import * as C from './core.js';

const $ = (s) => document.querySelector(s);

/* ------------------------------------------------------------ 工具 */
const rnd = (seed) => C.rng(seed);
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function makeSpectrum({ seed, lamp = 'Hg', aMin = 0.06, aMax = 0.2 }) {
  const r = rnd(seed);
  const a = aMin + r() * (aMax - aMin);
  const width = Math.round((700 - 380) / a) + 40;
  const b = 380 - r() * 20;
  const lines = C.ELEMENTS[lamp].lines.filter((l) => l > b + 5 && l < b + a * (width - 5));
  const sigma = 1.8 + r() * 2.2;
  const noise = 0.8 + r() * 2.2;
  const prof = C.syntheticProfile({ width, a, b, lines, sigmaPx: sigma, noise, seed });
  const smooth = C.smoothProfile(prof, 5);
  const peaks = C.findPeaks(smooth, { minProminence: 0.06, minDistance: 5 });
  return { a, b, width, lines, sigma, noise, prof, smooth, peaks, xs: peaks.map((p) => p.x) };
}

/* ------------------------------------------------------------ 科目 */
const SUITES = [
  {
    id: 'peak',
    name: '找峰还原',
    desc: '合成谱线的真实位置 vs 检测位置（像素）',
    run(seed) {
      const s = makeSpectrum({ seed });
      const truth = s.lines.map((lam) => ({ lam, x: (lam - s.b) / s.a }));
      let hit = 0, errSum = 0, worst = 0;
      for (const t of truth) {
        if (!s.xs.length) continue;
        const nearest = s.xs.reduce((p, q) => (Math.abs(q - t.x) < Math.abs(p - t.x) ? q : p), s.xs[0]);
        const e = Math.abs(nearest - t.x);
        if (e < 2) { hit++; errSum += e; worst = Math.max(worst, e); }
      }
      const recall = truth.length ? hit / truth.length : 0;
      const mae = hit ? errSum / hit : 99;
      return {
        pass: recall >= 0.9 && mae < 1.0,
        metric: `召回 ${(recall * 100).toFixed(0)}% · MAE ${mae.toFixed(2)} px`,
        detail: `${truth.length} 条真值 / ${s.peaks.length} 个检测 / σ=${s.sigma.toFixed(1)}px / 噪声=${s.noise.toFixed(1)}`,
      };
    },
  },
  {
    id: 'calib',
    name: '波长标定',
    desc: '用 Hg 自动标定后，还原波长的最大误差（nm）',
    run(seed) {
      const s = makeSpectrum({ seed, lamp: 'Hg' });
      const m = C.calibrateWithLamp(s.xs, 'Hg', { tol: 3, minInliers: 3 });
      if (!m) return { pass: false, metric: '标定失败', detail: `${s.xs.length} 个峰对不上汞线` };
      const wl = C.resolveWavelengths(m, s.xs);
      let worst = 0;
      for (const lam of wl) {
        const best = C.ELEMENTS.Hg.lines.reduce((x, y) => (Math.abs(y - lam) < Math.abs(x - lam) ? y : x), 1e9);
        worst = Math.max(worst, Math.abs(best - lam));
      }
      return {
        pass: worst < 0.3,
        metric: `最大误差 ${worst.toFixed(3)} nm`,
        detail: `命中 ${m.inliers} 条 · R²=${(m.r2 ?? 0).toFixed(4)}`,
      };
    },
  },
  {
    id: 'noise',
    name: '噪声鲁棒性',
    desc: '噪声从 1 加到 8，峰数与标定是否还稳',
    run(seed) {
      const r = rnd(seed);
      const a = 0.08 + r() * 0.08, b = 372, width = Math.round((700 - 380) / a) + 20;
      const lines = C.ELEMENTS.Hg.lines.filter((l) => l > b + 5 && l < b + a * width);
      let base = null, worstDrop = 0;
      for (const noise of [1, 3, 6, 8]) {
        const prof = C.syntheticProfile({ width, a, b, lines, sigmaPx: 2.6, noise, seed });
        const peaks = C.findPeaks(C.smoothProfile(prof, 5), { minProminence: 0.06, minDistance: 5 });
        if (base == null) base = peaks.length;
        worstDrop = Math.max(worstDrop, Math.abs(peaks.length - base));
      }
      return {
        pass: worstDrop <= 2 && base >= 4,
        metric: `峰数波动 ±${worstDrop}（基准 ${base}）`,
        detail: '同一张图只改噪声水平',
      };
    },
  },
  {
    id: 'element',
    name: '元素识别',
    desc: '三种灯各自出题，看第一名是不是它自己',
    run(seed) {
      const lamps = ['Hg', 'Na', 'H'];
      const r = rnd(seed);
      const results = [];
      for (const lamp of lamps) {
        const s = makeSpectrum({ seed: seed + lamp.charCodeAt(0) + Math.floor(r() * 1000), lamp });
        const res = C.identifyElements(s.xs, { tol: 2, minInliers: 3 });
        results.push({ lamp, top: res[0]?.key ?? '—', ok: res[0]?.key === lamp });
      }
      const ok = results.filter((x) => x.ok).length;
      return {
        pass: ok === 3,
        metric: `${ok}/3 认对`,
        detail: results.map((x) => `${x.lamp}→${x.top}`).join(' · '),
      };
    },
  },
  {
    id: 'doublet',
    name: '双线分辨',
    desc: '钠双线 589.0/589.6 在疏色散下应合并、密色散下应分开',
    run(seed) {
      const r = rnd(seed);
      const lines = [588.995, 589.592];
      const wide = C.syntheticProfile({ width: 4000, a: 0.05, b: 400, lines, sigmaPx: 1.6, noise: 0.6, seed });
      const dense = C.syntheticProfile({ width: 800, a: 0.5, b: 400, lines, sigmaPx: 1.2, noise: 0.6, seed: seed + 1 });
      const pw = C.findPeaks(C.smoothProfile(wide, 3), { minProminence: 0.05, minDistance: 2 });
      const pd = C.findPeaks(C.smoothProfile(dense, 3), { minProminence: 0.05, minDistance: 2 });
      const sepPx = 0.5968 / 0.05;
      return {
        pass: pw.length >= 2 && pd.length <= 1,
        metric: `密色散 ${pw.length} 峰（间距 ${(0.5968 / 0.05).toFixed(0)}px）· 疏色散 ${pd.length} 峰`,
        detail: `随机种子 ${seed}`,
      };
    },
  },
  {
    id: 'grating',
    name: '光栅方程往返',
    desc: 'd, k, λ → θ → d，误差应小于 1e-6 nm',
    run(seed) {
      const r = rnd(seed);
      let worst = 0;
      for (let i = 0; i < 20; i++) {
        const d = 900 + r() * 1500;        // d ≥ 900 nm，保证一级 700 nm 也能出现
        const k = 1;
        const lam = 400 + r() * 280;       // 400–680 nm
        const th = C.angleForWavelength(d, k, lam);
        const back = C.gratingConstant(k, th, lam);
        worst = Math.max(worst, Math.abs(back - d));
      }
      return { pass: worst < 1e-6, metric: `最大回差 ${worst.toExponential(1)} nm`, detail: '20 组随机参数' };
    },
  },
  {
    id: 'subpixel',
    name: '亚像素精度',
    desc: '峰位不在整像素上时，插值应把误差压到 0.3 px 内',
    run(seed) {
      const r = rnd(seed);
      let worst = 0;
      for (let i = 0; i < 8; i++) {
        const center = 60 + r() * 400;
        const prof = new Float32Array(600);
        for (let x = 0; x < 600; x++) prof[x] = 5 + 300 * Math.exp(-((x - center) ** 2) / (2 * 2.2 * 2.2));
        const peaks = C.findPeaks(prof, { minProminence: 0.1, minDistance: 3 });
        if (peaks.length) worst = Math.max(worst, Math.abs(peaks[0].x - center));
      }
      return { pass: worst < 0.3, metric: `最大 ${worst.toFixed(3)} px`, detail: '8 个随机亚像素位置' };
    },
  },
  {
    id: 'color',
    name: '颜色映射',
    desc: '红 424–438↓、绿 442–488↑、蓝 492–508↓、红 512–578↑、绿 584–643↓',
    run() {
      const segs = [
        [424, 438, 4, 0, false], // 红降（紫→蓝）
        [442, 488, 4, 1, true],  // 绿升
        [492, 508, 2, 2, false], // 蓝降
        [512, 578, 4, 0, true],  // 红升
        [584, 643, 4, 1, false], // 绿降
      ];
      const bad = [];
      for (const [a, b, st, ch, up] of segs) {
        for (let wl = a; wl < b; wl += st) {
          const x = C.wavelengthToRgb(wl)[ch];
          const y = C.wavelengthToRgb(wl + st)[ch];
          if (!(up ? y >= x - 1 : y <= x + 1)) bad.push(wl);
        }
      }
      const [r1, g1, b1] = C.wavelengthToRgb(546.1);
      const [r2, g2] = C.wavelengthToRgb(650);
      const [r3, , b3] = C.wavelengthToRgb(420);
      const sane = g1 > r1 && r2 > g2 && b3 > r3;
      return {
        pass: bad.length === 0 && sane,
        metric: bad.length ? `${bad.length} 处逆序（首个 ${bad[0]} nm）` : '单调性成立',
        detail: `546 偏绿 / 650 偏红 / 420 偏蓝：${sane ? '是' : '否'}`,
      };
    },
  },
];

/* ------------------------------------------------------------ DOM 渲染 */
const elSuites = $('#suites');
const elLog = $('#log');
let running = false;
let stopFlag = false;
let lastReport = null;

function renderShell() {
  elSuites.innerHTML = SUITES.map((s) => `
    <div class="suite" id="suite-${s.id}">
      <div class="suite-head">
        <span class="status" id="st-${s.id}"></span>
        <span class="suite-name">${s.name}</span>
        <span class="suite-desc" style="font-size:11.5px;color:var(--muted)">${s.desc}</span>
        <span class="suite-detail" id="dt-${s.id}">—</span>
      </div>
      <div class="suite-bar"><i id="bar-${s.id}"></i></div>
    </div>`).join('');
}

function setStatus(id, status, detail) {
  const st = $('#st-' + id);
  if (st) st.className = 'status ' + status;
  if (detail != null) { const d = $('#dt-' + id); if (d) d.textContent = detail; }
  const bar = $('#bar-' + id);
  if (bar) bar.style.width = status === 'pass' ? '100%' : status === 'fail' ? '100%' : '30%';
}

function log(line, cls = '') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = line;
  elLog.prepend(div);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 运行 */
async function runRound(seedBase, roundLabel = '') {
  const t0 = performance.now();
  const results = [];
  for (const s of SUITES) {
    if (stopFlag) break;
    setStatus(s.id, 'run', '运行中…');
    await sleep(0);
    let res;
    try {
      res = s.run(seedBase + Math.floor(Math.random() * 100000));
    } catch (e) {
      res = { pass: false, metric: '异常', detail: e.message };
    }
    results.push({ id: s.id, name: s.name, ...res });
    setStatus(s.id, res.pass ? 'pass' : 'fail', res.metric);
    log(`${res.pass ? '✓' : '✗'} ${s.name} — ${res.metric}${res.detail ? `（${res.detail}）` : ''}`, res.pass ? 'ok' : 'no');
    await sleep(0);
  }
  const ms = performance.now() - t0;
  const pass = results.filter((r) => r.pass).length;
  return { seedBase, results, pass, total: results.length, ms, roundLabel };
}

function updateCards(round) {
  $('#card-pass b').textContent = `${round.pass} / ${round.total}`;
  const rate = round.pass / round.total;
  $('#card-rate b').textContent = `${(rate * 100).toFixed(0)}%`;
  $('#card-rate').className = 'card ' + (rate === 1 ? 'good' : rate >= 0.75 ? '' : 'bad');

  const calib = round.results.find((r) => r.id === 'calib');
  const m = calib?.metric?.match(/([\d.]+)/);
  $('#card-worst b').textContent = m ? `${m[1]} nm` : '—';
  $('#card-worst').className = 'card ' + (m && Number(m[1]) < 0.3 ? 'good' : '');

  $('#card-time b').textContent = `${round.ms.toFixed(0)} ms`;
}

async function runOnce() {
  if (running) return;
  running = true; stopFlag = false;
  $('#run-once').disabled = true; $('#run-loop').disabled = true; $('#stop').disabled = false;
  elLog.innerHTML = '';
  const round = await runRound(Date.now() % 100000, '单轮');
  updateCards(round);
  lastReport = { mode: 'once', ...round };
  log(`—— 本轮 ${round.pass}/${round.total} 通过，用时 ${round.ms.toFixed(0)} ms ——`, round.pass === round.total ? 'ok' : 'no');
  running = false;
  $('#run-once').disabled = false; $('#run-loop').disabled = false; $('#stop').disabled = true;
}

async function runLoop(n = 30) {
  if (running) return;
  running = true; stopFlag = false;
  $('#run-once').disabled = true; $('#run-loop').disabled = true; $('#stop').disabled = false;
  elLog.innerHTML = '';
  const rounds = [];
  let worstRate = 1, worstMetric = 0;
  for (let i = 1; i <= n && !stopFlag; i++) {
    const round = await runRound(1000 + i * 7919, `第 ${i} 轮`);
    rounds.push(round);
    worstRate = Math.min(worstRate, round.pass / round.total);
    const calib = round.results.find((r) => r.id === 'calib');
    const m = calib?.metric?.match(/([\d.]+)/);
    if (m) worstMetric = Math.max(worstMetric, Number(m[1]));
    updateCards(round);
    $('#loop-info').textContent = `第 ${i}/${n} 轮 · 当前最差 ${(worstRate * 100).toFixed(0)}%`;
    await sleep(10);
  }
  const totalPass = rounds.reduce((s, r) => s + r.pass, 0);
  const totalTests = rounds.reduce((s, r) => s + r.total, 0);
  log(`—— ${rounds.length} 轮：${totalPass}/${totalTests} 通过，最差单轮 ${(worstRate * 100).toFixed(0)}%，最差标定误差 ${worstMetric.toFixed(3)} nm ——`,
    worstRate === 1 ? 'ok' : 'no');
  lastReport = { mode: 'loop', rounds: rounds.length, totalPass, totalTests, worstRate, worstMetric };
  running = false;
  $('#run-once').disabled = false; $('#run-loop').disabled = false; $('#stop').disabled = true;
}

/* ------------------------------------------------------------ 导出 */
function exportJSON() {
  if (!lastReport) return;
  const blob = new Blob([JSON.stringify({ app: 'SpectraLab-lab', version: C.VERSION, at: new Date().toISOString(), ...lastReport }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spectralab-lab-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------ 初始化 */
renderShell();
$('#run-once').addEventListener('click', runOnce);
$('#run-loop').addEventListener('click', () => runLoop(30));
$('#stop').addEventListener('click', () => { stopFlag = true; });
$('#export').addEventListener('click', exportJSON);

// 进入页面自动跑一轮，保证"打开即见证据"
setTimeout(runOnce, 200);
