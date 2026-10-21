#!/usr/bin/env node
/**
 * 资源完整性检查：CI 里跑，防止"改完忘了放文件"。
 * 检查：HTML 引用的本地资源、manifest 图标、SW 预缓存清单、core.js 关键导出。
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

let errors = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); errors++; };

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function localRefs(html) {
  const refs = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1].trim();
    if (!ref || ref.startsWith('http') || ref.startsWith('//') || ref.startsWith('data:') || ref.startsWith('mailto:')) continue;
    refs.add(ref);
  }
  return [...refs];
}

console.log('检查 HTML 引用的本地资源…');
for (const page of ['index.html', 'lab.html']) {
  const html = await readFile(join(WEB, page), 'utf8');
  for (const ref of localRefs(html)) {
    const target = join(WEB, ref);
    (await exists(target)) ? ok(`${page} → ${ref}`) : bad(`${page} 引用了不存在的 ${ref}`);
  }
}

console.log('检查 manifest 图标…');
const manifest = JSON.parse(await readFile(join(WEB, 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons || []) {
  const p = join(WEB, icon.src);
  if (!(await exists(p))) { bad(`manifest 图标缺失 ${icon.src}`); continue; }
  const buf = await readFile(p);
  // PNG 头 + 尺寸（IHDR 宽高）
  if (buf.length < 24 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') { bad(`${icon.src} 不是 PNG`); continue; }
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const want = Number(icon.sizes.split('x')[0]);
  (w === want && h === want) ? ok(`${icon.src} ${w}×${h}`) : bad(`${icon.src} 尺寸 ${w}×${h}，应为 ${want}`);
}

console.log('检查 Service Worker 预缓存清单…');
const sw = await readFile(join(WEB, 'sw.js'), 'utf8');
const assetsBlock = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
if (!assetsBlock) {
  bad('sw.js 里找不到 ASSETS 数组');
} else {
  const items = [...assetsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const item of items) {
    if (item === './') continue;
    (await exists(join(WEB, item))) ? ok(`sw → ${item}`) : bad(`sw 预缓存了不存在的 ${item}`);
  }
}

console.log('检查 core.js 导出…');
const core = await readFile(join(WEB, 'js', 'core.js'), 'utf8');
for (const name of ['findPeaks', 'matchLines', 'calibrateWithLamp', 'identifyElements',
  'wavelengthToRgb', 'gratingConstant', 'gratingUncertainty', 'syntheticProfile', 'VERSION']) {
  new RegExp(`export (function|const) ${name}\\b`).test(core) ? ok(`export ${name}`) : bad(`core.js 缺少导出 ${name}`);
}

console.log('检查禁止项…');
const app = await readFile(join(WEB, 'js', 'app.js'), 'utf8');
if (/XMLHttpRequest|fetch\(['"]https?:/.test(app)) bad('app.js 里出现了网络请求（要求纯本地）');
else ok('app.js 无网络请求');

if (errors) {
  console.error(`\n${errors} 项检查失败`);
  process.exit(1);
}
console.log('\n全部通过');
