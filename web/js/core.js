/**
 * SpectraLab Core v2.0
 * ------------------------------------------------------------------
 * 纯算法层：不碰 DOM，浏览器与 Node 共用。
 * 单元测试见 tests/core.test.mjs，浏览器自检见 web/lab.html。
 *
 * 设计原则
 *  1. 每个函数只做一件事，输入输出都是普通数组/对象，方便断言。
 *  2. 所有"看起来像物理"的常数都注明来源与单位。
 *  3. 失败要可解释：返回 null / 抛带信息的错误，不静默给假结果。
 */

export const VERSION = '2.0.0';

/* ============================ 基础工具 ============================ */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

/** 人眼亮度（Rec.709 权重），输入 0-255 */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 在升序数组里找最接近 value 的下标 */
export function nearestIndex(sorted, value) {
  let lo = 0, hi = sorted.length - 1;
  if (value <= sorted[0]) return 0;
  if (value >= sorted[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid; else hi = mid;
  }
  return Math.abs(sorted[lo] - value) <= Math.abs(sorted[hi] - value) ? lo : hi;
}

/* ============================ 元素谱线库 ============================ */

/**
 * 常见光源/元素的特征谱线（nm），已按波长升序排列。
 * 数据为教学常用值，末位有效数字可能与高精度文献有 ±0.05 nm 出入。
 * 来源：NIST Atomic Spectra Database（教学简化），钠双线取 589.00/589.59。
 */
export const ELEMENTS = {
  Hg: { name: '汞 Hg', color: '#7c8cff', lines: [365.02, 404.66, 407.78, 435.84, 491.60, 546.07, 576.96, 579.07] },
  Na: { name: '钠 Na', color: '#ffb020', lines: [498.28, 515.34, 568.82, 588.995, 589.592, 615.42] },
  H:  { name: '氢 H',  color: '#ff5f7e', lines: [397.01, 410.17, 434.05, 486.13, 656.28] },
  He: { name: '氦 He', color: '#5fd0ff', lines: [388.86, 402.62, 447.15, 471.31, 492.19, 501.57, 587.56, 667.82, 706.52] },
  Ne: { name: '氖 Ne', color: '#ff7a45', lines: [540.06, 585.25, 588.19, 614.31, 640.22, 650.65, 659.90, 703.24] },
  Ar: { name: '氩 Ar', color: '#8b5cf6', lines: [696.54, 706.72, 738.40, 750.39, 763.51, 772.42, 811.53] },
  Kr: { name: '氪 Kr', color: '#22d3ee', lines: [436.26, 461.92, 557.03, 587.09, 760.15, 769.45, 810.44] },
  Ca: { name: '钙 Ca', color: '#84cc16', lines: [393.37, 396.85, 422.67, 430.25, 442.54, 445.48] },
  Cd: { name: '镉 Cd', color: '#eab308', lines: [467.82, 480.00, 508.58, 643.85] },
  Zn: { name: '锌 Zn', color: '#38bdf8', lines: [468.01, 472.22, 481.05, 636.23] },
  Cu: { name: '铜 Cu', color: '#fb923c', lines: [510.55, 515.32, 521.82, 578.21] },
  Li: { name: '锂 Li', color: '#f472b6', lines: [460.29, 610.36, 670.78] },
};

/** 光谱灯推荐：实验课上最常用的三种 */
export const LAMPS = [
  { key: 'Hg', label: '汞灯（最常用）', note: '5 条强线，适合做单色仪校准' },
  { key: 'Na', label: '钠灯', note: '双线 589.0/589.6，用来考分辨率' },
  { key: 'H',  label: '氢灯（巴耳末系）', note: '656/486/434/410/397，验证里德伯公式' },
  { key: 'He', label: '氦灯', note: '线条多，适合多点拟合' },
];

/* ============================ 图像 → 一维剖面 ============================ */

/**
 * 从 ImageData 中取一行（可带高度平均）的亮度剖面。
 * @param {{data: Uint8ClampedArray, width:number, height:number}} img
 * @param {number} rowY 中心行（像素，0 基）
 * @param {number} band 平均行数（≥1，奇数更对称）
 * @returns {Float32Array} 长度 = width
 */
export function extractProfile(img, rowY, band = 5) {
  const { data, width, height } = img;
  const half = Math.floor(Math.max(1, band) / 2);
  const y0 = clamp(Math.round(rowY) - half, 0, height - 1);
  const y1 = clamp(Math.round(rowY) + half, 0, height - 1);
  const rows = y1 - y0 + 1;
  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let s = 0;
    for (let y = y0; y <= y1; y++) {
      const i = (y * width + x) * 4;
      s += luminance(data[i], data[i + 1], data[i + 2]);
    }
    out[x] = s / rows;
  }
  return out;
}

