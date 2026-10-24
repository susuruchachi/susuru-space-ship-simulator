// =============================================================
// copy-web.mjs — v86: Android アプリ（Capacitor）に入れるゲームのファイルを app/www へ写す
//
// リポジトリの直下にある Web 版（GitHub Pages で公開しているものと同じ）を、そのまま
// アプリに入れる。開発用・作業用のファイル（tools/、app/ 自身、__ で始まる確認用ファイル、
// Markdown など）は入れない。
// =============================================================
import { cpSync, rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'www');
const SKIP = new Set(['app', 'tools', '.git', '.github', 'node_modules', 'sw.js']);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let n = 0;
for (const name of readdirSync(root)) {
  if (SKIP.has(name) || name.startsWith('.') || name.startsWith('__') || name.endsWith('.md')) continue;
  const src = join(root, name);
  cpSync(src, join(out, name), { recursive: true });
  n += statSync(src).isDirectory() ? 0 : 1;
}
console.log(`app/www にゲームのファイルを写しました（直下のファイル ${n} 個とフォルダ）`);

// アプリのバージョン: GAME_VERSION（例 0.086.000.001）→ versionName はそのまま、
// versionCode は数字をつなげた整数（0.086.000.001 → 86000001）
const m = readFileSync(join(root, '01-state-and-config.js'), 'utf8').match(/GAME_VERSION = '(\d+)\.(\d+)\.(\d+)\.(\d+)'/);
if (m) {
  const [, a, b, c, d] = m.map(Number);
  const code = ((a * 1000 + b) * 1000 + c) * 1000 + d;
  writeFileSync(join(here, 'version.properties'), `versionName=${m.slice(1).join('.')}\nversionCode=${code}\n`);
  console.log(`バージョン ${m.slice(1).join('.')}（versionCode ${code}）`);
}
