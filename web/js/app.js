/**
 * SpectraLab UI v2.0
 * 只做"交互与渲染"，所有算法来自 core.js（可被 Node 测试）。
 */
import * as C from './core.js';

/* ------------------------------------------------------------------ 工具 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

const S = {
  img: null,
  srcCanvas: null,
  imgData: null,
  width: 0,
  height: 0,
  rowFrac: 0.5,
  band: 9,
  params: { sensitivity: 0.06, minDistance: 6, smooth: 5 },
  peaks: [],
  wavelengths: [],
  model: null,          // { type, a, b, c?, r2, rms, inliers, lamp }
  elements: [],
  lamp: 'Hg',
  quad: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  baseScale: 1,
  grating: null,
  lastMs: 0,
  showMarks: true,
  showProfile: true,
};

let els = {};

/* ------------------------------------------------------------------ 主题 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('sl-theme', theme);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#070a14');
  requestAnimationFrame(renderAll);
}

function initTheme() {
  const saved = localStorage.getItem('sl-theme');
  const forced = new URLSearchParams(location.search).get('theme');
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  applyTheme(forced === 'light' || forced === 'dark' ? forced : (saved || (prefersLight ? 'light' : 'dark')));
}

/* ------------------------------------------------------------------ 提示 */
let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = els.toast;
  t.textContent = msg;
  if (!t.open) { try { t.show(); } catch { /* ignore */ } }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { try { if (t.open) t.close(); } catch { /* ignore */ } }, 250);
  }, ms);
}

/* ------------------------------------------------------------------ 图像载入 */
function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

async function loadFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('这不是图片文件'); return; }
  try {
    const url = URL.createObjectURL(file);
    const img = await loadImageEl(url);
    URL.revokeObjectURL(url);
    setImage(img);
    $('#file-meta').textContent = `${file.name.slice(0, 18)}`;
  } catch (e) {
    toast(e.message || '载入失败');
  }
}

function setImage(img) {
  const maxW = 2400;
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  S.img = img;
  S.srcCanvas = c;
  S.imgData = ctx.getImageData(0, 0, w, h);
  S.width = w; S.height = h;
  S.rowFrac = 0.5;
  S.zoom = 1; S.panX = 0; S.panY = 0;
  S.model = null; S.elements = []; S.wavelengths = [];

  els.canvasEmpty.hidden = true;
  els.dropzone.classList.add('has-image');
  els.dzTitle.textContent = '已载入 · 换一张';
  els.dzSub.textContent = '也可以把新图直接拖进来覆盖';
  els.rowRange.value = String(Math.round(S.rowFrac * 1000));
  els.rowLabel.textContent = '50%';
  els.stSize.textContent = `${w} × ${h} px`;
  $('#file-meta').textContent = `${w}×${h}`;

  analyze();
}

/* ------------------------------------------------------------------ 分析 */
function analyze() {
  if (!S.imgData) return;
  const t0 = performance.now();

  const rowY = clamp(Math.round(S.rowFrac * (S.height - 1)), 0, S.height - 1);
  const raw = C.extractProfile(S.imgData, rowY, S.band);
  const smooth = C.smoothProfile(raw, S.params.smooth);
  S.profileRaw = raw;
  S.profile = smooth;

  S.peaks = C.findPeaks(smooth, {
    minProminence: S.params.sensitivity,
    minDistance: S.params.minDistance,
    maxPeaks: 80,
  });

  // 已有标定则沿用；否则尝试用当前灯源自动标定
  if (!S.model) {
    const m = tryAutoCalibrate();
    if (m) S.model = m;
  }
  refreshDerived();
  S.lastMs = performance.now() - t0;
  renderAll();
  els.stTime.textContent = `${S.lastMs.toFixed(0)} ms`;
}

function tryAutoCalibrate() {
  if (S.peaks.length < 3) return null;
  const xs = S.peaks.map((p) => p.x);
  const m = C.calibrateWithLamp(xs, S.lamp, { tol: 3, minInliers: 3 });
  if (!m) return null;
  return { type: 'linear', ...m, lamp: S.lamp };
}

function refreshDerived() {
  const xs = S.peaks.map((p) => p.x);
  if (S.model) {
    S.wavelengths = xs.map((x) => S.model.predict(x));
  } else {
    S.wavelengths = xs.map(() => null);
  }
  S.elements = xs.length >= 3 ? C.identifyElements(xs, { tol: 1.8, minInliers: 3 }) : [];
}

/* ------------------------------------------------------------------ 渲染总入口 */
function renderAll() {
  drawStage();
  drawProfile();
  renderPeaksTable();
  renderCalib();
  renderElements();
  els.badgePeaks.textContent = String(S.peaks.length);
  els.stPeaks.textContent = `${S.peaks.length} 条谱线`;
}

