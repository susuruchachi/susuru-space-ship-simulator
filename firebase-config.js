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

// v86: このゲーム専用の Firebase プロジェクト（space-ships-a9ee8）。Android アプリも含め、どの端末でも貼り付け不要に
window.SHIP_SYNC_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBuPF-_sP7XnGkw9742r-4HuKE7G-gt95g',
  authDomain: 'space-ships-a9ee8.firebaseapp.com',
  projectId: 'space-ships-a9ee8',
  storageBucket: 'space-ships-a9ee8.firebasestorage.app',
  messagingSenderId: '707403781164',
  appId: '1:707403781164:web:87f5d472dfe26ebefd2d89',
};