/** 盒式滑动平均，边界按端点复制 */
export function smoothProfile(profile, win = 5) {
  const w = Math.max(1, Math.round(win));
  if (w <= 1) return Float32Array.from(profile);
  const half = Math.floor(w / 2);
  const n = profile.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + profile[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = clamp(i - half, 0, n - 1);
    const hi = clamp(i + half, 0, n - 1);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/* ============================ 找峰 ============================ */

function prominenceAt(prof, i) {
  const h = prof[i];
  let left = i;
  while (left > 0 && prof[left - 1] <= h) left--;
  let minLeft = Infinity;
  for (let k = left; k <= i; k++) if (prof[k] < minLeft) minLeft = prof[k];

  let right = i;
  while (right < prof.length - 1 && prof[right + 1] <= h) right++;
  let minRight = Infinity;
  for (let k = i; k <= right; k++) if (prof[k] < minRight) minRight = prof[k];

  return h - Math.max(minLeft, minRight);
}

/**
 * 找谱线峰。
 * @param {ArrayLike<number>} profile 已平滑的亮度剖面
 * @param {object} opts
 *   minProminence  相对最大值的显著度阈值（0-1），默认 0.06
 *   minDistance    两峰最小间距（像素），默认 4
 *   maxPeaks       最多返回多少个，按显著度取前 N
 *   minHeight      绝对高度下限（0-255），默认 0
 * @returns {Array<{x:number, height:number, prominence:number, index:number}>}
 */
export function findPeaks(profile, opts = {}) {
  const {
    minProminence = 0.06,
    minDistance = 4,
    maxPeaks = 80,
    minHeight = 0,
  } = opts;

  const n = profile.length;
  if (n < 3) return [];

  let max = 0;
  for (let i = 0; i < n; i++) if (profile[i] > max) max = profile[i];
  if (max <= 0) return [];
  const promThreshold = Math.max(0, minProminence) * max;

  // 1) 局部极大
  const cand = [];
  for (let i = 1; i < n - 1; i++) {
    const v = profile[i];
    if (v <= minHeight) continue;
    if (!(v >= profile[i - 1] && v > profile[i + 1])) continue;
    // 平台峰取中间：向右跳过等高点
    let j = i;
    while (j < n - 1 && profile[j + 1] === v) j++;
    cand.push(Math.round((i + j) / 2));
    i = j;
  }

  // 2) 显著度过滤 + 3) 抛物线亚像素
  const peaks = [];
  for (const i of cand) {
    const prom = prominenceAt(profile, i);
    if (prom < promThreshold) continue;
    let dx = 0;
    if (i > 0 && i < n - 1) {
      const y0 = profile[i - 1], y1 = profile[i], y2 = profile[i + 1];
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-9) dx = clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5);
    }
    peaks.push({ index: i, x: i + dx, height: profile[i], prominence: prom });
  }

  // 4) 按显著度降序做最小间距贪心，再按 x 升序返回
  peaks.sort((a, b) => b.prominence - a.prominence);
  const kept = [];
  for (const p of peaks) {
    if (kept.length >= maxPeaks) break;
    if (kept.some((q) => Math.abs(q.x - p.x) < minDistance)) continue;
    kept.push(p);
  }
  kept.sort((a, b) => a.x - b.x);
  return kept;
}

/* ============================ 线性 / 二次拟合 ============================ */