/* ------------------------------------------------------------------ 画布 */
function computeLayout() {
  const wrap = els.canvasWrap;
  const W = wrap.clientWidth || 800;
  const H = wrap.clientHeight || 400;
  if (!S.width) return { W, H, dispW: W, dispH: H, scale: 1 };
  const fit = Math.min(W / S.width, (H - 8) / S.height, 1.4);
  S.baseScale = fit;
  const scale = fit * S.zoom;
  return { W, H, dispW: S.width * scale, dispH: S.height * scale, scale };
}

function drawStage() {
  const cvs = els.stage;
  if (!cvs) return;
  const { W, H, dispW, dispH } = computeLayout();
  const r = dpr();
  cvs.width = Math.max(1, Math.round(W * r));
  cvs.height = Math.max(1, Math.round(H * r));
  cvs.style.width = `${W}px`;
  cvs.style.height = `${H}px`;
  cvs.style.position = 'absolute';
  const ctx = cvs.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (!S.srcCanvas) return;

  // 居中
  const offX = S.panX + (W - dispW) / 2;
  const offY = S.panY + (H - dispH) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.srcCanvas, offX, offY, dispW, dispH);

  // 剖面行
  const rowY = clamp(S.rowFrac * S.height, 0, S.height - 1) * (dispH / S.height);
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(34, 211, 238, .85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(offX, offY + rowY);
  ctx.lineTo(offX + dispW, offY + rowY);
  ctx.stroke();
  ctx.restore();

  // 峰值标记
  if (S.showMarks && S.peaks.length) {
    const sx = dispW / S.width;
    const halfMark = Math.max(10, Math.min(26, dispH * 0.12));
    S.peaks.forEach((p, i) => {
      const x = offX + p.x * sx;
      const yTop = offY + Math.max(0, rowY - halfMark);
      const yBot = offY + Math.min(dispH, rowY + halfMark);
      const wl = S.wavelengths[i];
      const color = wl ? C.rgbCss(C.wavelengthToRgb(wl)) : 'rgba(255,255,255,.75)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBot);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, yTop, 2.6, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/* ------------------------------------------------------------------ 剖面图 */
function drawProfile() {
  const cvs = els.profile;
  if (!cvs || !S.profile) return;
  const wrap = els.profileWrap;
  if (!S.showProfile) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  const W = cvs.clientWidth || 600;
  const H = 84;
  const r = dpr();
  cvs.width = Math.round(W * r);
  cvs.height = Math.round(H * r);
  const ctx = cvs.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const prof = S.profile;
  const n = prof.length;
  let max = 0, min = Infinity;
  for (const v of prof) { if (v > max) max = v; if (v < min) min = v; }
  const span = Math.max(1e-6, max - min);

  // 面积
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(124,92,255,.55)');
  grad.addColorStop(1, 'rgba(34,211,238,.05)');
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    const y = H - ((prof[i] - min) / span) * (H - 10) - 4;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(180,200,255,.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 峰
  if (S.showMarks) {
    S.peaks.forEach((p, i) => {
      const x = (p.x / (n - 1)) * W;
      const y = H - ((p.height - min) / span) * (H - 10) - 4;
      const wl = S.wavelengths[i];
      ctx.fillStyle = wl ? C.rgbCss(C.wavelengthToRgb(wl)) : '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/* ------------------------------------------------------------------ 表格 */
function renderPeaksTable() {
  const empty = els.peaksEmpty;
  const wrap = els.peaksTableWrap;
  if (!S.peaks.length) {
    empty.hidden = false; wrap.hidden = true;
    empty.textContent = S.imgData
      ? '没找到明显谱线。试试调低「灵敏度」、调小「最小间距」，或换一行更亮的剖面。'
      : '载入图像并检测后，这里列出每条谱线的位置、波长与颜色。';
    return;
  }
  empty.hidden = true; wrap.hidden = false;

  const maxH = Math.max(...S.peaks.map((p) => p.height));
  const tbody = $('#peaks-table tbody');
  tbody.innerHTML = S.peaks.map((p, i) => {
    const wl = S.wavelengths[i];
    const rgb = wl ? C.wavelengthToRgb(wl) : [120, 120, 130];
    const rel = maxH > 0 ? p.height / maxH : 0;
    const matched = wl ? nearestReference(wl) : null;
    return `<tr>
      <td>${i + 1}</td>
      <td>${p.x.toFixed(1)}</td>
      <td>${wl == null ? '—' : wl.toFixed(2)}</td>
      <td>${(rel * 100).toFixed(0)}%
        <span class="swatch" style="background:${C.rgbCss(rgb)};color:${C.rgbCss(rgb)}"></span>
      </td>
      <td>${matched ? `${matched.key} ${matched.lam.toFixed(1)}` : '—'}</td>
    </tr>`;
  }).join('');
}

function nearestReference(wl) {
  let best = null;
  for (const [key, el] of Object.entries(C.ELEMENTS)) {
    for (const lam of el.lines) {
      const d = Math.abs(lam - wl);
      if (d < (best?.d ?? 0.8) && d <= 0.8) best = { key, lam, d };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ 标定面板 */
function renderCalib() {
  const body = els.calibBody;
  const empty = els.calibEmpty;
  if (!S.model) {
    body.hidden = true; empty.hidden = false;
    empty.textContent = S.peaks.length
      ? `谱线 ${S.peaks.length} 条，但没能用 ${S.lamp} 灯自动对上。可以换灯源、调低灵敏度，或手动输入两点。`
      : '选一个灯源后点「自动标定」，这里会给出色散率、截距与拟合质量。';
    return;
  }
  empty.hidden = true; body.hidden = false;

  const m = S.model;
  els.cA.textContent = m.a.toFixed(5);
  els.cB.textContent = m.b.toFixed(2);
  els.cR2.textContent = m.r2 ? m.r2.toFixed(4) : '—';
  els.cRms.textContent = m.rms != null ? m.rms.toFixed(3) : '—';
  els.cNote.textContent = `${m.type === 'quad' ? '二次' : '线性'}标定 · 命中 ${m.inliers} 条 · 来源 ${m.lamp || '手动'}`;

  drawFitChart();
}

function drawFitChart() {
  const cvs = els.fitChart;
  const W = cvs.clientWidth || 320;
  const H = 150;
  const r = dpr();
  cvs.width = Math.round(W * r);
  cvs.height = Math.round(H * r);
  const ctx = cvs.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pairs = S.model?.pairs || [];
  if (!pairs.length) return;
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const x0 = Math.min(...xs) - 8, x1 = Math.max(...xs) + 8;
  const y0 = Math.min(...ys) - 8, y1 = Math.max(...ys) + 8;
  const pad = 18;
  const X = (x) => pad + ((x - x0) / (x1 - x0)) * (W - pad * 2);
  const Y = (y) => H - pad - ((y - y0) / (y1 - y0)) * (H - pad * 2);

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yy = pad + ((H - pad * 2) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(W - pad, yy); ctx.stroke();
  }

  // 拟合线
  ctx.strokeStyle = 'rgba(34,211,238,.8)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const x = x0 + ((x1 - x0) * i) / 60;
    const y = S.model.predict(x);
    i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y));
  }
  ctx.stroke();

  // 点
  pairs.forEach(([x, y]) => {
    ctx.fillStyle = 'rgba(124,92,255,.95)';
    ctx.beginPath(); ctx.arc(X(x), Y(y), 3, 0, Math.PI * 2); ctx.fill();
  });

  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`${y1.toFixed(0)} nm`, 4, 12);
  ctx.fillText(`${y0.toFixed(0)} nm`, 4, H - 4);
}

/* ------------------------------------------------------------------ 元素面板 */
function renderElements() {
  const body = els.elementsBody;
  const empty = els.elementsEmpty;
  if (!S.elements.length) {
    body.hidden = true; empty.hidden = false;
    empty.textContent = S.peaks.length >= 3
      ? '没有元素能对上 3 条以上谱线。可能这张图不是发射光谱，或者标定没做好。'
      : '识别结果会按"命中谱线数"排序，并给出每条线的残差。';
    return;
  }
  empty.hidden = true; body.hidden = false;

  const top = S.elements.slice(0, 5);
  body.innerHTML = top.map((el, i) => {
    const hits = new Set();
    for (const wl of S.wavelengths) {
      if (wl == null) continue;
      for (const lam of C.ELEMENTS[el.key].lines) {
        if (Math.abs(lam - wl) <= 0.9) hits.add(lam);
      }
    }
    const chips = C.ELEMENTS[el.key].lines
      .map((l) => `<span class="line-chip ${hits.has(l) ? 'hit' : ''}">${l.toFixed(1)}</span>`)
      .join('');
    return `<div class="elem-card ${i === 0 ? 'top' : ''}">
      <div class="elem-head">
        <div class="elem-name"><span class="elem-dot" style="background:${el.color};color:${el.color}"></span>${el.name}</div>
        <div class="elem-meta">命中 ${el.inliers} · RMS ${el.rms.toFixed(2)} nm</div>
      </div>
      <div class="elem-lines">${chips}</div>
    </div>`;
  }).join('');
}

/* ------------------------------------------------------------------ 交互 */
function bindRowControls() {
  els.rowRange.addEventListener('input', () => {
    S.rowFrac = Number(els.rowRange.value) / 1000;
    els.rowLabel.textContent = `${Math.round(S.rowFrac * 100)}%`;
    analyze();
  });
  els.bandRange.addEventListener('input', () => {
    S.band = Number(els.bandRange.value);
    els.bandLabel.textContent = `${S.band} px`;
    analyze();
  });
}

function bindParams() {
  const map = [
    ['sens', 'sensitivity', 'v-sens', (v) => `${v}%`, (v) => v / 100],
    ['dist', 'minDistance', 'v-dist', (v) => `${v} px`, (v) => v],
    ['smooth', 'smooth', 'v-smooth', (v) => `${v}`, (v) => v],
  ];
  map.forEach(([id, key, labelId, fmt, conv]) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = Number(el.value);
      S.params[key] = conv(v);
      document.getElementById(labelId).textContent = fmt(v);
      analyze();
    });
  });
}

function bindStage() {
  const wrap = els.canvasWrap;
  const cvs = els.stage;
  let mode = null;
  let start = null;

  const toImage = (ev) => {
    const rect = cvs.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const { dispW, dispH } = computeLayout();
    const offX = S.panX + (wrap.clientWidth - dispW) / 2;
    const offY = S.panY + (wrap.clientHeight - dispH) / 2;
    return {
      x: clamp(((px - offX) / dispW) * S.width, 0, S.width - 1),
      y: clamp(((py - offY) / dispH) * S.height, 0, S.height - 1),
      px, py,
    };
  };

  const rowScreenY = () => {
    const { H, dispH } = computeLayout();
    const offY = S.panY + (H - dispH) / 2;
    return offY + (S.rowFrac * S.height) * (dispH / S.height);
  };

  cvs.addEventListener('pointerdown', (ev) => {
    if (!S.imgData) return;
    const rect = cvs.getBoundingClientRect();
    const py = ev.clientY - rect.top;
    const nearRow = Math.abs(py - rowScreenY()) < 10;
    mode = nearRow ? 'row' : 'pan';
    start = { x: ev.clientX, y: ev.clientY, panX: S.panX, panY: S.panY, row: S.rowFrac };
    cvs.setPointerCapture(ev.pointerId);
    wrap.classList.add('grabbing');
  });

  cvs.addEventListener('pointermove', (ev) => {
    if (!S.imgData) return;
    if (mode === 'row') {
      const rect = cvs.getBoundingClientRect();
      const { H, dispH } = computeLayout();
      const offY = S.panY + (H - dispH) / 2;
      const py = ev.clientY - rect.top;
      S.rowFrac = clamp((py - offY) / dispH, 0, 1);
      els.rowRange.value = String(Math.round(S.rowFrac * 1000));
      els.rowLabel.textContent = `${Math.round(S.rowFrac * 100)}%`;
      analyze();
      return;
    }
    if (mode === 'pan') {
      S.panX = start.panX + (ev.clientX - start.x);
      S.panY = start.panY + (ev.clientY - start.y);
      drawStage();
      return;
    }
    // hover tooltip
    const p = toImage(ev);
    let best = null, bd = 12;
    for (const pk of S.peaks) {
      const d = Math.abs(pk.x - p.x);
      if (d < bd) { bd = d; best = pk; }
    }
    if (best) {
      const i = S.peaks.indexOf(best);
      const wl = S.wavelengths[i];
      els.tip.hidden = false;
      els.tip.innerHTML = `x ${best.x.toFixed(1)} px${wl ? `<br>λ ${wl.toFixed(2)} nm` : ''}`;
      els.tip.style.left = `${p.px + 12}px`;
      els.tip.style.top = `${p.py - 10}px`;
    } else {
      els.tip.hidden = true;
    }
  });

  const end = () => {
    mode = null;
    wrap.classList.remove('grabbing');
  };
  cvs.addEventListener('pointerup', end);
  cvs.addEventListener('pointercancel', end);
  cvs.addEventListener('pointerleave', () => { if (!mode) els.tip.hidden = true; });

  wrap.addEventListener('wheel', (ev) => {
    if (!S.imgData) return;
    ev.preventDefault();
    const before = S.zoom;
    S.zoom = clamp(S.zoom * (ev.deltaY < 0 ? 1.12 : 0.89), 0.6, 10);
    if (S.zoom !== before) {
      els.zoomLabel.textContent = `${Math.round(S.zoom * 100)}%`;
      drawStage();
    }
  }, { passive: false });

  $('#zoom-in').addEventListener('click', () => { S.zoom = clamp(S.zoom * 1.25, 0.6, 10); syncZoomLabel(); drawStage(); });
  $('#zoom-out').addEventListener('click', () => { S.zoom = clamp(S.zoom / 1.25, 0.6, 10); syncZoomLabel(); drawStage(); });
  $('#zoom-fit').addEventListener('click', () => { S.zoom = 1; S.panX = 0; S.panY = 0; syncZoomLabel(); drawStage(); });

  $('#show-profile').addEventListener('change', (e) => { S.showProfile = e.target.checked; drawProfile(); });
  $('#show-marks').addEventListener('change', (e) => { S.showMarks = e.target.checked; drawStage(); drawProfile(); });

  window.addEventListener('resize', () => { drawStage(); drawProfile(); });
}

function syncZoomLabel() { els.zoomLabel.textContent = `${Math.round(S.zoom * 100)}%`; }

/* ------------------------------------------------------------------ 标定操作 */
function bindCalibration() {
  const sel = els.lamp;
  sel.innerHTML = C.LAMPS.map((l) => `<option value="${l.key}">${l.label}</option>`).join('');
  sel.value = S.lamp;
  sel.addEventListener('change', () => {
    S.lamp = sel.value;
    const note = C.LAMPS.find((l) => l.key === sel.value)?.note || '';
    els.lampNote.textContent = note;
    S.model = null;
    analyze();
  });

  els.btnCalib.addEventListener('click', () => {
    if (!S.peaks.length) { toast('先载入图像'); return; }
    const xs = S.peaks.map((p) => p.x);
    let m = C.calibrateWithLamp(xs, S.lamp, { tol: 3, minInliers: 3 });
    if (!m) { toast('对不上，试试换灯源或调低灵敏度'); return; }
    if (els.quad.checked && m.pairs.length >= 3) {
      const q = C.quadraticFit(m.pairs.map((p) => p[0]), m.pairs.map((p) => p[1]));
      m = { type: 'quad', ...q, inliers: m.pairs.length, lamp: S.lamp, pairs: m.pairs };
    } else {
      m = { type: 'linear', ...m, lamp: S.lamp };
    }
    S.model = m;
    refreshDerived();
    renderAll();
    toast(`标定成功 · 命中 ${m.pairs?.length ?? m.inliers} 条`);
  });

  els.btnClearCalib.addEventListener('click', () => {
    S.model = null;
    refreshDerived();
    renderAll();
    toast('已清除标定');
  });

  els.btnManual.addEventListener('click', () => {
    const x1 = parseFloat($('#m-x1').value), l1 = parseFloat($('#m-l1').value);
    const x2 = parseFloat($('#m-x2').value), l2 = parseFloat($('#m-l2').value);
    if ([x1, l1, x2, l2].some((v) => !Number.isFinite(v))) { toast('四个数都要填'); return; }
    if (Math.abs(x2 - x1) < 1e-6) { toast('x₁ 与 x₂ 不能相同'); return; }
    const fit = C.linearFit([x1, x2], [l1, l2]);
    S.model = { type: 'linear', ...fit, inliers: 2, lamp: '手动', pairs: [[x1, l1], [x2, l2]] };
    refreshDerived();
    renderAll();
    toast('两点标定已套用');
  });
}

/* ------------------------------------------------------------------ 光栅 */
function bindGrating() {
  els.btnGrating.addEventListener('click', () => {
    const k = Number($('#g-k').value);
    const left = parseFloat($('#g-left').value);
    const right = parseFloat($('#g-right').value);
    const lam = Number($('#g-lambda').value);
    const sigma = Number($('#g-sigma').value) || 0;

    let theta = null;
    if (Number.isFinite(left) && Number.isFinite(right)) theta = C.deflectionAngle(left, right);
    if (theta == null) { toast('填左右游标读数（或直接给出角度）'); return; }
    if (!(lam > 0)) { toast('波长要大于 0'); return; }

    try {
      const u = C.gratingUncertainty(k, theta, lam, sigma);
      S.grating = { k, theta, lam, ...u };
      els.gratingOut.hidden = false;
      els.gratingOut.innerHTML =
        `衍射角 θ = <b>${theta.toFixed(3)}°</b> · 级次 k = ${k} · λ = ${lam.toFixed(2)} nm<br>` +
        `d = kλ / sinθ = <b>${u.d.toFixed(1)} nm</b> = <b>${(u.d / 1000).toFixed(4)} μm</b><br>` +
        `σ<sub>d</sub> = ${u.sigma.toFixed(1)} nm（相对 ${(u.rel * 100).toFixed(2)}%）`;
    } catch (e) {
      toast(e.message);
    }
  });
}

/* ------------------------------------------------------------------ 导出 */
function download(name, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function bindExport() {
  $('#btn-csv').addEventListener('click', () => {
    if (!S.peaks.length) { toast('还没有数据'); return; }
    const maxH = Math.max(...S.peaks.map((p) => p.height));
    const rows = [['index', 'x_px', 'wavelength_nm', 'rel_intensity'].join(',')];
    S.peaks.forEach((p, i) => {
      rows.push([i + 1, p.x.toFixed(3), S.wavelengths[i]?.toFixed(3) ?? '', (p.height / maxH).toFixed(4)].join(','));
    });
    download(`spectralab-peaks-${stamp()}.csv`, '\uFEFF' + rows.join('\r\n'), 'text/csv');
  });

  $('#btn-json').addEventListener('click', () => {
    if (!S.peaks.length) { toast('还没有数据'); return; }
    const data = {
      app: 'SpectraLab', version: C.VERSION, generatedAt: new Date().toISOString(),
      image: { width: S.width, height: S.height, rowFraction: S.rowFrac, band: S.band },
      params: S.params,
      calibration: S.model ? {
        type: S.model.type, a: S.model.a, b: S.model.b, c: S.model.c ?? null,
        r2: S.model.r2, rms: S.model.rms, inliers: S.model.inliers, lamp: S.model.lamp,
      } : null,
      grating: S.grating,
      peaks: S.peaks.map((p, i) => ({
        x: +p.x.toFixed(3),
        wavelength: S.wavelengths[i] != null ? +S.wavelengths[i].toFixed(3) : null,
        height: +p.height.toFixed(1),
        prominence: +p.prominence.toFixed(1),
      })),
      elements: S.elements.map((e) => ({ key: e.key, inliers: e.inliers, rms: +e.rms.toFixed(3) })),
    };
    download(`spectralab-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  });
}

/* ------------------------------------------------------------------ 报告 */
function buildReportCanvas() {
  const W = 1600, H = 1160;
  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // 顶部色带
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#7c5cff');
  grad.addColorStop(0.35, '#22d3ee');
  grad.addColorStop(0.7, '#34d399');
  grad.addColorStop(1, '#f59e0b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 8);

  const title = $('#r-title').value || '光谱分析报告';
  const name = $('#r-name').value || '';
  const id = $('#r-id').value || '';

  ctx.fillStyle = '#0f172a';
  ctx.font = '600 34px "Microsoft YaHei", sans-serif';
  ctx.fillText(title, 64, 70);

  ctx.fillStyle = '#64748b';
  ctx.font = '16px "Microsoft YaHei", sans-serif';
  ctx.fillText(`SpectraLab v${C.VERSION} · ${new Date().toLocaleString('zh-CN')}`, 64, 100);
  if (name || id) ctx.fillText([name, id].filter(Boolean).join(' · '), 64, 126);

  // 图像
  const imgY = 150;
  const imgW = W - 128;
  const imgH = Math.min(300, (S.height / S.width) * imgW);
  if (S.srcCanvas) {
    ctx.drawImage(S.srcCanvas, 64, imgY, imgW, imgH);
    ctx.strokeStyle = '#e2e8f0';
    ctx.strokeRect(64, imgY, imgW, imgH);
  }

  // 校准摘要
  let y = imgY + imgH + 46;
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 20px "Microsoft YaHei", sans-serif';
  ctx.fillText('标定', 64, y);
  ctx.font = '16px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#334155';
  if (S.model) {
    ctx.fillText(`λ = ${S.model.a.toFixed(5)}·x + ${S.model.b.toFixed(3)}    R² = ${(S.model.r2 ?? 0).toFixed(4)}    RMS = ${(S.model.rms ?? 0).toFixed(3)} nm    (${S.model.lamp || '手动'})`, 64, y + 30);
  } else {
    ctx.fillText('未标定', 64, y + 30);
  }

  // 光栅
  y += 80;
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 20px "Microsoft YaHei", sans-serif';
  ctx.fillText('光栅常数', 64, y);
  ctx.font = '16px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#334155';
  if (S.grating) {
    ctx.fillText(`θ = ${S.grating.theta.toFixed(3)}°, k = ${S.grating.k}, λ = ${S.grating.lam.toFixed(2)} nm → d = ${S.grating.d.toFixed(1)} nm (${(S.grating.d / 1000).toFixed(4)} μm), σd = ${S.grating.sigma.toFixed(1)} nm`, 64, y + 30);
  } else {
    ctx.fillText('未计算（左侧「光栅常数」面板）', 64, y + 30);
  }

  // 谱线表
  y += 80;
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 20px "Microsoft YaHei", sans-serif';
  ctx.fillText(`谱线（共 ${S.peaks.length} 条）`, 64, y);

  const cols = [64, 140, 420, 700, 980];
  ctx.font = '600 15px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#64748b';
  ['#', 'x (px)', 'λ (nm)', '相对强度', '颜色'].forEach((h, i) => ctx.fillText(h, cols[i], y + 34));

  ctx.font = '15px ui-monospace, monospace';
  const maxH = Math.max(...S.peaks.map((p) => p.height), 1);
  const limit = Math.min(S.peaks.length, 12);
  for (let i = 0; i < limit; i++) {
    const p = S.peaks[i];
    const wl = S.wavelengths[i];
    const yy = y + 62 + i * 28;
    ctx.fillStyle = '#334155';
    ctx.fillText(String(i + 1), cols[0], yy);
    ctx.fillText(p.x.toFixed(1), cols[1], yy);
    ctx.fillText(wl == null ? '—' : wl.toFixed(2), cols[2], yy);
    ctx.fillText(`${((p.height / maxH) * 100).toFixed(0)}%`, cols[3], yy);
    if (wl != null) {
      ctx.fillStyle = C.rgbCss(C.wavelengthToRgb(wl));
      ctx.fillRect(cols[4], yy - 12, 22, 12);
    }
  }
  if (S.peaks.length > limit) {
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`… 另外 ${S.peaks.length - limit} 条见 CSV`, cols[0], y + 62 + limit * 28);
  }

  // 页脚
  ctx.fillStyle = '#94a3b8';
  ctx.font = '13px "Microsoft YaHei", sans-serif';
  ctx.fillText('图片仅在本机处理，未上传任何服务器。本报告由 SpectraLab 生成，结果需结合实验条件复核。', 64, H - 40);

  return cvs;
}

function bindReport() {
  $('#btn-report').addEventListener('click', () => {
    if (!S.imgData) { toast('先载入图像'); return; }
    const cvs = buildReportCanvas();
    const box = els.reportPreview;
    const url = cvs.toDataURL('image/png');
    box.hidden = false;
    box.innerHTML = `<img src="${url}" alt="分析报告预览"><div class="row-2" style="margin-top:10px"><a class="btn primary" download="spectralab-report-${stamp()}.png" href="${url}">保存 PNG</a></div>`;
    toast('报告已生成');
  });

  $('#btn-print').addEventListener('click', () => {
    if (!els.reportPreview.innerHTML) {
      $('#btn-report').click();
      setTimeout(() => window.print(), 300);
    } else {
      window.print();
    }
  });
}

/* ------------------------------------------------------------------ 示例图 */
function makeDemoImage() {
  const W = 2200, H = 640;
  const a = 0.105, b = 372;
  const lines = [...C.ELEMENTS.Hg.lines, ...C.ELEMENTS.Na.lines, ...C.ELEMENTS.H.lines]
    .filter((v) => v >= 380 && v <= 700);
  const prof = C.syntheticProfile({ width: W, a, b, lines, sigmaPx: 3.4, noise: 3, baseline: 8, seed: 11 });

  let max = 0, min = Infinity;
  for (const v of prof) { if (v > max) max = v; if (v < min) min = v; }
  const span = Math.max(1, max - min);

  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, W, H);

  const bandTop = Math.round(H * 0.38);
  const bandBot = Math.round(H * 0.62);
  const rand = C.rng(99);

  for (let x = 0; x < W; x++) {
    const t = (prof[x] - min) / span;
    const lam = b + a * x;
    const [r, g, bl] = C.wavelengthToRgb(lam);
    for (let y = bandTop; y < bandBot; y++) {
      const edge = 1 - Math.abs((y - (bandTop + bandBot) / 2) / ((bandBot - bandTop) / 2));
      const n = 0.9 + rand() * 0.2;
      // 0.14 的环境底 + 线本身的亮度：太暗的话截图/投影都看不见谱线
      const k = (0.14 + 0.9 * Math.pow(t, 0.75)) * edge * n;
      ctx.fillStyle = `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(bl * k)})`;
      ctx.fillRect(x, y, 1, 1);
    }
    // 暗部噪声
    for (let y = 0; y < H; y += 3) {
      if (y >= bandTop && y < bandBot) continue;
      const v = 8 + rand() * 10;
      ctx.fillStyle = `rgb(${v},${v},${v + 2})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // 一点竖向暗纹，模拟狭缝/传感器
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(rand() * W);
    ctx.fillRect(x, 0, 1, H);
  }

  return cvs;
}

function loadDemo() {
  const cvs = makeDemoImage();
  const img = new Image();
  img.onload = () => { setImage(img); toast('已载入示例光谱（合成）'); };
  img.src = cvs.toDataURL('image/png');
}

/* ------------------------------------------------------------------ PWA */
let deferredPrompt = null;
function bindPWA() {
  const params = new URLSearchParams(location.search);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    if (params.get('nocache') === '1') {
      // 调试用：清掉 SW 与缓存，避免"改了代码却还是旧页面"
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    } else {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    els.btnInstall.hidden = false;
  });
  els.btnInstall?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    els.btnInstall.hidden = true;
  });
}

/* ------------------------------------------------------------------ 初始化 */
function bindFileInputs() {
  els.btnFile.addEventListener('click', () => els.file.click());
  els.btnCamera.addEventListener('click', () => els.fileCamera.click());
  els.file.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
  els.fileCamera.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
  els.btnDemo.addEventListener('click', loadDemo);

  const dz = els.dropzone;
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => loadFile(e.dataTransfer?.files?.[0]));
  window.addEventListener('paste', (e) => {
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });
}

function bindTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      const key = tab.dataset.tab;
      $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === key));
      if (key === 'calib') drawFitChart();
    });
  });
}

