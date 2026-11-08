// =============================================================
// 29-weapons.js
// v89: 武装（砲塔・砲身・射撃レーダー／測距儀）
//
// 船体モデル（GLB）の中の名前で、動かす部品を見つける:
//   - 「砲塔」を名前に含む部品 … 旋回する砲塔（その部品のY軸まわりに回る）
//   - 砲塔の中の「〜砲」で終わる部品（「1番砲」「2番砲」など）… 仰角を変える砲身
//     （Blender のボーンと同じく、部品のY軸が砲身の向き）
//   - 「射撃レーダー」「測距儀」「方位盤」「射撃指揮」を名前に含む部品 … 照準の方向へ旋回する
//   砲塔の名前（設定の見出し）は、砲塔の親の名前（「1番主砲」など）。
//   ボーン（スキン）で船体と一緒に変形するモデルでも、ふつうの部品でも動く。
//
// 艦の設計（21-ship-design.js）には design.weapons として、砲塔ごとの設定を名前で持つ:
//   mounts[砲塔の名前] = { kind: 'laser' | 'kinetic', type, caliber [mm], reload [s|null],
//     color（レーザーの色）, yawMin/yawMax（旋回範囲 [°]）, elevMin/elevMax（砲身の仰角 [°]）,
//     traverseRate/elevRate（旋回・俯仰の速さ [°/s|null]） }
//   directors[名前] = { yawMin, yawMax }
//
// ゲームでは（Weapons）:
//   - 「照準」で照準の視点に入り、画面をドラッグして狙う方向を決める。その方向を向けられる砲は
//     全部そちらへ旋回・俯仰する（範囲の外の砲は元の向きのまま）。射撃レーダーも同じ方向へ回る
//   - 照準の視点から戻っても、同じ方向（宇宙空間に対して）を狙い続ける
//   - 「照準やめ」で、砲・レーダーを元の向きに戻す
//   - 「撃て」で、狙いが合っていて装填の済んだ砲を撃つ（見た目だけ。当たり判定はまだ無い）
// =============================================================

const WEAPON_KINDS = { kinetic: '実弾砲', laser: 'レーザー砲' };
const WEAPON_TYPES = {
  kinetic: [
    { id: 'ap', label: '徹甲弾砲', speed: 1200, tracer: 0xffc070 },
    { id: 'he', label: '榴弾砲', speed: 900, tracer: 0xffa040 },
    { id: 'rail', label: 'レールガン', speed: 8000, tracer: 0x9fd8ff },
    { id: 'coil', label: 'コイルガン', speed: 4000, tracer: 0xc8f0ff },
  ],
  laser: [
    { id: 'pulse', label: 'パルスレーザー', beamTime: 0.25 },
    { id: 'cw', label: '連続波レーザー', beamTime: 1.5 },
    { id: 'xray', label: 'X線レーザー', beamTime: 0.12 },
  ],
};
// 口径の候補 [mm]（自由に入力もできる）
const WEAPON_CALIBERS = [20, 40, 76, 127, 152, 203, 305, 356, 381, 406, 460, 510, 800, 1000];
const WEAPON_LASER_COLORS = [
  { color: '#ff3a2a', label: '赤' }, { color: '#3aff6a', label: '緑' }, { color: '#3a8cff', label: '青' },
  { color: '#c050ff', label: '紫' }, { color: '#ffe23a', label: '黄' }, { color: '#ffffff', label: '白' },
];

function weaponTypeInfo(kind, type) {
  const list = WEAPON_TYPES[kind] || WEAPON_TYPES.kinetic;
  return list.find((t) => t.id === type) || list[0];
}
function weaponMountDefaults() {
  return {
    kind: 'kinetic', type: 'ap', caliber: 381, reload: null, color: '#ff3a2a',
    yawMin: -150, yawMax: 150, elevMin: -5, elevMax: 40, traverseRate: null, elevRate: null,
  };
}
// 装填時間の目安 [s]（空欄のとき）: 口径が大きいほど長い。レーザーは充電の時間
function weaponAutoReload(c) {
  const cal = Math.max(1, c.caliber || 0);
  if (c.kind === 'laser') return Math.round((1.5 + cal * 0.02) * 10) / 10;
  const k = c.type === 'rail' ? 1.5 : c.type === 'coil' ? 1.2 : 1;
  return Math.round((3 + cal * 0.065) * k * 10) / 10;
}
function weaponReload(c) { return c.reload > 0 ? c.reload : weaponAutoReload(c); }
// 旋回・俯仰の速さの目安 [°/s]（空欄のとき）: 大きい砲ほどゆっくり
function weaponAutoTraverseRate(c) { return Math.round(clamp(40 - (c.caliber || 0) * 0.06, 5, 45)); }
function weaponTraverseRate(c) { return c.traverseRate > 0 ? c.traverseRate : weaponAutoTraverseRate(c); }
function weaponElevRate(c) { return c.elevRate > 0 ? c.elevRate : Math.round(weaponTraverseRate(c) * 0.7); }