/**
 * 最小二乘一次拟合 y = a·x + b
 * @returns {{a:number,b:number,r2:number,rms:number,sd:number,predict:Function,residuals:number[]}}
 */
export function linearFit(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) throw new Error('线性拟合至少需要 2 个点');
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) throw new Error('所有点在同一个 x 上，无法拟合');
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  const residuals = xs.map((x, i) => ys[i] - (a * x + b));
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const yMean = sy / n;
  const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
  const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 1;
  return {
    a, b, r2,
    rms: Math.sqrt(ssRes / n),
    sd: Math.sqrt(ssRes / Math.max(1, n - 2)),
    residuals,
    predict: (x) => a * x + b,
  };
}

/** 最小二乘二次拟合 y = a·x² + b·x + c（色散略非线性时用） */
export function quadraticFit(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) throw new Error('二次拟合至少需要 3 个点');
  // 正规方程 3x3
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  // 解 [s4 s3 s2; s3 s2 s1; s2 s1 n] [a b c]^T = [t2 t1 t0]^T
  const M = [[s4, s3, s2], [s3, s2, s1], [s2, s1, n]];
  const v = [t2, t1, t0];
  const [a, b, c] = solve3(M, v);
  const residuals = xs.map((x, i) => ys[i] - (a * x * x + b * x + c));
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const yMean = t0 / n;
  const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
  return {
    a, b, c,
    r2: ssTot > 1e-12 ? 1 - ssRes / ssTot : 1,
    rms: Math.sqrt(ssRes / n),
    residuals,
    predict: (x) => a * x * x + b * x + c,
  };
}

function solve3(M, v) {
  const [r0, r1, r2] = M.map((row) => row.slice());
  const [b0, b1, b2] = v.slice();
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det([r0, r1, r2]);
  if (Math.abs(D) < 1e-12) throw new Error('二次拟合矩阵奇异');
  const rep = (col, val) => [r0, r1, r2].map((row, i) => row.map((x, j) => (j === col ? val[i] : x)));
  return [det(rep(0, [b0, b1, b2])), det(rep(1, [b0, b1, b2])), det(rep(2, [b0, b1, b2]))].map((x) => x / D);
}

/** 用模型把像素位置换算成波长 */
export function resolveWavelengths(model, xs) {
  if (!model || typeof model.predict !== 'function') return xs.map(() => null);
  return xs.map((x) => model.predict(x));
}

/* ============================ 谱线与元素的匹配 ============================ */

/**
 * RANSAC 式匹配：任取两个峰 + 两条谱线定出一个线性色散，再看能对上多少条。
 * @param {number[]} xs 峰位置（像素）
 * @param {number[]} lines 参考谱线（nm，升序）
 * @param {object} opts tol: 允许残差 nm；minInliers: 至少几条才算命中；maxPeaks: 只用最亮的前 N 个峰
 * @returns {null | {a,b,r2,rms,inliers,pairs,predict,residuals}}
 */