function bindMisc() {
  $('#btn-reset').addEventListener('click', () => {
    S.imgData = null; S.srcCanvas = null; S.peaks = []; S.model = null; S.elements = [];
    S.wavelengths = []; S.zoom = 1; S.panX = 0; S.panY = 0;
    els.canvasEmpty.hidden = false;
    els.dropzone.classList.remove('has-image');
    els.dzTitle.textContent = '拖入光谱照片';
    els.dzSub.textContent = 'JPG / PNG / HEIC 转出的图 · 全程本地处理';
    els.stSize.textContent = '—';
    els.stPeaks.textContent = '0 条谱线';
    els.stTime.textContent = '—';
    $('#file-meta').textContent = '未载入';
    renderAll();
    toast('已重置');
  });

  els.btnHelp.addEventListener('click', () => els.help.showModal());
  els.helpClose.addEventListener('click', () => els.help.close());
  $('#btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
}

function init() {
  els = {
    stage: $('#stage'),
    profile: $('#profile'),
    profileWrap: $('#profile-wrap'),
    canvasWrap: $('#canvas-wrap'),
    canvasEmpty: $('#canvas-empty'),
    dropzone: $('#dropzone'),
    dzTitle: $('#dz-title'),
    dzSub: $('#dz-sub'),
    file: $('#file'),
    fileCamera: $('#file-camera'),
    btnFile: $('#btn-file'),
    btnCamera: $('#btn-camera'),
    btnDemo: $('#btn-demo'),
    rowRange: $('#row-range'),
    rowLabel: $('#row-label'),
    bandRange: $('#band-range'),
    bandLabel: $('#band-label'),
    zoomLabel: $('#zoom-label'),
    tip: $('#tip'),
    badgePeaks: $('#badge-peaks'),
    peaksEmpty: $('#peaks-empty'),
    peaksTableWrap: $('#peaks-table-wrap'),
    calibBody: $('#calib-body'),
    calibEmpty: $('#calib-empty'),
    cA: $('#c-a'), cB: $('#c-b'), cR2: $('#c-r2'), cRms: $('#c-rms'), cNote: $('#c-note'),
    fitChart: $('#fit-chart'),
    elementsBody: $('#elements-body'),
    elementsEmpty: $('#elements-empty'),
    lamp: $('#lamp'),
    lampNote: $('#lamp-note'),
    btnCalib: $('#btn-calib'),
    btnClearCalib: $('#btn-clear-calib'),
    btnManual: $('#btn-manual'),
    quad: $('#quad'),
    btnGrating: $('#btn-grating'),
    gratingOut: $('#grating-out'),
    reportPreview: $('#report-preview'),
    stSize: $('#st-size'),
    stPeaks: $('#st-peaks'),
    stTime: $('#st-time'),
    toast: $('#toast'),
    help: $('#help'),
    helpClose: $('#help-close'),
    btnHelp: $('#btn-help'),
    btnInstall: $('#btn-install'),
  };

  $('#st-ver').textContent = `v${C.VERSION}`;
  $('#ver').textContent = `v${C.VERSION}`;

  initTheme();
  bindFileInputs();
  bindRowControls();
  bindParams();
  bindStage();
  bindCalibration();
  bindGrating();
  bindExport();
  bindReport();
  bindTabs();
  bindMisc();
  bindPWA();

  // 初始剖面控件
  els.bandRange.value = String(S.band);
  els.bandLabel.textContent = `${S.band} px`;

  // ?demo=1 直接展示
  if (new URLSearchParams(location.search).get('demo') === '1') {
    setTimeout(loadDemo, 100);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
