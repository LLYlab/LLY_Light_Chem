import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, mean, std, luminance, nearestIndex,
  linearFit, quadraticFit, findPeaks, smoothProfile, syntheticProfile,
  matchLines, identifyElements, calibrateWithLamp, resolveWavelengths,
  wavelengthToRgb, gratingConstant, gratingUncertainty, deflectionAngle,
  angleForWavelength, ELEMENTS, idealPeakPositions, rng,
} from '../web/js/core.js';

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}±${tol}, got ${a}`);

test('基础工具', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  near(mean([1, 2, 3]), 2, 1e-12);
  near(std([2, 2, 2]), 0, 1e-12);
  near(luminance(255, 255, 255), 255, 1e-9);
  assert.equal(nearestIndex([1, 3, 5, 7], 4), 1);
  assert.equal(nearestIndex([1, 3, 5, 7], 6), 2);
});

test('线性拟合：精确直线', () => {
  const xs = [0, 1, 2, 3, 4];
  const ys = xs.map((x) => 2 * x + 1);
  const m = linearFit(xs, ys);
  near(m.a, 2, 1e-9);
  near(m.b, 1, 1e-9);
  near(m.r2, 1, 1e-12);
  near(m.rms, 0, 1e-9);
});

test('线性拟合：带噪声也贴近', () => {
  const xs = Array.from({ length: 40 }, (_, i) => i * 10);
  const rand = rng(3);
  const ys = xs.map((x) => 0.5 * x + 100 + (rand() - 0.5) * 0.4);
  const m = linearFit(xs, ys);
  near(m.a, 0.5, 0.02);
  near(m.b, 100, 5);
  assert.ok(m.r2 > 0.999);
});

test('二次拟合：精确抛物线', () => {
  const xs = [-2, -1, 0, 1, 2, 3];
  const ys = xs.map((x) => 0.25 * x * x - 3 * x + 7);
  const q = quadraticFit(xs, ys);
  near(q.a, 0.25, 1e-9);
  near(q.b, -3, 1e-9);
  near(q.c, 7, 1e-9);
});

test('平滑不改变常数剖面', () => {
  const p = new Float32Array(100).fill(42);
  const s = smoothProfile(p, 7);
  for (const v of s) near(v, 42, 1e-6);
});

test('找峰：合成剖面的峰位正确', () => {
  const lines = [404.66, 435.84, 546.07, 576.96, 579.07];
  const a = 0.1, b = 380;
  const prof = syntheticProfile({ width: 2600, a, b, lines, sigmaPx: 3, noise: 1 });
  const smooth = smoothProfile(prof, 5);
  const peaks = findPeaks(smooth, { minProminence: 0.08, minDistance: 6 });
  assert.ok(peaks.length >= 5, `期望 ≥5 个峰，实际 ${peaks.length}`);
  const expected = idealPeakPositions({ a, b, lines });
  for (const e of expected) {
    const hit = peaks.reduce((best, p) => (Math.abs(p.x - e.x) < Math.abs(best.x - e.x) ? p : best), peaks[0]);
    near(hit.x, e.x, 0.6, `λ=${e.lam}`);
  }
});

test('找峰：间距太近的峰被合并策略控制', () => {
  const prof = new Float32Array(200).fill(1);
  prof[50] = 100; prof[52] = 90;
  const far = findPeaks(prof, { minProminence: 0.01, minDistance: 10 });
  const nearPeaks = findPeaks(prof, { minProminence: 0.01, minDistance: 1 });
  assert.equal(far.length, 1);
  assert.equal(nearPeaks.length, 2);
});

test('matchLines：能还原色散 a/b', () => {
  const a = 0.11, b = 377;
  const lines = ELEMENTS.Hg.lines;
  const xs = idealPeakPositions({ a, b, lines }).map((p) => p.x);
  const m = matchLines(xs, lines, { tol: 0.5, minInliers: 4 });
  assert.ok(m, '应匹配成功');
  near(m.a, a, 1e-6, '色散');
  near(m.b, b, 1e-3, '截距');
});

test('identifyElements：汞灯的候选第一是 Hg', () => {
  const a = 0.12, b = 380;
  const prof = syntheticProfile({ width: 2400, a, b, lines: ELEMENTS.Hg.lines, sigmaPx: 2.5, noise: 1 });
  const peaks = findPeaks(smoothProfile(prof, 5), { minProminence: 0.08, minDistance: 6 });
  const xs = peaks.map((p) => p.x);
  const res = identifyElements(xs, { tol: 2, minInliers: 3 });
  assert.ok(res.length > 0, '应有候选');
  assert.equal(res[0].key, 'Hg', `第一候选应为 Hg，实际 ${res[0].key}`);
  assert.ok(res[0].inliers >= 4);
});

test('calibrateWithLamp + 波长还原误差 < 0.3 nm', () => {
  const a = 0.09, b = 371.5;
  const prof = syntheticProfile({ width: 3600, a, b, lines: ELEMENTS.Hg.lines, sigmaPx: 3, noise: 1.2 });
  const peaks = findPeaks(smoothProfile(prof, 5), { minProminence: 0.07, minDistance: 6 });
  const m = calibrateWithLamp(peaks.map((p) => p.x), 'Hg', { tol: 3, minInliers: 4 });
  assert.ok(m, '标定应成功');
  const wl = resolveWavelengths(m, peaks.map((p) => p.x));
  // 每个还原波长都应落在某条汞线上
  for (const lam of wl) {
    const best = ELEMENTS.Hg.lines.reduce((x, y) => (Math.abs(y - lam) < Math.abs(x - lam) ? y : x), Infinity);
    assert.ok(Math.abs(best - lam) < 0.3, `λ=${lam} 偏离最近汞线 ${best}`);
  }
});

test('波长 → 颜色', () => {
  const [r1, g1, b1] = wavelengthToRgb(546.1);
  assert.ok(g1 > 200 && r1 < 200, '546 nm 应偏绿');
  const [r2, g2, b2] = wavelengthToRgb(650);
  assert.ok(r2 > 200 && g2 < 80, '650 nm 应偏红');
  const dark = wavelengthToRgb(300);
  assert.ok(dark.every((v) => v < 120), '300 nm 应返回暗色');
});

test('光栅方程与不确定度', () => {
  near(gratingConstant(1, 30, 600), 1200, 1e-9);
  near(gratingConstant(2, 90, 500), 1000, 1e-9);
  assert.throws(() => gratingConstant(1, 0, 600));
  const u = gratingUncertainty(1, 30, 600, 0.01);
  near(u.d, 1200, 1e-9);
  assert.ok(u.sigma > 0 && u.rel > 0);
  near(angleForWavelength(1200, 1, 600), 30, 1e-9);
  assert.throws(() => angleForWavelength(1000, 1, 2000));
});

test('左右游标 → 衍射角', () => {
  near(deflectionAngle(120, 60), 30, 1e-9);
  near(deflectionAngle(10, 350), 10, 1e-9); // 跨 0°
});

test('matchLines：拒绝退化拟合（峰几乎重合时不能伪造小色散）', () => {
  // 8 个峰只差 0.1 px：要"对上"不同谱线就得用 >20 nm/px 的荒谬色散，
  // 必须被物理先验挡掉；而 a≈0 的解又被"一条线只认一个峰"挡掉。
  const xs = [2000, 2000.1, 2000.2, 2000.3, 2000.4, 2000.5, 2000.6, 2000.7];
  const m = matchLines(xs, ELEMENTS.Hg.lines, { tol: 3, minInliers: 3 });
  assert.equal(m, null, '几乎重合的峰不应匹配出 3 条以上不同谱线');
});

test('matchLines：任何匹配的色散都必须落在物理范围内', () => {
  const xs = [2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007];
  const m = matchLines(xs, ELEMENTS.Hg.lines, { tol: 3, minInliers: 3 });
  if (m) {
    assert.ok(m.a >= 0.005 && m.a <= 5, `色散 a=${m.a} 越界`);
    assert.equal(new Set(m.pairs.map((p) => p[1])).size, m.pairs.length, '同一条参考线被用了两次');
  }
});

test('matchLines：乱序输入也能正确匹配', () => {
  const a = 0.1, b = 372;
  const xs = idealPeakPositions({ a, b, lines: ELEMENTS.Hg.lines }).map((p) => p.x);
  const shuffled = [...xs].sort(() => 0.5 - Math.random());
  const m = matchLines(shuffled, ELEMENTS.Hg.lines, { tol: 0.5, minInliers: 4 });
  assert.ok(m, '乱序输入应匹配成功');
  near(m.a, a, 1e-6);
});

test('色散方向：x 增大波长单调增', () => {
  const a = 0.1, b = 380;
  const xs = idealPeakPositions({ a, b, lines: ELEMENTS.Hg.lines }).map((p) => p.x);
  const m = matchLines(xs, ELEMENTS.Hg.lines, { tol: 0.5, minInliers: 4 });
  assert.ok(m.a > 0);
  near(m.predict(xs[0] + 100), m.predict(xs[0]) + 10, 1e-6);
});
