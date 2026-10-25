// =============================================================
// sw.js — v86: Webアプリ（PWA）用のサービスワーカー
//
// - 起動に必要なファイル（PRECACHE）は最初に保存しておき、オフラインでも起動できる。
// - それ以外（天体のテクスチャなど）は、一度読み込んだものを保存する。
// - 同じサイトのファイルは「ネットを優先、つながらなければ保存したもの」（更新がすぐ届く）。
// - 外部（Googleログイン・Firebase など）には手を出さない。
// CACHE_NAME を変えると古い保存を捨てる（大きく作り直したとき用）。
// v88: ネットから読むときも、ブラウザに残っている古いファイル（GitHub Pages は10分間の保存を許す）を
// 使わず、必ずサーバーに新しいかどうかを確かめる。更新の直後に古いファイルと新しいファイルが混ざると、
// 毎フレームの処理の途中でエラーになり、艦が動かなくなることがあったため。
// =============================================================
const CACHE_NAME = 'space-sim-v2';
const PRECACHE = [
  "./",
  "01-state-and-config.js",
  "02-input.js",
  "03-thruster-solver.js",
  "04-flight-physics.js",
  "05-ship-controller.js",
  "06-hud.js",
  "07-engine-fx.js",
  "08-camera.js",
  "08-main.js",
  "09-ship-builder.js",
  "10-docking-platform.js",
  "11-approach-visualizer.js",
  "12-port-builder.js",
  "13-astro-core.js",
  "14-solar-system.js",
  "28-deep-space.js",
  "15-universe-render.js",
  "16-navigation.js",
  "17-space-hud.js",
  "18-galaxy.js",
  "19-star-map.js",
  "20-small-bodies.js",
  "21-ship-design.js",
  "22-ship-designer.js",
  "23-collision.js",
  "24-sync.js",
  "25-google-sync.js",
  "26-post-fx.js",
  "27-engine-plumes.js",
  "data/small-bodies.js",
  "data/star-catalog.js",
  "firebase-config.js",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "index.html",
  "lib/three/CopyShader.js",
  "lib/three/EffectComposer.js",
  "lib/three/GLTFLoader.js",
  "lib/three/LuminosityHighPassShader.js",
  "lib/three/MTLLoader.js",
  "lib/three/OBJLoader.js",
  "lib/three/UnrealBloomPass.js",
  "lib/three/three.min.js",
  "manifest.webmanifest",
  "port-builder.html",
  "pwa.js",
  "settings.html",
  "ship-builder.html"
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // コード・ページは毎回サーバーに確かめる（変わっていなければ短い返事だけで済む）。テクスチャなどはそのまま
  const isCode = req.mode === 'navigate' || /\.(js|html|json|webmanifest|css)$/.test(url.pathname) || url.pathname.endsWith('/');
  event.respondWith(
    fetch(req, isCode ? { cache: 'no-cache' } : undefined)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
        .then((hit) => hit || new Response('オフラインのため読み込めません', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
  );
});
