// =============================================================
// 31-viewpoints.js
// v89: 艦内の視点（1人称）
//
// 艦船建造で置いた「視点」（design.viewpoints）から、艦の中にいるように外を見る。
//   通常   : その場所から見回すだけ
//   見張り台: 双眼鏡（「双眼鏡」ボタンを押しているあいだだけ拡大。ピンチ・ホイールで倍率）。
//           双眼鏡のあいだは「自動追尾」ボタンで、見ているものを追尾する／しないを切り替える
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
  _bino: false, // v89: 双眼鏡を使っているか（「双眼鏡」ボタン）。使っていないあいだは拡大しない
  _binoFov: 15, // 双眼鏡の倍率（前に使った倍率を覚えておく。はじめは ×4）
  autoTrack: false, // v89: 双眼鏡のあいだの自動追尾（「自動追尾」ボタン）

  get active() { return this.index >= 0 && this.index < this.list.length; },
  get current() { return this.active ? this.list[this.index] : null; },

  init(canvas) {
    this._bindDrag(canvas);
    // 切り替えボタン（視点のボタンの下）
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-viewpoint';
    btn.style.display = 'none';
    // v89: 押すと、視点の一覧（外からの視点・艦内の視点）を出して、そこから選ぶ
    btn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleMenu(); });
    document.body.appendChild(btn);
    this._btn = btn;
    const menu = document.createElement('div');
    menu.className = 'vp-menu';
    menu.style.display = 'none';
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(menu);
    this._menu = menu;
    document.addEventListener('click', () => this._closeMenu());
    // 右上の列（外の視点のボタンと定点の6つのボタン → 艦内の視点のボタン → 演習の目印）を重ならないように並べる
    setInterval(() => { try { this._layoutRight(); } catch (e) { /* ignore */ } }, 300);
    // 双眼鏡の枠・追尾の表示
    const ov = document.createElement('div');
    ov.className = 'vp-overlay';
    ov.style.display = 'none';
    ov.innerHTML = '<div class="vp-bino"></div><div class="vp-cross"></div><div class="vp-info"><span class="vp-text"></span><button type="button" class="vp-tool vp-tool-bino">双眼鏡</button><button type="button" class="vp-tool vp-tool-track">自動追尾</button></div>';
    document.body.appendChild(ov);
    this._ov = ov;
    try { this.autoTrack = localStorage.getItem('spaceSimVpAutoTrack') === '1'; } catch (e) { /* ignore */ }
    // v89: 双眼鏡のボタン（押すと拡大、もう一度押すと元の倍率へ）と、自動追尾のボタン（双眼鏡のあいだだけ出る）
    ov.querySelector('.vp-tool-bino').addEventListener('click', (e) => { e.stopPropagation(); this.setBino(!this._bino); });
    ov.querySelector('.vp-tool-track').addEventListener('click', (e) => {
      e.stopPropagation();
      this.autoTrack = !this.autoTrack;
      if (!this.autoTrack) this._track = null;
      this._noTrackUntil = 0;
      try { localStorage.setItem('spaceSimVpAutoTrack', this.autoTrack ? '1' : '0'); } catch (e2) { /* ignore */ }
    });
    this._buildBridge();
    this._sync();
  },

  // 設計を反映（index.html applyShipDesignInGame）
  setDesign(design) {
    this.list = normalizeShipViewpoints(design && design.viewpoints);
    if (this.index >= this.list.length) this.exit();
    this._sync();
  },

  _toggleMenu() {
    if (this._menu.style.display !== 'none') { this._closeMenu(); return; }
    const m = this._menu;
    m.innerHTML = '';
    const add = (label, sub, active, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `vp-item${active ? ' active' : ''}`;
      b.innerHTML = `<span>${label}</span>${sub ? `<small>${sub}</small>` : ''}`;
      b.addEventListener('click', () => { this._closeMenu(); fn(); });
      m.appendChild(b);
    };
    add('外からの視点', '追従・自由', !this.active, () => this.exit());
    this.list.forEach((v, i) => add(shipViewpointLabel(this.list, v), VIEWPOINT_KINDS[v.kind].label, this.index === i, () => this.enter(i)));
    const r = this._btn.getBoundingClientRect();
    m.style.display = '';
    m.style.top = `${Math.round(r.bottom + 4)}px`;
    m.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    this._btn.classList.add('open');
  },
  _closeMenu() { if (this._menu) this._menu.style.display = 'none'; if (this._btn) this._btn.classList.remove('open'); },
  _layoutRight() {
    if (this._isBridge && this._isBridge()) return; // 船橋では、視点のボタンは右上（CSS）
    const b = this._btn;
    const cc = document.querySelector('.hud-camera-controls');
    let y = null, right = null;
    if (cc && getComputedStyle(cc).display !== 'none') { const r = cc.getBoundingClientRect(); if (r.height > 0) { y = r.bottom + 8; right = window.innerWidth - r.right; } }
    if (b && b.style.display !== 'none') {
      if (y !== null) { b.style.top = `${Math.round(y)}px`; b.style.right = `${Math.round(right)}px`; const r = b.getBoundingClientRect(); y = r.bottom + 8; }
    } else if (b) { b.style.top = ''; b.style.right = ''; }
    const badge = document.querySelector('.practice-badge');
    if (badge && y !== null) { badge.style.top = `${Math.round(y)}px`; badge.style.right = `${Math.round(right)}px`; }
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
    this._yaw = 0; this._pitch = 0; this._fov = this.FOV_BASE; this._track = null; this._bino = false;
    this._sync();
  },
  exit() {
    this.index = -1;
    this._track = null; this._bino = false;
    if (this._savedFov && typeof camera !== 'undefined' && camera) { camera.fov = this._savedFov; camera.updateProjectionMatrix(); }
    this._savedFov = null;
    this._sync();
  },

  // v89: 拡大するのは、双眼鏡を使っているあいだだけ（ピンチ・ホイールは双眼鏡の倍率を変える）
  zoomBy(factor) {
    const v = this.current;
    if (!v || !VIEWPOINT_KINDS[v.kind].zoom || !this._bino) return;
    this._fov = Math.max(this.FOV_MIN, Math.min(this.BINO_FOV_MAX, this._fov * factor));
    this._binoFov = this._fov;
  },
  BINO_FOV_MAX: 30, // 双眼鏡のいちばん低い倍率（×2）
  setBino(on) {
    const v = this.current;
    on = !!(on && v && VIEWPOINT_KINDS[v.kind].zoom);
    this._bino = on;
    this._fov = on ? Math.max(this.FOV_MIN, Math.min(this.BINO_FOV_MAX, this._binoFov)) : this.FOV_BASE;
    if (!on) this._track = null;
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
    if (K.track && this._bino && this.autoTrack) {
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
    const fov = K.zoom && this._bino ? this._fov : this.FOV_BASE;
    if (Math.abs(cam.fov - fov) > 1e-6) { cam.fov = fov; cam.updateProjectionMatrix(); }

    // 表示
    const mag = this.FOV_BASE / fov;
    const ov = this._ov;
    ov.classList.toggle('bino', !!(K.zoom && this._bino));
    let info = `${shipViewpointLabel(this.list, v)}`;
    if (K.zoom && this._bino) info += `・双眼鏡 ×${mag.toFixed(1)}`;
    if (this._track) {
      const d = this._track.dist();
      const fmt = d >= 1.5e9 ? `${(d / 1.495978707e11).toFixed(3)} au` : d >= 1e6 ? `${Math.round(d / 1000).toLocaleString()} km` : `${(d / 1000).toFixed(1)} km`;
      info += `・追尾: ${this._track.label}（${fmt}）`;
    } else if (K.zoom && this._bino) info += this.autoTrack && K.track ? '・ピンチで倍率（中央に目標・天体を入れると追尾）' : '・ピンチで倍率';
    else info += '・ドラッグで見回す';
    const el = ov.querySelector('.vp-text');
    if (el.textContent !== info) el.textContent = info;
    const bb = ov.querySelector('.vp-tool-bino'), tb = ov.querySelector('.vp-tool-track');
    bb.style.display = K.zoom ? '' : 'none';
    bb.classList.toggle('on', !!this._bino);
    tb.style.display = K.zoom && K.track && this._bino ? '' : 'none';
    tb.classList.toggle('on', !!this.autoTrack);
    const tl = this.autoTrack ? '自動追尾: 入' : '自動追尾: 切';
    if (tb.textContent !== tl) tb.textContent = tl;
    ov.classList.toggle('tracking', !!this._track);
    // 船橋の計器は 0.25 秒ごとに（実際の時間で。フレームが遅い端末でも同じ間隔で）
    const now = performance.now();
    if (v.kind === 'bridge' && now - (this._bridgeAt || 0) >= 250) { this._bridgeAt = now; this._updateBridge(); }
    return true;
  },

  _sync() {
    const b = this._btn;
    if (!b) return;
    b.style.display = this.list.length ? '' : 'none';
    const v = this.current;
    b.textContent = v ? `視点: ${shipViewpointLabel(this.list, v)} ▾` : '艦内の視点 ▾';
    this._closeMenu();
    if (v && v.kind === 'bridge') { b.style.top = ''; b.style.right = ''; }
    b.classList.toggle('active', !!v);
    this._ov.style.display = v ? '' : 'none';
    const br = !!(v && v.kind === 'bridge');
    for (const el of [this._frame, this._eng, this._dmgBox]) if (el) el.style.display = br ? '' : 'none';
    if (br) { this._frameKey = ''; setTimeout(() => this._updateBridge(), 0); }
    const info = this._ov && this._ov.querySelector('.vp-info');
    if (info && !br) { info.style.top = ''; info.style.maxWidth = ''; }
    if (!br) { const navEl = document.querySelector('.space-nav-panel'); if (navEl) for (const k of ['left', 'width', 'transform']) navEl.style.removeProperty(k); }
    document.body.classList.toggle('viewpoint-active', !!v);
    document.body.classList.toggle('viewpoint-bridge', !!(v && v.kind === 'bridge'));
  },

  // ---------------------------------------------------------
  // v89: 船橋の視点の画面: 画面の縁の青い枠と、枠の中に並べる計器
  //   上の段: [メニュー] [損傷の側面図] [航行のメニュー（星図など）] [機関出力] [視点の切り替え]
  //   左: メニューの下にレーダー（姿勢の図。大きさ・場所は変えられる）
  //   下の段: 操縦（レバー・スティック・BOOST）と、砲の番号（自動射撃の砲は故障しているものだけ）
  //   画面の大きさに合わせて並べ直し、隙間が足りなければ、損傷の図はレーダーの下へ、機関出力は視点のボタンの下へ移す
  // ---------------------------------------------------------
  _buildBridge() {
    const frame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    frame.setAttribute('class', 'bridge-frame');
    frame.style.display = 'none';
    document.body.appendChild(frame);
    this._frame = frame;
    const eng = document.createElement('div');
    eng.className = 'bridge-eng bridge-box';
    eng.style.display = 'none';
    eng.innerHTML = '<div class="bb-head">機関 <span>ENGINE</span></div><div class="bb-body"></div>';
    document.body.appendChild(eng);
    this._eng = eng;
    const dmg = document.createElement('div');
    dmg.className = 'bridge-dmg bridge-box';
    dmg.style.display = 'none';
    dmg.innerHTML = '<div class="bb-head">損傷 <span>DAMAGE</span><button type="button" class="bb-side">左舷</button></div><canvas></canvas><div class="bb-legend"><i></i>軽<b></b>重</div>';
    document.body.appendChild(dmg);
    this._dmgBox = dmg;
    this._dmgSide = 'port';
    dmg.querySelector('.bb-side').addEventListener('click', (e) => {
      e.stopPropagation();
      this._dmgSide = this._dmgSide === 'port' ? 'stbd' : 'port';
      dmg.querySelector('.bb-side').textContent = this._dmgSide === 'port' ? '左舷' : '右舷';
      this._drawDamage();
    });
    for (const el of [eng, dmg]) { el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }); el.addEventListener('mousedown', (e) => e.stopPropagation()); }
    this._bridge = { style: {} }; // 以前の計器盤の代わり（_sync で display を書くだけ）
    window.addEventListener('resize', () => { this._frameKey = ''; if (this._isBridge()) this._layoutBridge(); });
  },
  _isBridge() { const v = this.current; return !!(v && v.kind === 'bridge'); },

  // 画面の縁の枠（SVG）。角を落とした二重の線と、角・辺の飾り
  _drawFrame() {
    const W = window.innerWidth, H = window.innerHeight;
    const key = `${W}x${H}`;
    if (this._frameKey === key) return;
    this._frameKey = key;
    const f = this._frame;
    f.setAttribute('viewBox', `0 0 ${W} ${H}`);
    f.setAttribute('width', W); f.setAttribute('height', H);
    const o = 3, c = Math.min(26, W * 0.03), i = 7, ci = c - 3;
    const poly = (k, cc) => `M${k + cc},${k} H${W - k - cc} L${W - k},${k + cc} V${H - k - cc} L${W - k - cc},${H - k} H${k + cc} L${k},${H - k - cc} V${k + cc} Z`;
    const cx = W / 2;
    const tick = [];
    for (let x = cx - 160; x <= cx + 160; x += 20) if (Math.abs(x - cx) > 30) tick.push(`M${x},${H - i} V${H - i - (Math.abs(x - cx) % 60 < 1 ? 7 : 4)}`);
    const L = Math.min(90, W * 0.12), Lv = Math.min(70, H * 0.12);
    const corners = [
      `M${o},${o + c + Lv} V${o + c} L${o + c},${o} H${o + c + L}`,
      `M${W - o - c - L},${o} H${W - o - c} L${W - o},${o + c} V${o + c + Lv}`,
      `M${W - o},${H - o - c - Lv} V${H - o - c} L${W - o - c},${H - o} H${W - o - c - L}`,
      `M${o + c + L},${H - o} H${o + c} L${o},${H - o - c} V${H - o - c - Lv}`,
    ].join(' ');
    f.innerHTML = `
      <defs><filter id="bfGlow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <linearGradient id="bfFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ec8ff" stop-opacity="0.95"/><stop offset="0.5" stop-color="#2f8fe0" stop-opacity="0.55"/><stop offset="1" stop-color="#5ec8ff" stop-opacity="0.95"/></linearGradient></defs>
      <path d="${poly(o, c)}" fill="none" stroke="url(#bfFade)" stroke-width="1.6" filter="url(#bfGlow)"/>
      <path d="${poly(i, ci)}" fill="none" stroke="#3aa8ff" stroke-opacity="0.32" stroke-width="1" stroke-dasharray="2 5"/>
      <path d="${corners}" fill="none" stroke="#9ee6ff" stroke-width="3" stroke-linecap="square" filter="url(#bfGlow)"/>
      <path d="M${cx - 50},${o} H${cx + 50} L${cx + 40},${o + 6} H${cx - 40} Z" fill="#5ec8ff" fill-opacity="0.55"/>
      <path d="M${cx - 50},${H - o} H${cx + 50} L${cx + 40},${H - o - 6} H${cx - 40} Z" fill="#5ec8ff" fill-opacity="0.55"/>
      <path d="${tick.join(' ')}" stroke="#5ec8ff" stroke-opacity="0.6" stroke-width="1"/>
      <path d="M${o},${H / 2 - 40} V${H / 2 + 40} M${W - o},${H / 2 - 40} V${H / 2 + 40}" stroke="#9ee6ff" stroke-width="4" filter="url(#bfGlow)"/>`;
  },

  // 上の段の並べ方（重ならないように、隙間に入れる）
  _layoutBridge() {
    if (!this._isBridge()) return;
    this._drawFrame();
    const rect = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el || getComputedStyle(el).display === 'none') return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
    const W = window.innerWidth;
    const tab = rect('.side-menu-tab') || { left: 10, right: 46, top: 10, bottom: 66 };
    const vp = rect(this._btn) || { left: W - 120, right: W - 10, top: 10, bottom: 40 };
    const top = Math.round(Math.max(10, tab.top));
    const gap = 8;
    // v89: 上の段を1列に収める: [損傷の図] [航行のメニュー] [機関出力] を、メニューのボタンと視点のボタンのあいだに
    //   並べる。狭いときは、まず航行のメニューを縮め、それでも足りなければ損傷の図・機関出力も縮める（文字も小さく）
    const D = this._dmgBox, E = this._eng;
    const navEl = document.querySelector('.space-nav-panel');
    const L0 = tab.right + gap, R0 = vp.left - gap;
    const avail = R0 - L0 - gap * 2;
    const want = { d: 230, n: 440, e: 210 }, min = { d: 104, n: 190, e: 96 };
    let dw = want.d, nw = want.n, ew = want.e;
    if (dw + nw + ew > avail) {
      // 航行のメニューから縮める
      nw = Math.max(min.n, avail - dw - ew);
      if (dw + nw + ew > avail) {
        // 損傷の図・機関出力を同じ割合で縮める
        const k = Math.max(0, (avail - nw) / (want.d + want.e));
        dw = Math.max(min.d, want.d * k); ew = Math.max(min.e, want.e * k);
      }
    }
    const fits = dw + nw + ew <= avail + 1;
    const small = dw < 170 || ew < 160;
    D.classList.toggle('small', small); E.classList.toggle('small', small);
    if (fits) {
      Object.assign(D.style, { left: `${Math.round(L0)}px`, top: `${top}px`, width: `${Math.round(dw)}px`, right: 'auto' });
      if (navEl) {
        navEl.style.setProperty('left', `${Math.round(L0 + dw + gap)}px`, 'important');
        navEl.style.setProperty('width', `${Math.round(nw)}px`, 'important');
        navEl.style.setProperty('transform', 'none', 'important');
      }
      Object.assign(E.style, { left: `${Math.round(L0 + dw + gap + nw + gap)}px`, top: `${top}px`, width: `${Math.round(ew)}px` });
    } else {
      // とても狭い（縦向きのスマホなど）: 損傷の図はレーダーの下、機関出力は視点のボタンの下
      if (navEl) for (const k of ['left', 'width', 'transform']) navEl.style.removeProperty(k);
      const navR = rect('.space-nav-panel');
      const ins = rect('.wpn-inset');
      let t = (ins ? ins.bottom : tab.bottom) + gap;
      if (navR && tab.left + min.d > navR.left - gap) t = Math.max(t, navR.bottom + gap);
      Object.assign(D.style, { left: `${Math.round(tab.left)}px`, top: `${Math.round(t)}px`, width: `${Math.round(Math.max(min.d, Math.min(200, W * 0.4)))}px`, right: 'auto' });
      const w = Math.max(min.e, Math.min(190, W * 0.4));
      let te = vp.bottom + gap;
      if (navR && vp.right - w < navR.right + gap) te = Math.max(te, navR.bottom + gap);
      Object.assign(E.style, { left: `${Math.round(vp.right - w)}px`, top: `${Math.round(te)}px`, width: `${Math.round(w)}px` });
    }
    const nav = rect('.space-nav-panel');
    // 機関出力の箱の下に、右下の武装の列・損傷のマークがあれば、収まらないときは1行に縮める
    E.classList.remove('compact');
    const er = E.getBoundingClientRect();
    let lim = window.innerHeight - 8;
    for (const sel of ['.weapon-controls', '.dmg-icons', '.btn-boost']) { const r = rect(sel); if (r && r.left < er.right && r.right > er.left && r.top > er.top) lim = Math.min(lim, r.top - gap); }
    if (er.bottom > lim) {
      E.classList.add('compact');
      E.style.maxHeight = `${Math.max(24, Math.round(lim - er.top))}px`;
    } else E.style.maxHeight = '';
    // 視点の案内（双眼鏡の倍率・追尾）は、航行のメニューの下へ（下の砲の番号と重ならないように）
    const info = this._ov && this._ov.querySelector('.vp-info');
    if (info) {
      info.style.top = `${Math.round((nav ? nav.bottom : top + 40) + 6)}px`;
      info.style.maxWidth = nav ? `${Math.round(nav.width - 24)}px` : '';
    }
    // 損傷の図の絵の大きさ（箱の幅に合わせる）
    const cv = D.querySelector('canvas');
    const cw = Math.max(80, D.clientWidth - 12);
    const ch = Math.round(Math.max(26, Math.min(64, cw * 0.24)));
    const pr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(cw * pr) || cv.height !== Math.round(ch * pr)) {
      cv.width = Math.round(cw * pr); cv.height = Math.round(ch * pr);
      cv.style.width = `${cw}px`; cv.style.height = `${ch}px`;
      this._drawDamage();
    }
  },

  _bar(ratio, cls) { return `<span class="bc-bar ${cls || ''}"><i style="width:${Math.max(0, Math.min(100, ratio * 100)).toFixed(0)}%"></i></span>`; },
  _updateBridge() {
    const ship = State.ship;
    if (!ship) return;
    this._layoutBridge();
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    // --- 機関出力 ---
    const sp = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    const thr = Math.round((State.input.thrustForward ?? 0) * 100);
    const ratio = (kind) => (typeof HUD !== 'undefined' && HUD._computeThrustGroupRatio ? HUD._computeThrustGroupRatio(ship, kind) : 0);
    const main = ratio('main'), retro = ratio('retro');
    const ikn = typeof SHIP_IKN !== 'undefined' ? sp / SHIP_IKN : 0;
    const spText = ikn >= 0.01 ? `${ikn.toFixed(2)} IKn` : sp >= 1000 ? `${(sp / 1000).toFixed(2)} km/s` : `${sp.toFixed(1)} m/s`;
    const maxR = Number.isFinite(ship.maxSpeed) && ship.maxSpeed > 0 ? Math.min(1, sp / ship.maxSpeed) : 0;
    const W = typeof Weapons !== 'undefined' ? Weapons : null;
    const engEff = W && W._dmg ? W._eff('engine') : 1;
    let eng = `<div class="bc-row"><label>レバー</label>${this._bar(Math.abs(thr) / 100, thr < 0 ? 'warn' : '')}<b>${thr}%</b></div>`;
    eng += `<div class="bc-row"><label>主機</label>${this._bar(main)}<b>${Math.round(main * 100)}%</b></div>`;
    eng += `<div class="bc-row"><label>逆噴</label>${this._bar(retro, 'warn')}<b>${Math.round(retro * 100)}%</b></div>`;
    eng += `<div class="bc-row"><label>速度</label>${this._bar(maxR)}<b>${spText}</b></div>`;
    if (typeof Planetfall !== 'undefined' && Planetfall.active) {
      const a = Planetfall.active;
      eng += `<div class="bc-line">${esc(a.body.ja)} 高度 ${a.alt >= 1000 ? (a.alt / 1000).toFixed(1) + ' km' : Math.round(a.alt) + ' m'}・${esc(a.state)}</div>`;
    }
    if (engEff < 0.999) eng += `<div class="bc-line bad">機関本体 損傷（働き ${Math.floor(engEff * 100)}%）</div>`;
    this._eng.querySelector('.bb-body').innerHTML = eng;
    this._drawDamage();
  },

  // ---------------------------------------------------------
  // 損傷の側面図: 艦の左舷（または右舷）から見た形に、損傷のあるところを黄色 → 赤で重ねる（ひどいほど赤く大きく）
  // ---------------------------------------------------------
  // 艦の形（横から見た影）: 射線の判定の格子から作る（艦の座標: 前 = -Z、上 = +Y、右 = +X）
  _silhouette() {
    const W = typeof Weapons !== 'undefined' ? Weapons : null;
    const occ = W && W._occ;
    const ship = State.ship;
    if (!occ || !ship || !ship.mesh) return null;
    if (this._sil && this._sil.occ === occ) return this._sil;
    ship.mesh.updateMatrixWorld(true);
    const M = new THREE.Matrix4().copy(ship.mesh.matrixWorld).invert().multiply(occ.root.matrixWorld);
    const pts = [];
    const v = new THREE.Vector3();
    let zmin = Infinity, zmax = -Infinity, ymin = Infinity, ymax = -Infinity, xmax = 0;
    for (let l = 0; l < occ.nz; l++) for (let j = 0; j < occ.ny; j++) for (let i = 0; i < occ.nx; i++) {
      if (!occ.grid[(l * occ.ny + j) * occ.nx + i]) continue;
      v.set(occ.min.x + (i + 0.5) * occ.cell, occ.min.y + (j + 0.5) * occ.cell, occ.min.z + (l + 0.5) * occ.cell).applyMatrix4(M);
      pts.push(v.x, v.y, v.z);
      if (v.z < zmin) zmin = v.z; if (v.z > zmax) zmax = v.z;
      if (v.y < ymin) ymin = v.y; if (v.y > ymax) ymax = v.y;
      xmax = Math.max(xmax, Math.abs(v.x));
    }
    if (!pts.length) return null;
    // 横から見た影（200 × 高さに合わせた行数）
    const GW = 220, GH = Math.max(12, Math.round(GW * (ymax - ymin) / Math.max(1e-6, zmax - zmin)));
    const grid = new Uint8Array(GW * GH);
    for (let k = 0; k < pts.length; k += 3) {
      const gx = Math.min(GW - 1, Math.floor((pts[k + 2] - zmin) / (zmax - zmin) * GW));
      const gy = Math.min(GH - 1, Math.floor((ymax - pts[k + 1]) / (ymax - ymin) * GH));
      grid[gy * GW + gx] = 1;
    }
    this._sil = { occ, M, zmin, zmax, ymin, ymax, xmax, GW, GH, grid };
    return this._sil;
  },
  _drawDamage() {
    if (!this._dmgBox || this._dmgBox.style.display === 'none') return;
    const cv = this._dmgBox.querySelector('canvas');
    const g = cv.getContext('2d');
    const CW = cv.width, CH = cv.height;
    g.clearRect(0, 0, CW, CH);
    const S = this._silhouette();
    if (!S) { g.fillStyle = 'rgba(160,220,255,0.6)'; g.font = `${Math.round(CH * 0.22)}px sans-serif`; g.fillText('艦の形を読み込み中…', 6, CH * 0.6); return; }
    const port = this._dmgSide === 'port';
    // 図の中の位置: 左舷から見ると艦首（-Z）が左、右舷から見ると艦首が右
    const pad = 4;
    const scale = Math.min((CW - pad * 2) / (S.zmax - S.zmin), (CH - pad * 2) / (S.ymax - S.ymin));
    const ox = (CW - (S.zmax - S.zmin) * scale) / 2, oy = (CH - (S.ymax - S.ymin) * scale) / 2;
    const toX = (z) => ox + (port ? (z - S.zmin) : (S.zmax - z)) * scale;
    const toY = (y) => oy + (S.ymax - y) * scale;
    // 艦の影
    const cw = ((S.zmax - S.zmin) * scale) / S.GW, chh = ((S.ymax - S.ymin) * scale) / S.GH;
    g.fillStyle = 'rgba(70,160,230,0.42)';
    for (let gy = 0; gy < S.GH; gy++) for (let gx = 0; gx < S.GW; gx++) {
      if (!S.grid[gy * S.GW + gx]) continue;
      const x = port ? ox + gx * cw : ox + (S.GW - 1 - gx) * cw;
      g.fillRect(x, oy + gy * chh, cw + 0.6, chh + 0.6);
    }
    // 喫水線のような基準線（艦の中心の高さ）
    g.strokeStyle = 'rgba(120,210,255,0.35)'; g.lineWidth = 1; g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(ox, toY(0)); g.lineTo(CW - ox, toY(0)); g.stroke(); g.setLineDash([]);
    // 艦首の印
    g.fillStyle = 'rgba(160,230,255,0.8)'; g.font = `${Math.max(8, Math.round(CH * 0.15))}px sans-serif`;
    g.fillText('艦首', port ? 2 : CW - g.measureText('艦首').width - 2, Math.max(10, CH * 0.18));
    const W = typeof Weapons !== 'undefined' ? Weapons : null;
    const D = W && W._dmg;
    if (!D) return;
    const ship = State.ship;
    const inv = new THREE.Matrix4().copy(ship.mesh.matrixWorld).invert();
    const size = (typeof CameraSystem !== 'undefined' ? CameraSystem._shipScale || 1 : 1) * 8;
    const marks = [];
    // 見ている側（左舷なら -X）のものだけ。中心線の近くは両方に出す
    const sideOk = (x) => (port ? x <= S.xmax * 0.3 : x >= -S.xmax * 0.3);
    // 被弾の跡
    const P = W.practice;
    const ref = P ? P.shipHPMax * 0.012 : 100;
    for (const sp of D.spots) {
      const p = W._spotWorld(sp).applyMatrix4(inv);
      if (!sideOk(p.x)) continue;
      const sev = sp.hole ? 1 : Math.min(1, 0.25 + sp.dmg / ref * 0.75);
      marks.push({ p, sev, r: W._spotRadius(sp, size) * (sp.hole ? 1.3 : 0.9) });
    }
    // 区画・砲塔の損傷
    for (const pt of D.parts) {
      const e = pt.hp / pt.max;
      if (e >= 0.999 && !pt.dead) continue;
      const p = W._partWorld(pt).applyMatrix4(inv);
      if (!sideOk(p.x)) continue;
      marks.push({ p, sev: pt.dead ? 1 : Math.min(1, 1 - e), r: Math.max(pt.radius || 0, size * 0.02), part: pt });
    }
    marks.sort((a, b) => a.sev - b.sev); // ひどいものを上に
    for (const m of marks) {
      const x = toX(m.p.z), y = toY(m.p.y);
      const rr = Math.max(2.5, m.r * scale);
      // 黄色 → 赤
      const gcol = Math.round(220 * (1 - m.sev));
      const grad = g.createRadialGradient(x, y, 0, x, y, rr);
      grad.addColorStop(0, `rgba(255,${gcol},${Math.round(40 * (1 - m.sev))},${0.55 + 0.4 * m.sev})`);
      grad.addColorStop(1, `rgba(255,${gcol},0,0)`);
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
      if (m.part && m.part.dead) { g.strokeStyle = '#ff3020'; g.lineWidth = Math.max(1, CH * 0.02); g.beginPath(); g.moveTo(x - rr * 0.5, y - rr * 0.5); g.lineTo(x + rr * 0.5, y + rr * 0.5); g.moveTo(x + rr * 0.5, y - rr * 0.5); g.lineTo(x - rr * 0.5, y + rr * 0.5); g.stroke(); }
    }
  },
};