function normalizeWeaponMount(c) {
  const d = weaponMountDefaults();
  c = c || {};
  const num = (v, def) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);
  const kind = WEAPON_KINDS[c.kind] ? c.kind : d.kind;
  const out = {
    kind,
    type: weaponTypeInfo(kind, c.type).id,
    caliber: Math.max(1, num(c.caliber, d.caliber)),
    reload: Number(c.reload) > 0 ? Number(c.reload) : null,
    color: /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : d.color,
    yawMin: clamp(num(c.yawMin, d.yawMin), -180, 180),
    yawMax: clamp(num(c.yawMax, d.yawMax), -180, 180),
    elevMin: clamp(num(c.elevMin, d.elevMin), -90, 90),
    elevMax: clamp(num(c.elevMax, d.elevMax), -90, 90),
    traverseRate: Number(c.traverseRate) > 0 ? Number(c.traverseRate) : null,
    elevRate: Number(c.elevRate) > 0 ? Number(c.elevRate) : null,
  };
  if (out.yawMax < out.yawMin) [out.yawMin, out.yawMax] = [out.yawMax, out.yawMin];
  if (out.elevMax < out.elevMin) [out.elevMin, out.elevMax] = [out.elevMax, out.elevMin];
  return out;
}
function normalizeWeaponDirector(c) {
  c = c || {};
  const yawMin = clamp(Number.isFinite(Number(c.yawMin)) ? Number(c.yawMin) : -180, -180, 180);
  const yawMax = clamp(Number.isFinite(Number(c.yawMax)) ? Number(c.yawMax) : 180, -180, 180);
  return { yawMin: Math.min(yawMin, yawMax), yawMax: Math.max(yawMin, yawMax) };
}
function normalizeShipWeapons(w) {
  w = w || {};
  const mounts = {}, directors = {};
  for (const [k, v] of Object.entries(w.mounts || {})) mounts[k] = normalizeWeaponMount(v);
  for (const [k, v] of Object.entries(w.directors || {})) directors[k] = normalizeWeaponDirector(v);
  return { mounts, directors };
}

// -------------------------------------------------------------
// モデルの中の砲塔・砲身・射撃レーダーを見つけて、動かす仕組みを作る
// -------------------------------------------------------------
const WeaponRig = {
  // GLTFLoader は名前の「.」を消し、同じ名前には「_1」「_2」…を付ける（「1番主砲.001」→「1番主砲001」）
  baseName(n) { return String(n || '').replace(/(_\d+)+$/, ''); },
  label(n) { return this.baseName(n).replace(/(\D)\d{3}$/, '$1'); },
  isTurretName(n) { return /砲塔/.test(this.baseName(n)); },
  isBarrelName(n) { const b = this.label(n); return /砲$/.test(b) && !/砲塔/.test(b); },
  isDirectorName(n) { return /射撃レーダー|測距儀|方位盤|射撃指揮/.test(this.baseName(n)); },

  detect(root) {
    const mounts = [], directors = [];
    if (!root) return { mounts, directors };
    root.updateMatrixWorld(true);
    const turrets = [], dirCands = [];
    root.traverse((o) => {
      if (this.isTurretName(o.name)) turrets.push(o);
      else if (this.isDirectorName(o.name)) dirCands.push(o);
    });
    const usedKeys = {};
    const uniqueKey = (label) => {
      usedKeys[label] = (usedKeys[label] || 0) + 1;
      return usedKeys[label] > 1 ? `${label}#${usedKeys[label]}` : label;
    };
    for (const t of turrets) {
      // 砲塔の中の別の砲塔（入れ子）は、その砲塔の分として扱う
      if (turrets.some((o) => o !== t && this._isAncestor(o, t))) continue;
      const barrels = [];
      t.traverse((o) => {
        if (o === t) return;
        if (this.isBarrelName(o.name) && !turrets.some((x) => x !== t && this._isAncestor(x, o))) barrels.push(o);
      });
      if (!barrels.length) continue;
      let label = '';
      for (let p = t.parent; p && p !== root; p = p.parent) {
        if (p.name && !this.isTurretName(p.name)) { label = this.label(p.name); break; }
      }
      if (!label) label = `砲塔${mounts.length + 1}`;
      mounts.push(this._makeMount(uniqueKey(label), label, t, barrels));
    }
    mounts.sort((a, b) => this._labelOrder(a.label) - this._labelOrder(b.label) || a.key.localeCompare(b.key, 'ja'));
    // 射撃レーダー: 同じ名前の部品が複数あれば、ボーン（回す軸の位置を持つ）を選ぶ
    const byLabel = new Map();
    for (const o of dirCands) {
      const l = this.label(o.name);
      if (!byLabel.has(l)) byLabel.set(l, []);
      byLabel.get(l).push(o);
    }
    for (const [l, list] of byLabel) {
      const bones = list.filter((o) => o.isBone);
      const pick = bones.length ? bones : list.filter((o) => !list.some((x) => x !== o && this._isAncestor(o, x)));
      for (const o of pick) directors.push(this._makeDirector(uniqueKey(l), l, o));
    }
    return { mounts, directors };
  },
  _labelOrder(l) { const m = /^(\d+)/.exec(l); return m ? Number(m[1]) : 1e9; },
  _isAncestor(a, o) { for (let p = o.parent; p; p = p.parent) if (p === a) return true; return false; },

  _makeMount(key, label, turret, barrels) {
    const Y = new THREE.Vector3(0, 1, 0);
    const rest = turret.quaternion.clone();
    const U = Y.clone().applyQuaternion(rest); // 旋回の軸（砲塔の親の座標）
    const b = barrels.map((node) => {
      const bRest = node.quaternion.clone();
      const raw = Y.clone().applyQuaternion(bRest); // 砲身の向き（砲塔の座標）
      const h = new THREE.Vector3(raw.x, 0, raw.z);
      if (h.lengthSq() < 1e-8) h.set(1, 0, 0);
      h.normalize();
      const axis = new THREE.Vector3().crossVectors(h, Y).normalize(); // + で砲身が上がる
      const elev0 = Math.asin(clamp(raw.y, -1, 1)); // 元の向きの仰角
      return { node, rest: bRest, axis, fwd: h, elev0 };
    });
    const F = b[0].fwd.clone().applyQuaternion(rest); // 旋回角0の砲の向き（砲塔の親の座標、U に垂直）
    return { key, label, turret, barrels: b, rest, U, F, yaw: 0, elev: 0, kind: 'mount' };
  },
  _makeDirector(key, label, node) {
    const Y = new THREE.Vector3(0, 1, 0);
    const rest = node.quaternion.clone();
    let F = Y.clone().applyQuaternion(rest);
    // 旋回の軸は親の上（+Y）。向き（ボーンのY軸）がほぼ真上なら、親の -Z（艦首側）を向きとする
    const U = Y.clone();
    F.addScaledVector(U, -F.dot(U));
    if (F.lengthSq() < 1e-6) F = new THREE.Vector3(0, 0, -1);
    F.normalize();
    return { key, label, node, rest, U, F, yaw: 0, kind: 'director' };
  },

  setMountAngles(m, yaw, elev) {
    m.yaw = yaw; m.elev = elev;
    const q = new THREE.Quaternion().setFromAxisAngle(m.U, yaw);
    m.turret.quaternion.copy(q.multiply(m.rest));
    for (const b of m.barrels) {
      const qb = new THREE.Quaternion().setFromAxisAngle(b.axis, elev - b.elev0);
      b.node.quaternion.copy(qb.multiply(b.rest));
    }
  },
  setDirectorYaw(d, yaw) {
    d.yaw = yaw;
    const q = new THREE.Quaternion().setFromAxisAngle(d.U, yaw);
    d.node.quaternion.copy(q.multiply(d.rest));
  },
  // 世界の向き dirWorld を狙うときの旋回角・仰角 [rad]（部品の親の今の向きで計算）
  aimAngles(part, dirWorld) {
    const node = part.kind === 'mount' ? part.turret : part.node;
    const pq = new THREE.Quaternion();
    node.parent.getWorldQuaternion(pq);
    const d = dirWorld.clone().applyQuaternion(pq.invert());
    const up = d.dot(part.U);
    const h = d.clone().addScaledVector(part.U, -up);
    const yaw = Math.atan2(part.U.dot(new THREE.Vector3().crossVectors(part.F, h)), part.F.dot(h));
    const elev = Math.atan2(up, h.length());
    return { yaw, elev };
  },
  restoreAll(rig) {
    if (!rig) return;
    for (const m of rig.mounts) this.setMountAngles(m, 0, 0);
    for (const d of rig.directors) this.setDirectorYaw(d, 0);
  },
};

