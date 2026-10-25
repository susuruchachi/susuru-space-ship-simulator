// =============================================================
// 24-sync.js
// 艦の設計（21-ship-design.js）の、端末間の同期とバックアップ
//
// v80: 「複数デバイス間で船のデータを同期できるようにしたい」という要望で新設。
// このゲームはサーバーの無い静的なサイト（GitHub Pages）なので、2つの方法を用意する。
//
// 1) ファイルで書き出し・読み込み（設定不要）
//    すべての設計（船体モデル込み）を1つのファイル（.json）にして保存し、
//    別の端末で読み込む。iCloud Drive などのファイル共有で受け渡しする。
//
// 2) GitHub で自動同期
//    利用者自身の非公開リポジトリ（例: susuru-space-ship-data）に、GitHubの
//    API で設計を保存する。各端末で一度だけ、リポジトリ名と「アクセストークン」
//    （そのリポジトリの中身を読み書きできる権限だけのもの）を設定する。
//    リポジトリの中身:
//      ships/index.json        … 全設計の一覧（名前・更新日時・削除済みか・モデルの版）
//      ships/<id>.json         … 設計本体
//      ships/<id>.glb          … 船体モデル（GLB）。OBJ の場合は ships/<id>.obj.json
//    同期のたびに一覧を突き合わせ、新しい方を採用する（更新日時の新しい方が勝つ）。
//    削除も記録して伝える（21-ship-design.js の削除の記録）。
//
// トークンはこの端末のブラウザ（localStorage）にだけ保存し、GitHub 以外には送らない。
//
// v82: Googleアカウントでの同期（25-google-sync.js の GoogleSync）を追加し、
// GitHub は「別の方法」にした。ここの ShipSync は、ファイルの書き出し・読み込みと
// 同期の窓口（使える状態の同期先すべてと順に同期する）。GitHub での同期は GitHubSync。
// =============================================================

const SHIP_SYNC_CONFIG_KEY = 'spaceSimSyncConfig';
const SHIP_SYNC_FILE_FORMAT = 'susuru-space-ships';