export function matchLines(xs, lines, opts = {}) {
  const { tol = 2.5, minInliers = 3, maxPeaks = 64, minDispersion = 0.005, maxDispersion = 5 } = opts;
  // 按像素位置升序（谱线在图像上从左到右对应波长从短到长）
  const X = xs.slice(0, maxPeaks).sort((a, b) => a - b);
  const L = Array.from(new Set(lines)).sort((a, b) => a - b);
  if (X.length < 2 || L.length < 2) return null;

  const n = X.length;
  let best = null;

  // 单调匹配：每个峰依次向前找"下一条"参考线，一条线只认一个峰。
  // 没有这条约束，两三条线就能把一堆噪声峰全部"吸收"进容差里，
  // 于是任何图都能拟合出一个假色散（这是初版最严重的坑）。
  const assign = (a, b) => {
    let lastIdx = -1;
    let inl = 0, s2 = 0;
    const pairs = [];
    for (let k = 0; k < n; k++) {
      const pred = a * X[k] + b;
      const idx = nearestIndex(L, pred);
      if (idx <= lastIdx) continue;
      const res = pred - L[idx];
      if (Math.abs(res) > tol) continue;
      lastIdx = idx;
      inl++;
      s2 += res * res;
      pairs.push([X[k], L[idx]]);
    }
    return { inl, s2, pairs };
  };

  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = X[j] - X[i];
      if (Math.abs(dx) < 1e-9) continue;
      for (let p = 0; p < L.length - 1; p++) {
        for (let q = p + 1; q < L.length; q++) {
          const a = (L[q] - L[p]) / dx;
          // 物理先验：常见光谱仪 0.02–1 nm/px，放宽到 0.005–5 已足够；
          // 不设上下界时，挤在一起的峰可以被"匹配"到间距相近的两条线上，
          // 得到一个荒谬的大色散。
          if (!(a >= minDispersion && a <= maxDispersion)) continue;
          const b = L[p] - a * X[i];
          const pmin = a * X[0] + b;
          const pmax = a * X[n - 1] + b;
          if (pmax < L[0] - tol * 2 || pmin > L[L.length - 1] + tol * 2) continue;

          const { inl, s2, pairs } = assign(a, b);
          if (inl < minInliers) continue;
          const rms = Math.sqrt(s2 / inl);
          const score = inl * 1000 - rms;
          if (!best || score > best.score) best = { a, b, inliers: inl, rms, pairs, score };
        }
      }
    }
  }
  if (!best) return null;

  // 用内点做一次最小二乘精修
  const fit = linearFit(best.pairs.map((p) => p[0]), best.pairs.map((p) => p[1]));
  const residuals = fit.residuals.map((r) => r);
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  // 精修后重新统计命中数（阈值不变）
  const inliers = residuals.filter((r) => Math.abs(r) <= tol).length;
  return {
    a: fit.a, b: fit.b, r2: fit.r2, rms, inliers,
    pairs: best.pairs,
    residuals,
    predict: fit.predict,
  };
}

/**
 * 元素识别：对库中每个元素做一次匹配，按"命中条数 → 残差"排序。
 * @returns {Array<{key,name,color,inliers,rms,r2,a,b,lines,matched}>}
 */
export function identifyElements(xs, opts = {}) {
  const { tol = 1.8, minInliers = 3 } = opts;
  const out = [];
  for (const [key, el] of Object.entries(ELEMENTS)) {
    if (el.lines.length < minInliers) continue;
    const m = matchLines(xs, el.lines, { tol, minInliers, maxPeaks: 24 });
    if (!m) continue;
    out.push({
      key, name: el.name, color: el.color,
      inliers: m.inliers, rms: m.rms, r2: m.r2, a: m.a, b: m.b,
      matched: m.inliers,
      coverage: m.inliers / Math.min(xs.length, el.lines.length),
      predict: m.predict,
    });
  }
  out.sort((p, q) => (q.inliers - p.inliers) || (p.rms - q.rms));
  return out;
}

/** 用指定灯源自动标定 */
export function calibrateWithLamp(xs, lampKey, opts = {}) {
  const el = ELEMENTS[lampKey];
  if (!el) throw new Error(`未知灯源: ${lampKey}`);
  return matchLines(xs, el.lines, { tol: opts.tol ?? 3, minInliers: opts.minInliers ?? 3, maxPeaks: 48 });
}

/* ============================ 颜色 ============================ */

/**
 * 波长 → sRGB（Bruton 近似，gamma 0.8）。
 * 380–780 nm 之外返回暗灰，方便在界面上显示"越界"。
 */
export function wavelengthToRgb(wl) {
  let r = 0, g = 0, b = 0;
  if (wl >= 380 && wl < 440) { r = -(wl - 440) / 60; b = 1; }
  else if (wl >= 440 && wl < 490) { g = (wl - 440) / 50; b = 1; }
  else if (wl >= 490 && wl < 510) { g = 1; b = -(wl - 510) / 20; }
  else if (wl >= 510 && wl < 580) { r = (wl - 510) / 70; g = 1; }
  else if (wl >= 580 && wl < 645) { r = 1; g = -(wl - 645) / 65; }
  else if (wl >= 645 && wl <= 780) { r = 1; }
  else return [90, 90, 100];

  let f = 1;
  if (wl >= 380 && wl < 420) f = 0.3 + (0.7 * (wl - 380)) / 40;
  else if (wl > 700 && wl <= 780) f = 0.3 + (0.7 * (780 - wl)) / 80;

  const gamma = 0.8;
  const adj = (c) => Math.round(255 * Math.pow(Math.max(0, c) * f, gamma));
  return [adj(r), adj(g), adj(b)];
}

