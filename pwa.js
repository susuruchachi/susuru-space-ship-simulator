// =============================================================
// pwa.js — v86: Webアプリ（ホーム画面に追加・オフライン起動）の登録
// 各ページの <head> で読み込む。サービスワーカー（sw.js）を登録するだけ。
// Androidアプリ（Trusted Web Activity）は Chrome で Web 版を開くので、同じく登録する（オフライン起動に使う）。
// =============================================================
// v89: iPad では、画面の左上に窓のボタン（全画面・最小化・閉じる）が重なって出ることがある
// （iPadOS の窓の機能。画面の端の安全な余白 safe-area には含まれない）。iPad のときだけ、
// 左上の部品をそのボタンの幅だけ右へずらす（CSS の --wcl）
(function () {
  try {
    const ua = navigator.userAgent || '';
    const isIPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIPad) {
      document.documentElement.classList.add('ipad');
      document.documentElement.style.setProperty('--wcl', '84px'); // 左上のボタンの幅
      document.documentElement.style.setProperty('--wct', '38px'); // 左上のボタンの高さ（縦に並ぶ画面用）
    }
  } catch (e) { /* ignore */ }
})();

(function () {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('サービスワーカーを登録できませんでした。', e));
  });
})();