const ShipSync = {
  // -----------------------------------------------------------
  // 同期の窓口: Googleアカウント・GitHub のうち使える状態のものと順に同期する。
  //   opts.autoOnly: 「自動で同期する」がオンのものだけ（艦の保存時・設定画面を開いたとき）
  // -----------------------------------------------------------
  providers(opts) {
    const autoOnly = !!(opts && opts.autoOnly);
    const list = [];
    if (typeof GoogleSync !== 'undefined' && GoogleSync.isSignedIn() && (!autoOnly || GoogleSync.config().auto)) list.push(GoogleSync);
    if (GitHubSync.isConfigured() && (!autoOnly || GitHubSync.config().auto)) list.push(GitHubSync);
    return list;
  },

  isAutoSync() {
    return this.providers({ autoOnly: true }).length > 0;
  },

  async syncAll(progress, opts) {
    const list = this.providers(opts);
    if (!list.length) throw new Error('同期先が設定されていません');
    const p = progress || (() => {});
    const many = list.length > 1;
    const msgs = [];
    let failed = false;
    for (const prov of list) {
      try {
        const r = await prov.syncAll((m) => p(many ? `${prov.label}: ${m}` : m));
        msgs.push(many ? `${prov.label}: ${r.msg}` : r.msg);
      } catch (e) {
        if (!many) throw e;
        failed = true;
        msgs.push(`${prov.label}: 失敗（${e.message || e}）`);
      }
    }
    const msg = msgs.join(' / ');
    if (failed) throw new Error(msg);
    p(msg);
    return { msg };
  },

  // -----------------------------------------------------------
  // 文字列・バイト列の変換
  // -----------------------------------------------------------
  _utf8ToBase64(str) {
    return this._bytesToBase64(new TextEncoder().encode(str));
  },
  _base64ToUtf8(b64) {
    return new TextDecoder().decode(this._base64ToBytes(b64));
  },
  _bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  },
  _base64ToBytes(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },

  // -----------------------------------------------------------
  // 1) ファイルで書き出し・読み込み
  // -----------------------------------------------------------
  async exportAll() {
    const designs = await listShipDesigns();
    const items = [];
    for (const d of designs) {
      const model = d.hull.hasModel ? await loadShipDesignModel(d.id) : null;
      items.push({ design: d, model });
    }
    const data = { format: SHIP_SYNC_FILE_FORMAT, version: 1, exportedAt: Date.now(), gameVersion: GAME_VERSION, items, tombstones: loadShipDesignTombstones() };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const name = `space-ships-${this._dateStamp()}.json`;
    this._download(blob, name);
    return { count: items.length, name, bytes: blob.size };
  },

  // v88: 1隻だけ書き出す（送る・受け渡す用）。withModel=false なら3Dモデルを含めない（設定だけの小さなファイル。
  // 読み込んでも、その端末にある3Dモデルはそのまま）。share=true なら、端末の「共有」で送る（使えなければ保存）
  async exportOne(id, withModel, share) {
    const design = await loadShipDesign(id);
    if (!design) throw new Error('艦が見つかりません');
    const model = withModel && design.hull.hasModel ? await loadShipDesignModel(id) : null;
    const item = { design, model };
    if (!withModel && design.hull.hasModel) item.modelOmitted = true;
    const data = { format: SHIP_SYNC_FILE_FORMAT, version: 1, exportedAt: Date.now(), gameVersion: GAME_VERSION, items: [item], tombstones: [] };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    // ファイル名には文字（日本語も可）・数字・_ - だけを使う（記号があると保存できない端末がある）
    const safe = (design.name || 'ship').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'ship';
    const name = `ship-${safe}-${this._dateStamp()}${withModel ? '' : '-nomodel'}.json`;
    if (share && typeof navigator !== 'undefined' && navigator.canShare) {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: design.name });
          return { name, bytes: blob.size, shared: true };
        } catch (e) {
          if (e && e.name === 'AbortError') return { name, bytes: blob.size, cancelled: true };
        }
      }
    }
    this._download(blob, name);
    return { name, bytes: blob.size, shared: false };
  },

  _dateStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  },
  _download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  },

  // 読み込み: 同じIDの設計は更新日時の新しい方を残す
  async importFile(file) {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('ファイルの形式が正しくありません（JSONとして読めません）');
    }
    if (!data || data.format !== SHIP_SYNC_FILE_FORMAT || !Array.isArray(data.items)) {
      throw new Error('艦のデータのファイルではありません');
    }
    const local = new Map((await listShipDesigns()).map((d) => [d.id, d]));
    let added = 0, updated = 0, skipped = 0;
    for (const it of data.items) {
      const d = normalizeShipDesign(it.design);
      if (!d || !d.id) continue;
      const cur = local.get(d.id);
      if (cur && (cur.updatedAt || 0) >= (d.updatedAt || 0)) { skipped++; continue; }
      await saveShipDesign(d, { keepTimestamp: true });
      // v88: 3Dモデルを含めずに書き出したファイルなら、この端末の3Dモデルはそのまま
      if (!it.modelOmitted) await saveShipDesignModel(d.id, d.hull.hasModel ? it.model || null : null);
      if (cur) updated++; else added++;
    }
    return { added, updated, skipped };
  },
};