const toRadW = (d) => (d * Math.PI) / 180;
const toDegW = (r) => (r * 180) / Math.PI;

// -------------------------------------------------------------
// ゲーム（index.html）: 照準・旋回・射撃
// -------------------------------------------------------------
const Weapons = {
  rig: null,
  cfg: null,           // normalizeShipWeapons の結果
  aim: { active: false, dirU: null }, // 狙う向き（宇宙の座標。フレームが変わっても同じ向き）
  view: false,         // 照準の視点
  _scene: null,
  _effects: [],
  _ui: null,
  _drag: null,
  _viewPitch: 0.25,

  init(scene, canvas) {
    this._scene = scene;
    this._fx = new THREE.Group();
    this._fx.frustumCulled = false;
    scene.add(this._fx);
    this._buildUi();
    this._bindDrag(canvas);
  },

  // 艦の設計を反映したとき（モデルの読み込みの後）
  attach(modelRoot, design) {
    this.detach();
    const rig = WeaponRig.detect(modelRoot);
    if (!rig.mounts.length && !rig.directors.length) return;
    this.rig = rig;
    this.cfg = normalizeShipWeapons(design && design.weapons);
    for (const m of rig.mounts) {
      m.cfg = normalizeWeaponMount(this.cfg.mounts[m.key]);
      m.reloadLeft = m.barrels.map(() => 0);
    }
    for (const d of rig.directors) d.cfg = normalizeWeaponDirector(this.cfg.directors[d.key]);
    this._syncUi();
  },
  detach() {
    if (this.rig) WeaponRig.restoreAll(this.rig);
    this.rig = null;
    this.aim.active = false;
    this.setView(false);
    this._clearEffects();
    this._syncUi();
  },
  hasWeapons() { return !!(this.rig && this.rig.mounts.length); },

  // 宇宙の向き ⇔ 今のフレーム（ゲームの座標）の向き
  _toLocal(vU) {
    if (typeof Navigation === 'undefined' || !Navigation.frame) return vU;
    return Astro.mat3MulVec(Navigation.frame.rotT, vU);
  },
  _toUniverse(v) {
    if (typeof Navigation === 'undefined' || !Navigation.frame) return v;
    return Astro.mat3MulVec(Navigation.frame.rot, v);
  },
  aimDirLocal() {
    if (!this.aim.active || !this.aim.dirU) return null;
    return vecNormalize(this._toLocal(this.aim.dirU));
  },

  startAim(dirLocal) {
    this.aim.active = true;
    this.aim.dirU = this._toUniverse(vecNormalize(dirLocal));
    this._syncUi();
  },
  stopAim() {
    this.aim.active = false;
    this.setView(false);
    this._syncUi();
  },
  setView(on) {
    on = !!on && this.hasWeapons();
    if (on && !this.aim.active) {
      // 照準を始めるときは、今カメラが見ている向き（無ければ艦首）から
      const ship = State.ship;
      let dir = null;
      if (typeof camera !== 'undefined' && camera) {
        const v = new THREE.Vector3();
        camera.getWorldDirection(v);
        dir = { x: v.x, y: v.y, z: v.z };
      }
      if (!dir && ship) dir = rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion);
      this.startAim(dir || { x: 0, y: 0, z: -1 });
    }
    this.view = on;
    if (on && typeof CleanView !== 'undefined' && CleanView.on) CleanView.set(false);
    this._syncUi();
  },

  // ShipController.update の後、毎フレーム
  update(dt) {
    this._updateEffects(dt);
    const ship = State.ship;
    if (!this.rig || !ship || !ship.mesh) return;
    ship.mesh.updateMatrixWorld(true);
    const dl = this.aimDirLocal();
    const D = dl ? new THREE.Vector3(dl.x, dl.y, dl.z) : null;
    let ready = 0, aimed = 0;
    for (const m of this.rig.mounts) {
      const c = m.cfg;
      let ty = 0, te = 0;
      m.reachable = false;
      if (D) {
        const a = WeaponRig.aimAngles(m, D);
        if (a.yaw >= toRadW(c.yawMin) - 1e-6 && a.yaw <= toRadW(c.yawMax) + 1e-6
          && a.elev >= toRadW(c.elevMin) - 1e-6 && a.elev <= toRadW(c.elevMax) + 1e-6) {
          ty = a.yaw; te = a.elev; m.reachable = true;
        }
      }
      // 旋回範囲の中だけを通って動く（範囲の外を回り込まない）
      const full = c.yawMax - c.yawMin >= 359.9;
      let dy = ty - m.yaw;
      if (full) dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const ry = toRadW(weaponTraverseRate(c)) * dt, re = toRadW(weaponElevRate(c)) * dt;
      let yaw = m.yaw + clamp(dy, -ry, ry);
      if (full) yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      const elev = m.elev + clamp(te - m.elev, -re, re);
      if (yaw !== m.yaw || elev !== m.elev) WeaponRig.setMountAngles(m, yaw, elev);
      m.onTarget = m.reachable && Math.abs(Math.atan2(Math.sin(ty - yaw), Math.cos(ty - yaw))) < toRadW(0.5) && Math.abs(te - elev) < toRadW(0.5);
      for (let i = 0; i < m.reloadLeft.length; i++) m.reloadLeft[i] = Math.max(0, m.reloadLeft[i] - dt);
      if (m.onTarget) {
        aimed++;
        if (m.reloadLeft.some((r) => r <= 0)) ready++;
      }
    }
    for (const d of this.rig.directors) {
      const c = d.cfg;
      let ty = 0;
      if (D) {
        const a = WeaponRig.aimAngles(d, D);
        if (a.yaw >= toRadW(c.yawMin) - 1e-6 && a.yaw <= toRadW(c.yawMax) + 1e-6) ty = a.yaw;
        else ty = clamp(a.yaw, toRadW(c.yawMin), toRadW(c.yawMax));
      }
      const full = c.yawMax - c.yawMin >= 359.9;
      let dy = ty - d.yaw;
      if (full) dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const r = toRadW(30) * dt;
      if (Math.abs(dy) > 1e-7) WeaponRig.setDirectorYaw(d, d.yaw + clamp(dy, -r, r));
    }
    this._status = { aimed, ready, total: this.rig.mounts.length };
    this._updateUiState();
  },

  // 照準の視点のカメラ（照準の視点でなければ false を返し、ふだんのカメラに任せる）
  updateCamera(cam) {
    if (!this.view || !this.hasWeapons()) return false;
    const ship = State.ship;
    const dl = this.aimDirLocal();
    if (!ship || !dl) return false;
    const size = (CameraSystem._shipScale || 1) * 8;
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    // 狙う向きの後ろ上から、艦越しに狙う向きを見る
    const dist = size * 1.3;
    const p = ship.position;
    cam.position.set(p.x - dl.x * dist + up.x * dist * 0.35, p.y - dl.y * dist + up.y * dist * 0.35, p.z - dl.z * dist + up.z * dist * 0.35);
    cam.up.set(up.x, up.y, up.z);
    cam.lookAt(p.x + dl.x * dist * 4, p.y + dl.y * dist * 4, p.z + dl.z * dist * 4);
    // 照準の印（狙う向きの無限遠）
    const far = new THREE.Vector3(cam.position.x + dl.x * 1e4, cam.position.y + dl.y * 1e4, cam.position.z + dl.z * 1e4).project(cam);
    const el = this._ui && this._ui.reticle;
    if (el) {
      el.style.left = `${((far.x + 1) / 2) * window.innerWidth}px`;
      el.style.top = `${((1 - far.y) / 2) * window.innerHeight}px`;
    }
    return true;
  },

  // 照準の視点でのドラッグ: 狙う向きを回す（左右は艦の上を軸に、上下は横を軸に）
  _bindDrag(canvas) {
    const start = (x, y, id) => { if (this.view) this._drag = { x, y, id }; };
    const move = (x, y, id) => {
      const d = this._drag;
      if (!d || d.id !== id || !this.view) return;
      const dx = x - d.x, dy = y - d.y;
      d.x = x; d.y = y;
      this._rotateAim(-dx * 0.004, -dy * 0.004);
    };
    const end = (id) => { if (this._drag && this._drag.id === id) this._drag = null; };
    canvas.addEventListener('touchstart', (e) => { if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY, e.touches[0].identifier); else this._drag = null; }, { passive: true });
    canvas.addEventListener('touchmove', (e) => { for (const t of e.changedTouches) move(t.clientX, t.clientY, t.identifier); }, { passive: true });
    canvas.addEventListener('touchend', (e) => { for (const t of e.changedTouches) end(t.identifier); }, { passive: true });
    canvas.addEventListener('mousedown', (e) => start(e.clientX, e.clientY, 'mouse'));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY, 'mouse'));
    window.addEventListener('mouseup', () => end('mouse'));
  },
  _rotateAim(yaw, pitch) {
    const ship = State.ship;
    const dl = this.aimDirLocal();
    if (!ship || !dl) return;
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    const D = new THREE.Vector3(dl.x, dl.y, dl.z);
    const U = new THREE.Vector3(up.x, up.y, up.z);
    D.applyAxisAngle(U, yaw);
    const right = new THREE.Vector3().crossVectors(D, U);
    if (right.lengthSq() > 1e-8) {
      right.normalize();
      const nd = D.clone().applyAxisAngle(right, pitch);
      // 真上・真下を越えない
      if (Math.abs(nd.dot(U)) < 0.995) D.copy(nd);
    }
    this.aim.dirU = this._toUniverse({ x: D.x, y: D.y, z: D.z });
  },

  // 撃つ: 狙いが合っていて装填の済んだ砲身を全部
  fire() {
    if (!this.rig) return 0;
    const ship = State.ship;
    let n = 0;
    for (const m of this.rig.mounts) {
      if (!m.onTarget) continue;
      m.barrels.forEach((b, i) => {
        if (m.reloadLeft[i] > 0) return;
        m.reloadLeft[i] = weaponReload(m.cfg);
        this._spawnShot(ship, m, b);
        n++;
      });
    }
    return n;
  },

  _barrelMuzzle(m, b) {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion();
    b.node.getWorldPosition(pos);
    b.node.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    // 砲口: 砲身の付け根から「口径の45倍」先（模型の大きさが分からないので目安）
    const len = (m.cfg.caliber / 1000) * 45;
    return { pos: pos.addScaledVector(dir, len), dir };
  },
  // 弾・閃光の丸い点（四角い点にならないように）
  _dotTexture() {
    if (this._dotTex) return this._dotTex;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this._dotTex = new THREE.CanvasTexture(c);
    return this._dotTex;
  },
  _spawnShot(ship, m, b) {
    const { pos, dir } = this._barrelMuzzle(m, b);
    const rel = { x: pos.x - ship.position.x, y: pos.y - ship.position.y, z: pos.z - ship.position.z };
    const size = (CameraSystem._shipScale || 1) * 8;
    if (m.cfg.kind === 'laser') {
      const info = weaponTypeInfo('laser', m.cfg.type);
      const color = new THREE.Color(m.cfg.color);
      const len = Math.max(size * 60, 20000);
      const r = Math.max((m.cfg.caliber / 1000) * 1.5, size * 0.0015);
      const geo = new THREE.CylinderGeometry(r, r, len, 8, 1, true);
      geo.translate(0, len / 2, 0);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
      const beam = new THREE.Mesh(geo, mat);
      const core = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, len, 0)]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      const g = new THREE.Group();
      g.add(beam); g.add(core);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.frustumCulled = false; beam.frustumCulled = false; core.frustumCulled = false;
      this._fx.add(g);
      // レーザーは砲身に付いたまま（撃っている間、砲の向きに沿う）
      this._effects.push({ kind: 'beam', obj: g, mount: m, barrel: b, t: 0, life: info.beamTime, mats: [mat, core.material] });
    } else {
      const info = weaponTypeInfo('kinetic', m.cfg.type);
      const v = {
        x: ship.velocity.x + dir.x * info.speed, y: ship.velocity.y + dir.y * info.speed, z: ship.velocity.z + dir.z * info.speed,
      };
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({ color: info.tracer, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      const pmat = new THREE.PointsMaterial({ map: this._dotTexture(), color: info.tracer, size: clamp(m.cfg.caliber / 60, 3, 9), sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const pgeo = new THREE.BufferGeometry();
      pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const pt = new THREE.Points(pgeo, pmat);
      line.frustumCulled = false; pt.frustumCulled = false;
      this._fx.add(line); this._fx.add(pt);
      // 砲口の閃光
      const fmat = new THREE.PointsMaterial({ map: this._dotTexture(), color: 0xffe0a0, size: clamp(m.cfg.caliber / 25, 6, 28), sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([pos.x, pos.y, pos.z]), 3));
      const flash = new THREE.Points(fgeo, fmat);
      flash.frustumCulled = false;
      this._fx.add(flash);
      this._effects.push({ kind: 'flash', obj: flash, rel: { ...rel }, t: 0, life: 0.12, mats: [fmat] });
      // 弾は艦からの相対位置で持つ（艦の位置の付け替え〈原点の移動〉で弾が跳ばないように）
      this._effects.push({ kind: 'shell', line, pt, rel, v, t: 0, life: Math.min(20, Math.max(size * 80, 30000) / info.speed), mats: [mat, pmat] });
    }
  },
  _updateEffects(dt) {
    const ship = State.ship;
    if (!this._effects.length || !ship) return;
    if (typeof Navigation !== 'undefined' && Navigation.isWarping && Navigation.isWarping()) { this._clearEffects(); return; }
    const keep = [];
    for (const e of this._effects) {
      e.t += dt;
      const k = 1 - e.t / e.life;
      if (k <= 0) { this._disposeEffect(e); continue; }
      if (e.kind === 'beam') {
        const { pos, dir } = this._barrelMuzzle(e.mount, e.barrel);
        e.obj.position.copy(pos);
        e.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        e.mats[0].opacity = 0.9 * Math.min(1, k * 3);
        e.mats[1].opacity = Math.min(1, k * 3);
      } else if (e.kind === 'flash') {
        const a = e.obj.geometry.attributes.position;
        a.setXYZ(0, ship.position.x + e.rel.x, ship.position.y + e.rel.y, ship.position.z + e.rel.z);
        a.needsUpdate = true;
        e.mats[0].opacity = k;
      } else {
        e.rel.x += (e.v.x - ship.velocity.x) * dt;
        e.rel.y += (e.v.y - ship.velocity.y) * dt;
        e.rel.z += (e.v.z - ship.velocity.z) * dt;
        const p = { x: ship.position.x + e.rel.x, y: ship.position.y + e.rel.y, z: ship.position.z + e.rel.z };
        const sp = Math.hypot(e.v.x - ship.velocity.x, e.v.y - ship.velocity.y, e.v.z - ship.velocity.z) || 1;
        const tail = Math.min(sp * 0.08, (CameraSystem._shipScale || 1) * 8 * 0.6);
        const a = e.line.geometry.attributes.position;
        a.setXYZ(0, p.x, p.y, p.z);
        a.setXYZ(1, p.x - ((e.v.x - ship.velocity.x) / sp) * tail, p.y - ((e.v.y - ship.velocity.y) / sp) * tail, p.z - ((e.v.z - ship.velocity.z) / sp) * tail);
        a.needsUpdate = true;
        const pa = e.pt.geometry.attributes.position;
        pa.setXYZ(0, p.x, p.y, p.z);
        pa.needsUpdate = true;
        e.mats[0].opacity = Math.min(1, k * 4);
        e.mats[1].opacity = Math.min(1, k * 4);
      }
      keep.push(e);
    }
    this._effects = keep;
  },
  _disposeEffect(e) {
    const objs = e.kind === 'shell' ? [e.line, e.pt] : [e.obj];
    for (const o of objs) {
      this._fx.remove(o);
      o.traverse((c) => { if (c.geometry) c.geometry.dispose(); });
    }
    for (const m of e.mats) m.dispose();
  },
  _clearEffects() {
    for (const e of this._effects) this._disposeEffect(e);
    this._effects = [];
  },

  // ---------------------------------------------------------
  // 画面のボタン（照準・撃て・照準やめ）と照準の印
  // ---------------------------------------------------------
  _buildUi() {
    const box = document.createElement('div');
    box.className = 'weapon-controls';
    box.innerHTML = `
      <div class="wpn-status"></div>
      <button type="button" class="wpn-btn wpn-fire">撃て</button>
      <button type="button" class="wpn-btn wpn-view">照準</button>
      <button type="button" class="wpn-btn wpn-stop">照準やめ</button>`;
    document.body.appendChild(box);
    const reticle = document.createElement('div');
    reticle.className = 'wpn-reticle';
    document.body.appendChild(reticle);
    const hint = document.createElement('div');
    hint.className = 'wpn-hint';
    hint.textContent = '照準: 画面をドラッグして狙う方向を決めます（「照準」をもう一度押すと元の視点へ。狙いは続けます）';
    document.body.appendChild(hint);
    const stop = (e) => { e.stopPropagation(); };
    box.addEventListener('touchstart', stop, { passive: true });
    box.querySelector('.wpn-view').addEventListener('click', () => this.setView(!this.view));
    box.querySelector('.wpn-stop').addEventListener('click', () => this.stopAim());
    box.querySelector('.wpn-fire').addEventListener('click', () => {
      const n = this.fire();
      if (!n) this._flashStatus(this.aim.active ? '撃てる砲がありません（旋回中・装填中・範囲外）' : '先に「照準」で狙ってください');
    });
    this._ui = { box, reticle, hint, status: box.querySelector('.wpn-status'), view: box.querySelector('.wpn-view'), stop: box.querySelector('.wpn-stop'), fire: box.querySelector('.wpn-fire') };
    this._syncUi();
  },
  _flashStatus(text) {
    this._statusOverride = { text, until: performance.now() + 1800 };
  },
  _syncUi() {
    const u = this._ui;
    if (!u) return;
    const has = this.hasWeapons();
    u.box.style.display = has ? '' : 'none';
    u.view.classList.toggle('active', this.view);
    u.stop.style.display = this.aim.active ? '' : 'none';
    u.fire.style.display = this.aim.active ? '' : 'none';
    u.reticle.style.display = has && this.view ? '' : 'none';
    u.hint.style.display = has && this.view ? '' : 'none';
    document.body.classList.toggle('weapon-aim-view', has && this.view);
    this._updateUiState();
  },
  _updateUiState() {
    const u = this._ui;
    if (!u || !this.rig) return;
    const s = this._status || { aimed: 0, ready: 0, total: this.rig.mounts.length };
    let text = this.aim.active ? `指向 ${s.aimed}/${s.total}基・発射可 ${s.ready}基` : `砲塔 ${s.total}基`;
    if (this._statusOverride && performance.now() < this._statusOverride.until) text = this._statusOverride.text;
    if (u.status.textContent !== text) u.status.textContent = text;
    u.fire.disabled = !(s.ready > 0);
  },
};

// -------------------------------------------------------------
// 艦船建造画面（ship-builder.html）: 砲塔ごとの武装・旋回範囲・仰角、射撃レーダーの旋回範囲
//   opts: { getDesign, getModelRoot, onChange }
// -------------------------------------------------------------
const WeaponDesigner = {
  _opts: null,
  _rig: { mounts: [], directors: [] },
  _rigRoot: null,
  _sel: null, // { kind: 'mount' | 'director', key }

  init(opts) {
    this._opts = opts;
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    // 選択肢
    const kindSel = $('wpnKind');
    for (const [k, l] of Object.entries(WEAPON_KINDS)) kindSel.appendChild(new Option(l, k));
    const dl = $('wpnCalList');
    for (const c of WEAPON_CALIBERS) { const o = document.createElement('option'); o.value = String(c); dl.appendChild(o); }
    const colors = $('wpnColorPresets');
    for (const c of WEAPON_LASER_COLORS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'wpn-swatch'; b.title = c.label; b.style.background = c.color;
      b.addEventListener('click', () => this._edit((m) => { m.color = c.color; }));
      colors.appendChild(b);
    }
    const bindNum = (id, field, nullable) => $(id).addEventListener('change', () => {
      const el = $(id);
      this._edit((m) => { m[field] = el.value === '' ? (nullable ? null : m[field]) : Number(el.value); });
    });
    $('wpnKind').addEventListener('change', () => this._edit((m) => { m.kind = $('wpnKind').value; m.type = WEAPON_TYPES[m.kind][0].id; }));
    $('wpnType').addEventListener('change', () => this._edit((m) => { m.type = $('wpnType').value; }));
    bindNum('wpnCaliber', 'caliber', false);
    bindNum('wpnReload', 'reload', true);
    bindNum('wpnYawMin', 'yawMin', false);
    bindNum('wpnYawMax', 'yawMax', false);
    bindNum('wpnElevMin', 'elevMin', false);
    bindNum('wpnElevMax', 'elevMax', false);
    bindNum('wpnTraverse', 'traverseRate', true);
    $('wpnColor').addEventListener('input', () => this._edit((m) => { m.color = $('wpnColor').value; }));
    $('wpnApplyAllBtn').addEventListener('click', () => {
      const cur = this._currentMountCfg();
      if (!cur) return;
      const d = this._opts.getDesign();
      for (const m of this._rig.mounts) {
        const c = normalizeWeaponMount(d.weapons.mounts[m.key]);
        Object.assign(c, { kind: cur.kind, type: cur.type, caliber: cur.caliber, reload: cur.reload, color: cur.color, traverseRate: cur.traverseRate, elevRate: cur.elevRate });
        d.weapons.mounts[m.key] = c;
      }
      this._opts.onChange();
      this.refresh();
    });
    $('dirYawMin').addEventListener('change', () => this._editDir((c) => { c.yawMin = Number($('dirYawMin').value); }));
    $('dirYawMax').addEventListener('change', () => this._editDir((c) => { c.yawMax = Number($('dirYawMax').value); }));
    // 動きの確認（保存しない）: 選んだ砲塔を、旋回範囲・仰角の中で回してみる
    $('wpnTestYaw').addEventListener('input', () => this._applyTest());
    $('wpnTestElev').addEventListener('input', () => this._applyTest());
    $('dirTestYaw').addEventListener('input', () => this._applyTest());
  },

  _ensureRig() {
    const root = this._opts.getModelRoot();
    if (root !== this._rigRoot) {
      if (this._rig) WeaponRig.restoreAll(this._rig);
      this._rigRoot = root;
      this._rig = root ? WeaponRig.detect(root) : { mounts: [], directors: [] };
      if (this._sel && !this._findSel()) this._sel = null;
    }
    return this._rig;
  },
  _findSel() {
    if (!this._sel || !this._rig) return null;
    const list = this._sel.kind === 'mount' ? this._rig.mounts : this._rig.directors;
    return list.find((x) => x.key === this._sel.key) || null;
  },
  _currentMountCfg() {
    const part = this._findSel();
    if (!part || part.kind !== 'mount') return null;
    return normalizeWeaponMount(this._opts.getDesign().weapons.mounts[part.key]);
  },
  _edit(fn) {
    const part = this._findSel();
    if (!part || part.kind !== 'mount') return;
    const d = this._opts.getDesign();
    const c = normalizeWeaponMount(d.weapons.mounts[part.key]);
    fn(c);
    d.weapons.mounts[part.key] = normalizeWeaponMount(c);
    this._opts.onChange();
    this.refresh();
  },
  _editDir(fn) {
    const part = this._findSel();
    if (!part || part.kind !== 'director') return;
    const d = this._opts.getDesign();
    const c = normalizeWeaponDirector(d.weapons.directors[part.key]);
    fn(c);
    d.weapons.directors[part.key] = normalizeWeaponDirector(c);
    this._opts.onChange();
    this.refresh();
  },
  _applyTest() {
    const $ = this.$;
    const part = this._findSel();
    if (!part) return;
    if (part.kind === 'mount') WeaponRig.setMountAngles(part, toRadW(Number($('wpnTestYaw').value)), toRadW(Number($('wpnTestElev').value)));
    else WeaponRig.setDirectorYaw(part, toRadW(Number($('dirTestYaw').value)));
    $('wpnTestYawVal').textContent = `${$('wpnTestYaw').value}°`;
    $('wpnTestElevVal').textContent = `${$('wpnTestElev').value}°`;
    $('dirTestYawVal').textContent = `${$('dirTestYaw').value}°`;
  },
  _select(kind, key) {
    if (this._rig) WeaponRig.restoreAll(this._rig);
    this._sel = { kind, key };
    this.$('wpnTestYaw').value = '0'; this.$('wpnTestElev').value = '0'; this.$('dirTestYaw').value = '0';
    this.refresh();
    this._applyTest();
  },

  refresh() {
    const $ = this.$;
    const design = this._opts.getDesign();
    if (!design || !$) return;
    design.weapons = normalizeShipWeapons(design.weapons);
    const rig = this._ensureRig();
    const has = rig.mounts.length + rig.directors.length > 0;
    $('wpnFound').textContent = !this._rigRoot
      ? 'モデルを読み込むと、モデルの中の砲塔・射撃レーダーを見つけて設定できます。'
      : has ? `砲塔 ${rig.mounts.length}基（砲身 ${rig.mounts.reduce((s, m) => s + m.barrels.length, 0)}門）・射撃レーダー／測距儀 ${rig.directors.length}基` : 'モデルの中に砲塔（名前に「砲塔」を含む部品）が見つかりません。';
    const list = $('wpnList');
    list.innerHTML = '';
    if (!this._sel && rig.mounts.length) this._sel = { kind: 'mount', key: rig.mounts[0].key };
    for (const m of rig.mounts) {
      const c = normalizeWeaponMount(design.weapons.mounts[m.key]);
      const b = document.createElement('button');
      b.type = 'button';
      const on = this._sel && this._sel.kind === 'mount' && this._sel.key === m.key;
      b.className = `pod-chip wpn-chip${on ? ' selected' : ''}`;
      b.textContent = `${m.key}・${weaponTypeInfo(c.kind, c.type).label} ${c.caliber}mm×${m.barrels.length}`;
      if (c.kind === 'laser') b.style.borderColor = c.color;
      b.addEventListener('click', () => this._select('mount', m.key));
      list.appendChild(b);
    }
    for (const d of rig.directors) {
      const b = document.createElement('button');
      b.type = 'button';
      const on = this._sel && this._sel.kind === 'director' && this._sel.key === d.key;
      b.className = `pod-chip dir-chip${on ? ' selected' : ''}`;
      b.textContent = d.key;
      b.addEventListener('click', () => this._select('director', d.key));
      list.appendChild(b);
    }
    const part = this._findSel();
    $('wpnEditor').style.display = part && part.kind === 'mount' ? '' : 'none';
    $('dirEditor').style.display = part && part.kind === 'director' ? '' : 'none';
    if (!part) return;
    const active = document.activeElement;
    const setVal = (id, v) => { if (active !== $(id)) $(id).value = v; };
    if (part.kind === 'mount') {
      const c = normalizeWeaponMount(design.weapons.mounts[part.key]);
      $('wpnEditorTitle').textContent = `${part.key}（砲身 ${part.barrels.length}門）`;
      $('wpnKind').value = c.kind;
      const ts = $('wpnType');
      ts.innerHTML = '';
      for (const t of WEAPON_TYPES[c.kind]) ts.appendChild(new Option(t.label, t.id));
      ts.value = c.type;
      setVal('wpnCaliber', String(c.caliber));
      setVal('wpnReload', c.reload > 0 ? String(c.reload) : '');
      $('wpnReload').placeholder = `自動（${weaponAutoReload(c)}）`;
      $('wpnColorRow').style.display = c.kind === 'laser' ? '' : 'none';
      $('wpnColorPresets').style.display = c.kind === 'laser' ? '' : 'none';
      setVal('wpnColor', c.color);
      setVal('wpnYawMin', String(c.yawMin));
      setVal('wpnYawMax', String(c.yawMax));
      setVal('wpnElevMin', String(c.elevMin));
      setVal('wpnElevMax', String(c.elevMax));
      setVal('wpnTraverse', c.traverseRate > 0 ? String(c.traverseRate) : '');
      $('wpnTraverse').placeholder = `自動（${weaponAutoTraverseRate(c)}）`;
      $('wpnTestYaw').min = String(c.yawMin); $('wpnTestYaw').max = String(c.yawMax);
      $('wpnTestElev').min = String(c.elevMin); $('wpnTestElev').max = String(c.elevMax);
      const info = weaponTypeInfo(c.kind, c.type);
      $('wpnLine').textContent = c.kind === 'laser'
        ? `${info.label}・口径 ${c.caliber}mm・充電 ${weaponReload(c)}秒・照射 ${info.beamTime}秒`
        : `${info.label}・口径 ${c.caliber}mm・装填 ${weaponReload(c)}秒・初速 ${info.speed.toLocaleString('ja-JP')} m/s・旋回 ${weaponTraverseRate(c)}°/s・俯仰 ${weaponElevRate(c)}°/s`;
    } else {
      const c = normalizeWeaponDirector(design.weapons.directors[part.key]);
      $('dirEditorTitle').textContent = part.key;
      setVal('dirYawMin', String(c.yawMin));
      setVal('dirYawMax', String(c.yawMax));
      $('dirTestYaw').min = String(c.yawMin); $('dirTestYaw').max = String(c.yawMax);
    }
  },
};
