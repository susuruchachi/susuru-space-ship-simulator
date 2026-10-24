// =============================================================
// pwa.js — v86: Webアプリ（ホーム画面に追加・オフライン起動）の登録
// 各ページの <head> で読み込む。サービスワーカー（sw.js）を登録するだけ。
// Androidアプリ（Trusted Web Activity）は Chrome で Web 版を開くので、同じく登録する（オフライン起動に使う）。
// =============================================================
(function () {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('サービスワーカーを登録できませんでした。', e));
  });
})();
