// =============================================================
// pwa.js — v86: Webアプリ（ホーム画面に追加・オフライン起動）の登録
// 各ページの <head> で読み込む。サービスワーカー（sw.js）を登録するだけ。
// Androidアプリ（Capacitor）の中では、アプリにファイルが入っているので登録しない。
// =============================================================
(function () {
  if (!('serviceWorker' in navigator)) return;
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('サービスワーカーを登録できませんでした。', e));
  });
})();
