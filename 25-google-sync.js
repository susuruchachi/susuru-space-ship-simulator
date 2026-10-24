// =============================================================
// 25-google-sync.js
// v82: Googleアカウントで艦の設計を同期する（Firebase Authentication ＋ Cloud Firestore）
//
// 「gitじゃなくてGoogleアカウントで同期させられないかな」という要望で新設。
// このゲームはサーバーの無い静的なサイト（GitHub Pages）なので、サイトの持ち主が
// 無料の Firebase プロジェクトを1つ用意し、その設定（firebaseConfig）を
// firebase-config.js に書くか、設定画面に貼り付ける。あとは各端末で
// 「Googleでログイン」を押すだけで、同じGoogleアカウントの端末どうしで同期する。
// ログイン状態は端末に残る（Firebase Authentication）ので、次からは自動で同期する。
//
// データの置き場所（Cloud Firestore。本人しか読み書きできないルールにしてもらう）:
//   users/<ユーザーID>/ships/<設計ID>                   … 設計1隻（名前・更新日時・
//                                                         削除済みか・設計本体のJSON・船体モデルの版）
//   users/<ユーザーID>/ships/<設計ID>/chunks/<版>_<番号> … 船体モデルを約900KBずつに分けたもの
// 同期のしかたは GitHub（24-sync.js の GitHubSync）と同じ「更新日時の新しい方が勝つ」方式。
// 削除も伝える（21-ship-design.js の削除の記録）。
//
// Firestore の読み書きは REST API で行う（Firestore の SDK は大きいので、ログイン用の
// Firebase Authentication の SDK だけを読み込む）。
// =============================================================

const GOOGLE_SYNC_CONFIG_KEY = 'spaceSimGoogleSyncConfig';
const GOOGLE_SYNC_SDK_VERSION = '12.19.0';
const GOOGLE_SYNC_CHUNK_BYTES = 900 * 1024;  // 船体モデルを分ける大きさ（Firestore の1文書は1MiBまで）
const GOOGLE_SYNC_BATCH_CHUNKS = 6;          // 1回の送信で送る塊の数（1回の送信は10MiBまで）
const GOOGLE_SYNC_MAX_MODEL_BYTES = 200e6;   // これより大きい船体モデルは同期しない

