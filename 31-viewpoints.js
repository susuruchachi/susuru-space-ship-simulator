// =============================================================
// 31-viewpoints.js
// v89: 艦内の視点（1人称）
//
// 艦船建造で置いた「視点」（design.viewpoints）から、艦の中にいるように外を見る。
//   通常   : その場所から見回すだけ
//   見張り台: 双眼鏡（ピンチ・ホイールで拡大）。見ているものを追尾する
//   船橋   : 双眼鏡・追尾に加えて、艦全体の状況（機関・航行・武装・損傷）の計器盤を出す
//
// 見回す: 画面をドラッグ。追尾: 画面の中央近くに攻撃目標（照準の目標・演習の敵）・天体があると、
// それを中央に保ち続ける（自分でドラッグすると外れる）。
// 右上の「艦内: ○○」ボタンで、外からの視点 → 視点1 → 視点2 … と切り替える。
// =============================================================

const VIEWPOINT_KINDS = {
  normal: { label: '通常視点', color: 0xffffff, zoom: false, track: false },
  lookout: { label: '見張り台', color: 0x9fe8ff, zoom: true, track: true },
  bridge: { label: '船橋', color: 0xffd27a, zoom: true, track: true },
};
function normalizeShipViewpoints(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (!v || !VIEWPOINT_KINDS[v.kind]) continue;
    const p = v.position || {};
    out.push({
      id: typeof v.id === 'string' && v.id ? v.id : `vp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: v.kind,
      name: typeof v.name === 'string' ? v.name.slice(0, 20) : '',
      position: { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 },
    });
  }
  return out;
}
function shipViewpointLabel(list, v) {
  if (v.name) return v.name;
  const same = list.filter((x) => x.kind === v.kind);
  return same.length > 1 ? `${VIEWPOINT_KINDS[v.kind].label}${same.indexOf(v) + 1}` : VIEWPOINT_KINDS[v.kind].label;
}

const Viewpoints = {
  list: [],
  index: -1, // -1 = 外からの視点
  FOV_BASE: 60,
  FOV_MIN: 1.2,
  _fov: 60,
  _yaw: 0, _pitch: 0, // 見ている向き（艦に対して。yaw は左が＋、pitch は上が＋）
  _track: null,
  _noTrackUntil: 0,

  get active() { return this.index >= 0 && this.index < this.list.length; },
  get current() { return this.active ? this.list[this.index] : null; },

  init(canvas) {
    this._bindDrag(canvas);
    // 切り替えボタン（視点のボタンの下）
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-viewpoint';
    btn.style.display = 'none';
    btn.addEventListener('click', () => this.cycle());
    document.body.appendChild(btn);
    this._btn = btn;
    // 双眼鏡の枠・追尾の表示
    const ov = document.createElement('div');
    ov.className = 'vp-overlay';
    ov.style.display = 'none';
    ov.innerHTML = '<div class="vp-bino"></div><div class="vp-cross"></div><div class="vp-info"></div>';
    document.body.appendChild(ov);
    this._ov = ov;
    this._buildBridge();
    this._sync();
  },

  // 設計を反映（index.html applyShipDesignInGame）
  setDesign(design) {
    this.list = normalizeShipViewpoints(design && design.viewpoints);
    if (this.index >= this.list.length) this.exit();
    this._sync();
  },

  cycle() {
    if (!this.list.length) return;
    const next = this.index + 1;
    if (next >= this.list.length) this.exit();
    else this.enter(next);
  },
  enter(i) {
    if (!(i >= 0 && i < this.list.length)) return;
    if (typeof Weapons !== 'undefined' && Weapons.view) Weapons.setView(false);
    this.index = i;
    this._yaw = 0; this._pitch = 0; this._fov = this.FOV_BASE; this._track = null;
    this._sync();
  },
  exit() {
    this.index = -1;
    this._track = null;
    if (this._savedFov && typeof camera !== 'undefined' && camera) { camera.fov = this._savedFov; camera.updateProjectionMatrix(); }
    this._savedFov = null;
    this._sync();
  },

  zoomBy(factor) {
    const v = this.current;
    if (!v || !VIEWPOINT_KINDS[v.kind].zoom) return;
    this._fov = Math.max(this.FOV_MIN, Math.min(this.FOV_BASE, this._fov * factor));
  },

  _bindDrag(canvas) {
    let drag = null;
    const start = (x, y, id) => { if (this.active && !(typeof Weapons !== 'undefined' && Weapons.view)) drag = { x, y, id }; };
    const move = (x, y, id) => {
      if (!drag || drag.id !== id || !this.active) return;
      const dx = x - drag.x, dy = y - drag.y;
      drag.x = x; drag.y = y;
      // 指の下の景色が指についてくる速さ（拡大しているほどゆっくり）
      const k = ((this._fov * Math.PI) / 180) / Math.max(1, window.innerHeight);
      this._yaw += dx * k;
      this._pitch = Math.max(-1.45, Math.min(1.45, this._pitch + dy * k));
      if (Math.abs(dx) + Math.abs(dy) > 0) { this._track = null; this._noTrackUntil = performance.now() + 1500; }
    };
    const end = (id) => { if (drag && drag.id === id) drag = null; };
    canvas.addEventListener('touchstart', (e) => { const tt = e.targetTouches; if (tt.length === 1) start(tt[0].clientX, tt[0].clientY, tt[0].identifier); else drag = null; }, { passive: true });
    canvas.addEventListener('touchmove', (e) => { if (e.targetTouches.length === 1) for (const t of e.changedTouches) move(t.clientX, t.clientY, t.identifier); }, { passive: true });
    canvas.addEventListener('touchend', (e) => { for (const t of e.changedTouches) end(t.identifier); });
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.shiftKey) start(e.clientX, e.clientY, 'mouse'); });
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY, 'mouse'));
    window.addEventListener('mouseup', () => end('mouse'));
  },

  // 見ている向き（フレームの座標の単位ベクトル）
  _dir(ship) {
    const q = new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    const d = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(1, 0, 0), this._pitch).applyAxisAngle(new THREE.Vector3(0, 1, 0), this._yaw);
    return d.applyQuaternion(q);
  },
  // 向き（フレームの座標）から yaw / pitch へ
  _setDir(ship, d) {
    const q = new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w).invert();
    const l = d.clone().applyQuaternion(q).normalize();
    this._pitch = Math.asin(Math.max(-1, Math.min(1, l.y)));
    this._yaw = Math.atan2(-l.x, -l.z);
  },

  // 追尾できるもの: 攻撃目標（照準の目標・演習の敵）と天体
  _trackables(ship, eye) {
    const out = [];
    if (typeof Weapons !== 'undefined' && Weapons.practice) {
      for (const t of Weapons.practice.targets) {
        if (!t.alive || t.temp) continue;
        out.push({ key: t, label: t.label + (t === Weapons.lock ? '（照準の目標）' : ''), dir: () => t.pos.clone().sub(eye).normalize(), alive: () => t.alive, dist: () => t.pos.distanceTo(eye), bonus: t === Weapons.lock ? 2 : 1 });
      }
    }
    if (typeof SolarSystem !== 'undefined' && typeof Navigation !== 'undefined' && Navigation.frame) {
      const u = Navigation.shipUniverse();
      for (const b of SolarSystem.bodies) {
        if (b.type === 'station') continue;
        const dirOf = () => { const uu = Navigation.shipUniverse(); const v = Astro.mat3MulVec(Navigation.frame.rotT, { x: b.pos.x - uu.x, y: b.pos.y - uu.y, z: b.pos.z - uu.z }); return new THREE.Vector3(v.x, v.y, v.z).normalize(); };
        const d = Math.hypot(b.pos.x - u.x, b.pos.y - u.y, b.pos.z - u.z);
        // 遠すぎて点にも見えない小さな天体は対象にしない（見かけの大きさ・明るさのあるものだけ）
        const ang = (b.meanRadiusM || b.rM || 0) / Math.max(1, d);
        if (ang < 2e-7 && b.type !== 'star' && b.type !== 'planet') continue;
        out.push({ key: b, label: b.ja || b.id, dir: dirOf, alive: () => true, dist: () => { const uu = Navigation.shipUniverse(); return Math.hypot(b.pos.x - uu.x, b.pos.y - uu.y, b.pos.z - uu.z); }, bonus: 1 });
      }
    }
    return out;
  },

  // 毎フレーム: カメラを視点に置く。視点の中なら true（index.html animateFrame）
  updateCamera(cam, dt) {
    if (!this.active) return false;
    const ship = State.ship;
    if (!ship || !ship.mesh) return false;
    const v = this.current;
    const K = VIEWPOINT_KINDS[v.kind];
    if (!this._savedFov) this._savedFov = cam.fov;
    // 視点の位置（設計の座標 → 世界）
    ship.mesh.updateMatrixWorld(true);
    const off = ship.mesh.userData && ship.mesh.userData.designOffset;
    const eye = new THREE.Vector3(v.position.x, v.position.y, v.position.z);
    if (off) { off.updateMatrixWorld(true); off.localToWorld(eye); } else ship.mesh.localToWorld(eye);

    // 追尾: 追っているものが無ければ、中央の近くにあるものを探す
    if (K.track) {
      if (this._track && !this._track.alive()) this._track = null;
      if (!this._track && performance.now() > this._noTrackUntil) {
        const d0 = this._dir(ship);
        const thr = Math.max(0.012, (this._fov * Math.PI / 180) * 0.07); // 画面の高さの 7% ほど
        let best = null, bs = Infinity;
        for (const t of this._trackables(ship, eye)) {
          const a = Math.acos(Math.max(-1, Math.min(1, t.dir().dot(d0))));
          if (a < thr * t.bonus && a / t.bonus < bs) { bs = a / t.bonus; best = t; }
        }
        this._track = best;
      }
      if (this._track) {
        // なめらかに中央へ（離れているほど速く）
        const want = this._track.dir();
        const cur = this._dir(ship);
        const k = 1 - Math.exp(-Math.min(dt || 0.016, 0.1) / 0.18);
        this._setDir(ship, cur.lerp(want, k).normalize());
      }
    } else this._track = null;

    const dir = this._dir(ship);
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    cam.position.copy(eye);
    cam.up.set(up.x, up.y, up.z);
    cam.lookAt(eye.x + dir.x, eye.y + dir.y, eye.z + dir.z);
    const fov = K.zoom ? this._fov : this.FOV_BASE;
    if (Math.abs(cam.fov - fov) > 1e-6) { cam.fov = fov; cam.updateProjectionMatrix(); }

    // 表示
    const mag = this.FOV_BASE / fov;
    const ov = this._ov;
    ov.classList.toggle('bino', mag > 1.6);
    let info = `${shipViewpointLabel(this.list, v)}`;
    if (K.zoom) info += `・双眼鏡 ×${mag.toFixed(1)}`;
    if (this._track) {
      const d = this._track.dist();
      const fmt = d >= 1.5e9 ? `${(d / 1.495978707e11).toFixed(3)} au` : d >= 1e6 ? `${Math.round(d / 1000).toLocaleString()} km` : `${(d / 1000).toFixed(1)} km`;
      info += `・追尾: ${this._track.label}（${fmt}）`;
    } else if (K.track) info += '・ドラッグで見回す／ピンチで拡大（中央に目標・天体を入れると追尾）';
    else info += '・ドラッグで見回す';
    const el = ov.querySelector('.vp-info');
    if (el.textContent !== info) el.textContent = info;
    ov.classList.toggle('tracking', !!this._track);
    this._bridgeT = (this._bridgeT || 0) - (dt || 0.016);
    if (v.kind === 'bridge' && this._bridgeT <= 0) { this._bridgeT = 0.25; this._updateBridge(); }
    return true;
  },

  _sync() {
    const b = this._btn;
    if (!b) return;
    b.style.display = this.list.length ? '' : 'none';
    const v = this.current;
    b.textContent = v ? `艦内: ${shipViewpointLabel(this.list, v)}` : '艦内の視点へ';
    b.classList.toggle('active', !!v);
    this._ov.style.display = v ? '' : 'none';
    this._bridge.style.display = v && v.kind === 'bridge' ? '' : 'none';
    document.body.classList.toggle('viewpoint-active', !!v);
    document.body.classList.toggle('viewpoint-bridge', !!(v && v.kind === 'bridge'));
  },

  // ---------------------------------------------------------
  // 船橋の計器盤: 機関・航行／武装／損傷。0.25秒ごとに書き直す
  // ---------------------------------------------------------
  _buildBridge() {
    const el = document.createElement('div');
    el.className = 'bridge-console';
    el.style.display = 'none';
    el.innerHTML = `
      <section class="bc-panel bc-eng"><h4>機関 / 航行<span class="bc-id">ENG-NAV</span></h4><div class="bc-body"></div></section>
      <section class="bc-panel bc-wpn"><h4>武装<span class="bc-id">ARMAMENT</span></h4><div class="bc-body"></div></section>
      <section class="bc-panel bc-dmg"><h4>損傷管制<span class="bc-id">DAMAGE CTRL</span></h4><div class="bc-body"></div></section>`;
    document.body.appendChild(el);
    this._bridge = el;
  },
  _bar(ratio, cls) { return `<span class="bc-bar ${cls || ''}"><i style="width:${Math.max(0, Math.min(100, ratio * 100)).toFixed(0)}%"></i></span>`; },
  _updateBridge() {
    const ship = State.ship;
    if (!ship || !this._bridge) return;
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    // --- 機関・航行 ---
    const sp = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    const thr = Math.round((State.input.thrustForward ?? 0) * 100);
    const ratio = (kind) => (typeof HUD !== 'undefined' && HUD._computeThrustGroupRatio ? HUD._computeThrustGroupRatio(ship, kind) : 0);
    const main = ratio('main'), retro = ratio('retro');
    const ikn = typeof SHIP_IKN !== 'undefined' ? sp / SHIP_IKN : 0;
    const spText = ikn >= 0.01 ? `${ikn.toFixed(2)} IKn` : sp >= 1000 ? `${(sp / 1000).toFixed(2)} km/s` : `${sp.toFixed(1)} m/s`;
    const maxR = Number.isFinite(ship.maxSpeed) && ship.maxSpeed > 0 ? Math.min(1, sp / ship.maxSpeed) : 0;
    let eng = `<div class="bc-row"><label>スロットル</label>${this._bar(Math.abs(thr) / 100, thr < 0 ? 'warn' : '')}<b>${thr}%</b></div>`;
    eng += `<div class="bc-row"><label>主機出力</label>${this._bar(main)}<b>${Math.round(main * 100)}%</b></div>`;
    eng += `<div class="bc-row"><label>逆噴射</label>${this._bar(retro, 'warn')}<b>${Math.round(retro * 100)}%</b></div>`;
    eng += `<div class="bc-row"><label>速度</label>${this._bar(maxR)}<b>${spText}</b></div>`;
    if (typeof Navigation !== 'undefined' && Navigation.locationInfo) {
      try {
        const li = Navigation.locationInfo();
        if (li && li.body) { const a = li.altitude; eng += `<div class="bc-line">現在地 ${esc(li.body.ja || li.body.id)}・高度 ${a >= 1.5e9 ? (a / 1.495978707e11).toFixed(3) + ' au' : Math.round(a / 1000).toLocaleString() + ' km'}</div>`; }
      } catch (e) { /* ignore */ }
    }
    if (typeof Planetfall !== 'undefined' && Planetfall.active) {
      const a = Planetfall.active;
      eng += `<div class="bc-line">${esc(a.body.ja)} 高度 ${a.alt >= 1000 ? (a.alt / 1000).toFixed(1) + ' km' : Math.round(a.alt) + ' m'}・${esc(a.state)}</div>`;
    }
    const W = typeof Weapons !== 'undefined' ? Weapons : null;
    const engEff = W && W._dmg ? W._eff('engine') : 1;
    if (engEff < 0.999) eng += `<div class="bc-line bad">機関本体 損傷（働き ${Math.floor(engEff * 100)}%）</div>`;
    this._bridge.querySelector('.bc-eng .bc-body').innerHTML = eng;

    // --- 武装 ---
    let wp = '';
    if (W && W.rig && W.rig.mounts.length) {
      const P = W.practice;
      if (P) wp += `<div class="bc-line">演習 第${P.wave}波・敵 残り ${P.alive}/${P.total}${W.lock ? `・照準: ${esc(W.lock.label)}` : ''}</div>`;
      for (const g of W.groups || []) {
        const ms = g.mounts;
        const n = ms.length;
        const ready = ms.filter((m) => m.state === 'ready' || m.state === 'indep').length;
        const dead = ms.filter((m) => m._dmgPart && (m._dmgPart.dead || m._dmgPart.hp / m._dmgPart.max < W.TURRET_NOFIRE)).length;
        const jam = ms.filter((m) => m._dmgPart && !m._dmgPart.dead && m._dmgPart.hp / m._dmgPart.max < W.TURRET_JAM && m._dmgPart.hp / m._dmgPart.max >= W.TURRET_NOFIRE).length;
        wp += `<div class="bc-row"><label>${esc(g.name)}</label>${this._bar(n ? ready / n : 0, 'ok')}<b>${W.aim.active ? `射撃可 ${ready}` : '待機'}/${n}</b></div>`;
        // 砲ごとの小さな四角（状態の色）
        wp += `<div class="bc-cells">${ms.slice().sort((a, b) => a.num - b.num).map((m) => {
          const pt = m._dmgPart;
          const e = pt ? pt.hp / pt.max : 1;
          const cls = pt && pt.dead ? 'x' : e < W.TURRET_NOFIRE ? 'd' : e < W.TURRET_JAM ? 'j' : W.aim.active ? `s-${m.state}` : 'idle';
          return `<i class="${cls}" title="${m.num}番 ${esc(m.key)}"></i>`;
        }).join('')}</div>`;
        if (dead || jam) wp += `<div class="bc-line bad">${dead ? `射撃不能 ${dead}基` : ''}${dead && jam ? '・' : ''}${jam ? `旋回不能 ${jam}基` : ''}</div>`;
      }
      wp += `<div class="bc-line">${W.aim.active ? (W.focusAll ? '全門指向' : '照準中') : '照準していません'}${W.maneuverMode && W.maneuverMode !== 'off' ? `・${W.MANEUVER_MODES[W.maneuverMode]}` : ''}</div>`;
    } else wp = '<div class="bc-line">武装なし</div>';
    this._bridge.querySelector('.bc-wpn .bc-body').innerHTML = wp;

    // --- 損傷 ---
    let dm = '';
    if (W && W.practice) {
      const P = W.practice;
      const f = Math.max(0, Math.min(1, P.shipHP / P.shipHPMax));
      dm += `<div class="bc-row"><label>船体</label>${this._bar(f, f > 0.5 ? 'ok' : f > 0.25 ? 'warn' : 'bad')}<b>${Math.ceil(f * 100)}%</b></div>`;
    }
    if (W && W._dmg) {
      const D = W._dmg;
      const order = { bridge: 0, engine: 1, defense: 2, fcs: 3, director: 4, turret: 5 };
      const vit = D.parts.filter((x) => x.kind !== 'turret');
      for (const pt of vit.sort((a, b) => order[a.kind] - order[b.kind])) {
        const e = pt.hp / pt.max;
        dm += `<div class="bc-row"><label>${esc(pt.label)}</label>${this._bar(e, pt.dead ? 'bad' : e > 0.6 ? 'ok' : e > 0.3 ? 'warn' : 'bad')}<b>${pt.dead ? '喪失' : pt.repair ? `修理 ${Math.round((pt.repair.t / pt.repair.total) * 100)}%` : `${Math.floor(e * 100)}%`}</b></div>`;
      }
      const tur = D.parts.filter((x) => x.kind === 'turret');
      const hurt = tur.filter((x) => x.hp < x.max - 1e-6);
      if (tur.length) dm += `<div class="bc-line${hurt.length ? ' bad' : ''}">砲塔 損傷 ${hurt.length}/${tur.length}基（喪失 ${tur.filter((x) => x.dead).length}・修理中 ${tur.filter((x) => x.repair).length}）</div>`;
      const holes = D.spots.filter((x) => x.hole).length;
      dm += `<div class="bc-line${holes ? ' bad' : ''}">被弾箇所 ${D.spots.length}・装甲貫通 ${holes}・修理班 ${D.parts.filter((x) => x.repair).length}/${W.REPAIR_MAX}</div>`;
    } else dm += '<div class="bc-line">損傷なし（演習中に被弾すると表示します）</div>';
    this._bridge.querySelector('.bc-dmg .bc-body').innerHTML = dm;
  },
};
