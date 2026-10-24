// =============================================================
// firebase-config.js
// v82: Googleアカウントでの同期（25-google-sync.js）に使う Firebase の設定。
//
// Firebase コンソールで登録したウェブアプリの firebaseConfig をここに書くと、
// どの端末でも設定画面の「Googleでログイン」を押すだけで同期できるようになる
// （ここに書かない場合は、端末ごとに設定画面の「最初の準備」へ貼り付けても使える）。
// この値は秘密の情報ではない（データは Firestore のルールで、本人だけが
// 読み書きできるように守る）。
//
// 書き方の例:
// window.SHIP_SYNC_FIREBASE_CONFIG = {
//   apiKey: 'AIza…',
//   authDomain: 'プロジェクトID.firebaseapp.com',
//   projectId: 'プロジェクトID',
//   appId: '1:…:web:…',
// };
// =============================================================

window.SHIP_SYNC_FIREBASE_CONFIG = null;