const GoogleSync = {
  label: 'Google',
  // Firestore に設定してもらうルール（ログインした本人が、自分の users/<ユーザーID>/ の下だけ読み書きできる）
  RULES: [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /users/{uid}/{document=**} {',
    '      allow read, write: if request.auth != null && request.auth.uid == uid;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  _app: null,
  _auth: null,
  _user: null,
  _ready: false,
  _loading: null,
  _running: null,
  _listeners: [],

  // -----------------------------------------------------------
  // 設定（この端末に貼り付けた Firebase の設定・自動同期）
  // -----------------------------------------------------------
  config() {
    try {
      const c = JSON.parse(localStorage.getItem(GOOGLE_SYNC_CONFIG_KEY) || '{}') || {};
      return { firebase: c.firebase || null, auto: c.auto !== false, lastSyncAt: c.lastSyncAt || 0 };
    } catch (e) {
      return { firebase: null, auto: true, lastSyncAt: 0 };
    }
  },

  saveConfig(partial) {
    const c = { ...this.config(), ...partial };
    try { localStorage.setItem(GOOGLE_SYNC_CONFIG_KEY, JSON.stringify(c)); } catch (e) {}
    return c;
  },

  // サイトに書いてある設定（firebase-config.js）が優先。無ければこの端末に貼り付けた設定
  siteFirebaseConfig() {
    const c = typeof window !== 'undefined' ? window.SHIP_SYNC_FIREBASE_CONFIG : null;
    return c && c.apiKey && c.projectId ? c : null;
  },

  firebaseConfig() {
    const c = this.siteFirebaseConfig() || this.config().firebase;
    if (!c || !c.apiKey || !c.projectId) return null;
    return { ...c, authDomain: c.authDomain || `${c.projectId}.firebaseapp.com` };
  },

  isAvailable() { return !!this.firebaseConfig(); },
  isReady() { return this._ready; },
  isSignedIn() { return !!this._user; },
  user() { return this._user; },
  isAutoSync() { return this.isSignedIn() && this.config().auto; },

  onChange(fn) { this._listeners.push(fn); },
  _notify() {
    for (const fn of this._listeners) {
      try { fn(this._user); } catch (e) { console.warn(e); }
    }
  },

  // Firebase コンソールの firebaseConfig（JSON でも、`const firebaseConfig = { … };`
  // の形のコードでも可）から必要な値を取り出す
  parseFirebaseConfig(text) {
    const out = {};
    const re = /["']?(apiKey|authDomain|projectId|appId|storageBucket|messagingSenderId|measurementId)["']?\s*:\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text || ''))) out[m[1]] = m[2].trim();
    if (!out.apiKey || !out.projectId) {
      throw new Error('apiKey と projectId が見つかりません。Firebase コンソールに表示される firebaseConfig をそのまま貼り付けてください');
    }
    return out;
  },

  // -----------------------------------------------------------
  // ログイン（Firebase Authentication の Google ログイン）
  // -----------------------------------------------------------
  _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Googleログインの部品を読み込めませんでした（ネットワークを確認してください）'));
      document.head.appendChild(s);
    });
  },

  // SDK を読み込み、この端末のログイン状態を確かめる（ページを開いたときに1回）
  init() {
    if (this._loading) return this._loading;
    const cfg = this.firebaseConfig();
    if (!cfg) return Promise.resolve(null);
    this._loading = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${GOOGLE_SYNC_SDK_VERSION}`;
      if (typeof firebase === 'undefined') await this._loadScript(`${base}/firebase-app-compat.js`);
      if (!firebase.auth) await this._loadScript(`${base}/firebase-auth-compat.js`);
      this._app = firebase.apps.find((a) => a.name === 'shipSync') || firebase.initializeApp(cfg, 'shipSync');
      this._auth = this._app.auth();
      // テスト用: ローカルの Firebase エミュレーターにつなぐ
      const emu = window.__SHIP_SYNC_FIREBASE_EMULATOR__;
      if (emu && emu.auth) this._auth.useEmulator(emu.auth, { disableWarnings: true });
      await new Promise((resolve) => {
        let first = true;
        this._auth.onAuthStateChanged((u) => {
          this._user = u || null;
          if (first) { first = false; resolve(); } else this._notify();
        });
      });
      this._ready = true;
      this._notify();
      return this._user;
    })();
    this._loading.catch(() => { this._loading = null; });
    return this._loading;
  },

  // 「Googleでログイン」ボタンから直接呼ぶ（ログイン用の画面はボタンを押した
  // その場で開かないとブラウザに止められるので、この前に await を挟まない）
  signIn() {
    // v86: Android アプリ（Capacitor）の中では、Google のログイン画面がアプリ内の表示を受け付けない
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      return Promise.reject(new Error('Android アプリでは Google でのログインは使えません（Google の決まりで、アプリ内の画面からはログインできないため）。Web 版で同期するか、「GitHub で同期」を使ってください'));
    }
    if (!this._auth) return Promise.reject(new Error('準備中です。少し待ってからもう一度押してください'));
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return this._auth.signInWithPopup(provider).then((cred) => {
      this._user = cred.user;
      this._notify();
      return cred.user;
    }, (e) => {
      throw new Error(this._authErrorMessage(e));
    });
  },

  async signOut() {
    if (this._auth) await this._auth.signOut();
    this._user = null;
    this._notify();
  },

  // Firebase の設定を変えたとき: いったん片付けて、init() で読み込み直せるようにする
  async reset() {
    const app = this._app;
    this._app = null;
    this._auth = null;
    this._user = null;
    this._ready = false;
    this._loading = null;
    if (app) {
      try { await app.delete(); } catch (e) { /* ignore */ }
    }
    this._notify();
  },

  _authErrorMessage(e) {
    const code = (e && e.code) || '';
    const host = typeof location !== 'undefined' ? location.hostname : '';
    const map = {
      'auth/popup-blocked': 'ログイン用の画面がブロックされました。ブラウザでポップアップを許可してから、もう一度押してください',
      'auth/popup-closed-by-user': 'ログインを中止しました',
      'auth/cancelled-popup-request': 'ログインを中止しました',
      'auth/user-cancelled': 'ログインを中止しました',
      'auth/unauthorized-domain': `このサイトのアドレス（${host}）が、Firebase の Authentication →「設定」→「承認済みドメイン」に入っていません`,
      'auth/operation-not-allowed': 'Firebase の Authentication で「Google」のログインが有効になっていません',
      'auth/configuration-not-found': 'Firebase の Authentication がまだ始められていないか、「Google」のログインが有効になっていません',
      'auth/invalid-api-key': 'Firebase の設定（apiKey）が正しくありません',
      'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Firebase の設定（apiKey）が正しくありません',
      'auth/network-request-failed': 'ネットワークにつながりません',
      'auth/web-storage-unsupported': 'このブラウザの設定（プライベートブラウズなど）ではログインを保存できません',
      'auth/operation-not-supported-in-this-environment': 'この画面ではログインできません（Safari などのブラウザで開いてください）',
    };
    return map[code] || `ログインできませんでした（${code || (e && e.message) || e}）`;
  },

  // -----------------------------------------------------------
  // Cloud Firestore（REST API）
  // -----------------------------------------------------------
  _base() {
    const emu = window.__SHIP_SYNC_FIREBASE_EMULATOR__;
    const host = emu && emu.firestore ? `http://${emu.firestore}` : 'https://firestore.googleapis.com';
    return `${host}/v1/projects/${encodeURIComponent(this.firebaseConfig().projectId)}/databases/(default)/documents`;
  },
  _name(path) {
    return `projects/${this.firebaseConfig().projectId}/databases/(default)/documents/${path}`;
  },
  _shipPath(id) {
    return `users/${this._user.uid}/ships/${id}`;
  },
  _chunkPath(id, rev, i) {
    return `${this._shipPath(id)}/chunks/${rev}_${i}`;
  },

  async _req(method, url, body, opts) {
    if (!this._user) throw new Error('Googleアカウントにログインしていません');
    const token = await this._user.getIdToken();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error('ネットワークにつながりません');
    }
    if (res.status === 404 && opts && opts.allow404) return null;
    if (!res.ok) {
      let text = '';
      try { const j = await res.json(); text = (j.error && j.error.message) || ''; } catch (e) {}
      let msg = `${res.status} ${text}`.trim();
      if (/has not been used|is disabled|SERVICE_DISABLED/i.test(text)) {
        msg = 'Cloud Firestore がまだ使える状態になっていません（Firebase コンソールで「Firestore Database」を作成してください）';
      } else if (res.status === 404 && /database/i.test(text)) {
        msg = 'Firestore のデータベースがまだ作られていません（Firebase コンソールで「Firestore Database」を作成してください）';
      } else if (res.status === 401) {
        msg = 'ログインの期限が切れました。もう一度ログインしてください';
      } else if (res.status === 403) {
        msg = 'データを読み書きする権限がありません（Firestore の「ルール」を、設定画面の「最初の準備」のとおりにしてください）';
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  },

  // JS の値 ⇔ Firestore の値（文字列・整数・小数・真偽・null・バイト列）
  _enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (v instanceof Uint8Array) return { bytesValue: ShipSync._bytesToBase64(v) };
    return { stringValue: String(v) };
  },
  _fields(obj) {
    const f = {};
    for (const [k, v] of Object.entries(obj)) f[k] = this._enc(v);
    return f;
  },
  _dec(f) {
    if (!f) return undefined;
    if ('stringValue' in f) return f.stringValue;
    if ('integerValue' in f) return Number(f.integerValue);
    if ('doubleValue' in f) return f.doubleValue;
    if ('booleanValue' in f) return f.booleanValue;
    if ('nullValue' in f) return null;
    if ('bytesValue' in f) return f.bytesValue; // base64 のまま（使う側で戻す）
    return undefined;
  },
  _plain(doc) {
    const out = { id: doc.name.split('/').pop() };
    for (const [k, v] of Object.entries(doc.fields || {})) out[k] = this._dec(v);
    return out;
  },

  _commit(writes) {
    return this._req('POST', `${this._base()}:commit`, { writes });
  },

  async _listShips() {
    const out = new Map();
    let pageToken = '';
    do {
      const url = `${this._base()}/users/${this._user.uid}/ships?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const j = await this._req('GET', url);
      for (const doc of (j && j.documents) || []) {
        const p = this._plain(doc);
        out.set(p.id, p);
      }
      pageToken = (j && j.nextPageToken) || '';
    } while (pageToken);
    return out;
  },

  _putShip(id, meta) {
    return this._commit([{ update: { name: this._name(this._shipPath(id)), fields: this._fields(meta) } }]);
  },

  // 船体モデル ⇔ バイト列（GLB はそのままのバイナリ、OBJ は中身をまとめた JSON）
  _modelToBytes(model) {
    if (model.format === 'glb' && model.glbDataUrl) {
      return { format: 'glb', bytes: ShipSync._base64ToBytes(model.glbDataUrl.slice(model.glbDataUrl.indexOf(',') + 1)) };
    }
    return { format: 'obj', bytes: new TextEncoder().encode(JSON.stringify(model)) };
  },
  _bytesToModel(format, bytes, fileName) {
    if (format === 'glb') {
      return {
        format: 'glb',
        fileName: fileName || 'model.glb',
        glbDataUrl: `data:model/gltf-binary;base64,${ShipSync._bytesToBase64(bytes)}`,
        objText: null, mtlText: null, textures: null,
      };
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  },

  async _uploadModel(id, rev, model, progress, label) {
    const { format, bytes } = this._modelToBytes(model);
    if (bytes.length > GOOGLE_SYNC_MAX_MODEL_BYTES) {
      throw new Error(`船体モデルが大きすぎて同期できません（${(bytes.length / 1e6).toFixed(0)}MB、${GOOGLE_SYNC_MAX_MODEL_BYTES / 1e6}MBまで）`);
    }
    const n = Math.max(1, Math.ceil(bytes.length / GOOGLE_SYNC_CHUNK_BYTES));
    for (let k = 0; k < n; k += GOOGLE_SYNC_BATCH_CHUNKS) {
      progress(`${label}: 船体モデルを送信中 ${Math.min(k + GOOGLE_SYNC_BATCH_CHUNKS, n)}/${n}`);
      const writes = [];
      for (let i = k; i < Math.min(n, k + GOOGLE_SYNC_BATCH_CHUNKS); i++) {
        const part = bytes.subarray(i * GOOGLE_SYNC_CHUNK_BYTES, (i + 1) * GOOGLE_SYNC_CHUNK_BYTES);
        writes.push({ update: { name: this._name(this._chunkPath(id, rev, i)), fields: this._fields({ rev, i, n, data: part }) } });
      }
      await this._commit(writes);
    }
    return { format, chunks: n, bytes: bytes.length };
  },

  async _downloadModel(id, meta, progress, label) {
    const n = meta.modelChunks || 0;
    if (!n || !meta.modelRev) return null;
    const parts = new Array(n);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < n) {
        const i = next++;
        const doc = await this._req('GET', `${this._base()}/${this._chunkPath(id, meta.modelRev, i)}`, null, { allow404: true });
        if (!doc || !doc.fields || !doc.fields.data) {
          throw new Error('船体モデルの一部が見つかりません（別の端末が送信している途中かもしれません。少し待ってからもう一度同期してください）');
        }
        parts[i] = ShipSync._base64ToBytes(this._dec(doc.fields.data));
        done++;
        progress(`${label}: 船体モデルを受信中 ${done}/${n}`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const total = parts.reduce((s, p) => s + p.length, 0);
    if (meta.modelBytes && total !== meta.modelBytes) throw new Error('船体モデルを正しく受け取れませんでした（もう一度同期してください）');
    const all = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return this._bytesToModel(meta.modelFormat, all, meta.modelFileName);
  },

  _deleteChunks(id, rev, n) {
    if (!rev || !(n > 0)) return Promise.resolve();
    const writes = [];
    for (let i = 0; i < n; i++) writes.push({ delete: this._name(this._chunkPath(id, rev, i)) });
    return this._commit(writes);
  },

  // -----------------------------------------------------------
  // 同期（GitHubSync と同じ「更新日時の新しい方が勝つ」方式）
  // -----------------------------------------------------------
  async syncAll(progress) {
    if (!this.isSignedIn()) throw new Error('Googleアカウントにログインしていません');
    if (this._running) return this._running;
    this._running = this._syncAll(progress || (() => {})).finally(() => { this._running = null; });
    return this._running;
  },

  async _syncAll(progress) {
    progress('同期中…');
    const remote = await this._listShips();
    const local = new Map((await listShipDesigns()).map((d) => [d.id, d]));
    const tomb = loadShipDesignTombstones();
    const ids = new Set([...local.keys(), ...remote.keys(), ...Object.keys(tomb)]);
    let up = 0, down = 0, del = 0;
    const failed = [];

    for (const id of ids) {
      const L = local.get(id);
      const R = remote.get(id);
      const t = tomb[id];
      const lT = L ? L.updatedAt || 0 : 0;
      const rT = R ? R.updatedAt || 0 : 0;
      try {
        if (L && (!R || lT > rT)) {
          // この端末の方が新しい → 送る（船体モデル → 設計 → 古いモデルの片付け の順。
          // 途中で止まっても、ほかの端末が読む設計は常にそろったモデルを指す）
          progress(`送信中: ${L.name}`);
          const meta = {
            name: L.name, updatedAt: lT, deleted: false, design: null,
            modelRev: null, modelFormat: null, modelFileName: null, modelChunks: 0, modelBytes: 0,
            gameVersion: GAME_VERSION,
          };
          let design = L;
          const hadRemoteModel = R && !R.deleted && R.modelRev && R.modelChunks > 0;
          if (L.hull.hasModel) {
            if (!L.hull.modelRev) {
              L.hull.modelRev = generateShipDesignId();
              await saveShipDesign(L, { keepTimestamp: true });
            }
            if (hadRemoteModel && R.modelRev === L.hull.modelRev) {
              // 同じモデルはもう送ってある
              Object.assign(meta, { modelRev: R.modelRev, modelFormat: R.modelFormat, modelFileName: R.modelFileName, modelChunks: R.modelChunks, modelBytes: R.modelBytes });
            } else {
              const model = await loadShipDesignModel(id);
              if (model) {
                const m = await this._uploadModel(id, L.hull.modelRev, model, progress, L.name);
                Object.assign(meta, { modelRev: L.hull.modelRev, modelFormat: m.format, modelFileName: model.fileName || null, modelChunks: m.chunks, modelBytes: m.bytes });
              } else {
                // モデルの中身がこの端末に無い: モデル無しの設計として送る
                design = { ...L, hull: { ...L.hull, hasModel: false, modelRev: null } };
              }
            }
          }
          meta.design = JSON.stringify(design);
          await this._putShip(id, meta);
          if (hadRemoteModel && R.modelRev !== meta.modelRev) await this._deleteChunks(id, R.modelRev, R.modelChunks);
          up++;
        } else if (!L && t && R && !R.deleted && t > rT) {
          // この端末で消した → 消したことを送る
          progress(`削除を送信中: ${R.name}`);
          await this._putShip(id, {
            name: R.name, updatedAt: t, deleted: true, design: null,
            modelRev: null, modelFormat: null, modelFileName: null, modelChunks: 0, modelBytes: 0,
            gameVersion: GAME_VERSION,
          });
          if (R.modelRev) await this._deleteChunks(id, R.modelRev, R.modelChunks || 0);
          del++;
        } else if (R && R.deleted) {
          // ほかの端末で消された → この端末でも消す（こちらでその後に編集していなければ）
          if (L && rT > lT) {
            await deleteShipDesign(id, { noTombstone: true });
            del++;
          }
        } else if (R && R.design && (!L || rT > lT) && !(t && t >= rT)) {
          // ほかの端末の方が新しい → 受け取る
          progress(`受信中: ${R.name}`);
          const d = normalizeShipDesign(JSON.parse(R.design));
          d.updatedAt = rT || d.updatedAt;
          let model;
          if (d.hull.hasModel && R.modelChunks > 0) {
            if (!L || !L.hull.hasModel || L.hull.modelRev !== R.modelRev) {
              model = await this._downloadModel(id, R, progress, R.name);
            }
          } else {
            d.hull.hasModel = false;
            model = null;
          }
          // モデルを受け取りきってから保存する（途中で失敗したら、この艦は次の同期でやり直し）
          if (model !== undefined) await saveShipDesignModel(id, model);
          await saveShipDesign(d, { keepTimestamp: true });
          down++;
        }
      } catch (e) {
        console.warn(`艦の設計(${id})の同期に失敗しました。`, e);
        failed.push(`${(L || R || {}).name || id}: ${e.message || e}`);
        // ログインや権限・ネットワークの問題なら、ほかの艦も同じなので打ち切る
        if (e.status === 401 || e.status === 403 || /ネットワーク|Firestore/.test(e.message || '')) break;
      }
    }

    this.saveConfig({ lastSyncAt: Date.now() });
    const counts = `送信${up}・受信${down}・削除${del}`;
    if (failed.length) {
      const err = new Error(`一部の艦を同期できませんでした（${counts}）: ${failed.join(' / ')}`);
      progress(err.message);
      throw err;
    }
    const msg = up || down || del ? `同期しました（${counts}）` : '同期しました（変更なし）';
    progress(msg);
    return { up, down, del, msg };
  },
};