// =============================================================
// 2) GitHub で同期
// =============================================================
const GitHubSync = {
  label: 'GitHub',

  // -----------------------------------------------------------
  // 設定（同期先のリポジトリ・トークン・自動同期）
  // -----------------------------------------------------------
  config() {
    try {
      const c = JSON.parse(localStorage.getItem(SHIP_SYNC_CONFIG_KEY) || '{}') || {};
      return { repo: c.repo || '', token: c.token || '', auto: c.auto !== false, lastSyncAt: c.lastSyncAt || 0 };
    } catch (e) {
      return { repo: '', token: '', auto: true, lastSyncAt: 0 };
    }
  },

  saveConfig(partial) {
    const c = { ...this.config(), ...partial };
    try { localStorage.setItem(SHIP_SYNC_CONFIG_KEY, JSON.stringify(c)); } catch (e) {}
    return c;
  },

  isConfigured() {
    const c = this.config();
    return /^[\w.-]+\/[\w.-]+$/.test(c.repo) && c.token.length > 10;
  },

  isAutoSync() {
    return this.isConfigured() && this.config().auto;
  },

  async _api(method, path, body, accept) {
    const c = this.config();
    const res = await fetch(`https://api.github.com/repos/${c.repo}/contents/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); if (j && j.message) msg += ` ${j.message}`; } catch (e) {}
      if (res.status === 401) msg = 'トークンが正しくないか、期限が切れています';
      else if (res.status === 403) msg = 'トークンにこのリポジトリへの書き込み権限がありません（Contents: Read and write が必要です）';
      else if (res.status === 404) msg = 'リポジトリが見つかりません（名前とトークンの対象リポジトリを確認してください）';
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    if (accept === 'application/vnd.github.raw') return res;
    return res.status === 204 ? null : res.json();
  },

  async _getJson(path) {
    const r = await this._api('GET', path);
    if (!r) return null;
    let text;
    if (r.content && r.encoding === 'base64') text = ShipSync._base64ToUtf8(r.content);
    else {
      const raw = await this._api('GET', path, null, 'application/vnd.github.raw');
      text = await raw.text();
    }
    return { data: JSON.parse(text), sha: r.sha };
  },

  async _put(path, base64, sha, message, noRetry) {
    const body = { message, content: base64 };
    if (sha) body.sha = sha;
    try {
      const r = await this._api('PUT', path, body);
      return r.content.sha;
    } catch (e) {
      // 手元の記録の sha が古い（ほかの端末が先に書いた）: 今の sha を取り直して1回だけやり直す
      if (!noRetry && (e.status === 409 || e.status === 422)) {
        const cur = await this._api('GET', path);
        if (cur) body.sha = cur.sha; else delete body.sha;
        const r = await this._api('PUT', path, body);
        return r.content.sha;
      }
      throw e;
    }
  },

  async _delete(path, sha, message) {
    try {
      let s = sha;
      if (!s) {
        const cur = await this._api('GET', path);
        if (!cur) return;
        s = cur.sha;
      }
      await this._api('DELETE', path, { message, sha: s });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  },

  // 接続テスト（リポジトリが読めるか）
  async testConnection() {
    const c = this.config();
    const res = await fetch(`https://api.github.com/repos/${c.repo}`, {
      headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (res.status === 401) throw new Error('トークンが正しくないか、期限が切れています');
    if (res.status === 404) throw new Error('リポジトリが見つかりません（名前と、トークンの対象リポジトリを確認してください）');
    if (!res.ok) throw new Error(`接続できませんでした（${res.status}）`);
    const j = await res.json();
    if (j.permissions && !j.permissions.push) throw new Error('このトークンではリポジトリに書き込めません');
    return { name: j.full_name, private: j.private };
  },

  _modelPath(id, model) {
    return model && model.format === 'glb' ? `ships/${id}.glb` : `ships/${id}.obj.json`;
  },

  async _uploadModel(id, model, entry) {
    if (!model) return null;
    const path = this._modelPath(id, model);
    let b64;
    if (model.format === 'glb') {
      // GLB はバイナリのままリポジトリに置く（data URL の中身がそのまま base64）
      b64 = model.glbDataUrl.slice(model.glbDataUrl.indexOf(',') + 1);
    } else {
      b64 = ShipSync._utf8ToBase64(JSON.stringify(model));
    }
    const mb = (b64.length * 0.75) / 1e6;
    if (mb > 70) throw new Error(`船体モデルが大きすぎて同期できません（${mb.toFixed(0)}MB、目安70MBまで）`);
    const sha = await this._put(path, b64, entry && entry.modelPath === path ? entry.modelSha : null, `船体モデル: ${id}`);
    return { path, sha };
  },

  async _downloadModel(entry) {
    if (!entry.modelPath) return null;
    const raw = await this._api('GET', entry.modelPath, null, 'application/vnd.github.raw');
    if (!raw) return null;
    if (entry.modelPath.endsWith('.glb')) {
      const buf = new Uint8Array(await raw.arrayBuffer());
      return {
        format: 'glb',
        fileName: entry.modelFileName || 'model.glb',
        glbDataUrl: `data:model/gltf-binary;base64,${ShipSync._bytesToBase64(buf)}`,
        objText: null, mtlText: null, textures: null,
      };
    }
    return JSON.parse(await raw.text());
  },

  // すべての設計を同期する。progress(msg) で途中経過を知らせる。
  async syncAll(progress) {
    if (!this.isConfigured()) throw new Error('同期先が設定されていません');
    if (this._running) return this._running;
    this._running = this._syncAll(progress || (() => {})).finally(() => { this._running = null; });
    return this._running;
  },

  async _syncAll(progress, attempt) {
    progress('同期中…');
    const idxFile = await this._getJson('ships/index.json');
    const index = idxFile ? idxFile.data : { format: 'susuru-ship-sync', version: 1, designs: {} };
    if (!index.designs) index.designs = {};
    const local = new Map((await listShipDesigns()).map((d) => [d.id, d]));
    const tomb = loadShipDesignTombstones();
    const ids = new Set([...local.keys(), ...Object.keys(index.designs), ...Object.keys(tomb)]);
    let up = 0, down = 0, del = 0, changed = false;

    for (const id of ids) {
      const L = local.get(id);
      const R = index.designs[id];
      const t = tomb[id];
      const lT = L ? L.updatedAt || 0 : 0;
      const rT = R ? R.updatedAt || 0 : 0;

      if (L && (!R || lT > rT)) {
        // この端末の方が新しい → 送る
        progress(`送信中: ${L.name}`);
        const entry = { ...(R || {}) };
        entry.designSha = await this._put(`ships/${id}.json`, ShipSync._utf8ToBase64(JSON.stringify(L)), R && !R.deleted ? R.designSha : null, `設計: ${L.name}`);
        if (L.hull.hasModel) {
          if (!R || R.modelRev !== L.hull.modelRev || !R.modelPath) {
            const model = await loadShipDesignModel(id);
            const m = await this._uploadModel(id, model, R);
            if (R && R.modelPath && m && R.modelPath !== m.path) await this._delete(R.modelPath, R.modelSha, `船体モデルの形式変更: ${id}`);
            entry.modelPath = m ? m.path : null;
            entry.modelSha = m ? m.sha : null;
            entry.modelFileName = model ? model.fileName : null;
          }
        } else if (R && R.modelPath) {
          await this._delete(R.modelPath, R.modelSha, `船体モデルの削除: ${id}`);
          entry.modelPath = null;
          entry.modelSha = null;
        }
        Object.assign(entry, { name: L.name, updatedAt: lT, deleted: false, modelRev: L.hull.hasModel ? L.hull.modelRev || null : null });
        index.designs[id] = entry;
        up++;
        changed = true;
      } else if (!L && t && (!R || (!R.deleted && t > rT))) {
        // この端末で消した → 消したことを送る
        if (R && !R.deleted) {
          progress(`削除を送信中: ${R.name}`);
          await this._delete(`ships/${id}.json`, R.designSha, `設計の削除: ${R.name}`);
          if (R.modelPath) await this._delete(R.modelPath, R.modelSha, `船体モデルの削除: ${id}`);
          index.designs[id] = { name: R.name, updatedAt: t, deleted: true };
          del++;
          changed = true;
        }
      } else if (R && R.deleted) {
        // ほかの端末で消された → この端末でも消す（こちらでその後に編集していなければ）
        if (L && rT > lT) {
          await deleteShipDesign(id, { noTombstone: true });
          del++;
        }
      } else if (R && (!L || rT > lT) && !(t && t >= rT)) {
        // ほかの端末の方が新しい → 受け取る
        progress(`受信中: ${R.name}`);
        const f = await this._getJson(`ships/${id}.json`);
        if (f) {
          const d = normalizeShipDesign(f.data);
          d.updatedAt = rT || d.updatedAt;
          if (d.hull.hasModel && (!L || !L.hull.hasModel || L.hull.modelRev !== R.modelRev)) {
            const model = await this._downloadModel(R);
            await saveShipDesignModel(id, model);
            if (!model) d.hull.hasModel = false;
          } else if (!d.hull.hasModel) {
            await saveShipDesignModel(id, null);
          }
          await saveShipDesign(d, { keepTimestamp: true });
          down++;
        }
      }
    }

    if (changed || !idxFile) {
      index.updatedAt = Date.now();
      try {
        await this._put('ships/index.json', ShipSync._utf8ToBase64(JSON.stringify(index, null, 1)), idxFile ? idxFile.sha : null, '艦の設計の一覧を更新', true);
      } catch (e) {
        // 一覧をほかの端末が同時に書き換えた: 一覧を読み直して、もう一度だけ最初から突き合わせる
        if ((e.status === 409 || e.status === 422) && !attempt) return this._syncAll(progress, 1);
        throw e;
      }
    }
    this.saveConfig({ lastSyncAt: Date.now() });
    const msg = up || down || del
      ? `同期しました（送信${up}・受信${down}・削除${del}）`
      : '同期しました（変更なし）';
    progress(msg);
    return { up, down, del, msg };
  },
};