export function rgbCss([r, g, b], alpha = 1) {
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/* ============================ 光栅 / 分光计 ============================ */

/**
 * 光栅方程 d·sinθ = k·λ（垂直入射）
 * @param {number} order k 级次
 * @param {number} thetaDeg 衍射角（度）
 * @param {number} lambdaNm 波长（nm）
 * @returns {number} 光栅常数 d（nm）
 */
export function gratingConstant(order, thetaDeg, lambdaNm) {
  const s = Math.sin((thetaDeg * Math.PI) / 180);
  if (!(s > 0)) throw new Error('衍射角必须大于 0°');
  if (!(order > 0)) throw new Error('级次 k 必须为正');
  return (order * lambdaNm) / s;
}

/** 由左右游标读数求衍射角 |L-R|/2（度），自动处理跨 360° */
export function deflectionAngle(leftDeg, rightDeg) {
  let diff = Math.abs(leftDeg - rightDeg) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff / 2;
}

/** d 的不确定度：d = kλ/sinθ → σd = kλ·cosθ/sin²θ · σθ */
export function gratingUncertainty(order, thetaDeg, lambdaNm, sigmaThetaDeg) {
  const th = (thetaDeg * Math.PI) / 180;
  const s = Math.sin(th), c = Math.cos(th);
  if (!(s > 0)) return NaN;
  const d = (order * lambdaNm) / s;
  const dd = Math.abs((order * lambdaNm * c) / (s * s)) * ((sigmaThetaDeg * Math.PI) / 180);
  return { d, sigma: dd, rel: dd / d };
}

/** 给定 d 与级次，算某波长的衍射角（度） */
export function angleForWavelength(dNm, order, lambdaNm) {
  const s = (order * lambdaNm) / dNm;
  if (s > 1) throw new Error('该级次下 sinθ > 1，这条谱线不会出现');
  return (Math.asin(s) * 180) / Math.PI;
}

/* ============================ 合成谱图（示例与自检用） ============================ */

/** 可复现的伪随机数（LCG） */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 生成一维合成光谱剖面：λ = b + a·x（a 为 nm/px）。
 * 每条谱线是一个高斯，带随机强度与加性噪声。
 */
export function syntheticProfile({
  width = 1200,
  a = 0.12,
  b = 380,
  lines = ELEMENTS.Hg.lines,
  sigmaPx = 2.5,
  baseline = 6,
  noise = 1.5,
  seed = 7,
} = {}) {
  const prof = new Float32Array(width);
  const rand = rng(seed);
  for (let i = 0; i < width; i++) prof[i] = baseline + (rand() - 0.5) * noise;
  for (const lam of lines) {
    const x0 = (lam - b) / a;
    if (x0 < -5 || x0 > width + 5) continue;
    const amp = 90 + rand() * 120;
    for (let x = Math.max(0, Math.floor(x0 - 6 * sigmaPx)); x <= Math.min(width - 1, Math.ceil(x0 + 6 * sigmaPx)); x++) {
      prof[x] += amp * Math.exp(-((x - x0) ** 2) / (2 * sigmaPx * sigmaPx));
    }
  }
  return prof;
}

/** 由剖面反推"真实峰位"（用于测试期望值，不参与产品逻辑） */
export function idealPeakPositions({ a = 0.12, b = 380, lines = [] } = {}) {
  return lines.map((lam) => ({ lam, x: (lam - b) / a }));
}

/* ============================ 报告用的小工具 ============================ */

export function fmt(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}

export function fmtSci(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toExponential(digits);
}
