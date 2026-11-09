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

// v89: 演習モード（index.html?mode=practice）: 通常のプレイとは別のモード。世界は同じで、自動航行・ワープ・星図が無い
const PRACTICE_MODE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mode') === 'practice';
if (PRACTICE_MODE && typeof document !== 'undefined') {
  const mark = () => { if (!document.body) return; document.body.classList.add('mode-practice'); const b = document.createElement('div'); b.className = 'practice-badge'; b.textContent = '🎯 演習モード'; b.title = '敵と撃ち合うモード。砲を設定した船で「演習開始」を押すと敵が出る（星図・自動航行はなし）'; document.body.appendChild(b); };
  if (document.body) mark(); else document.addEventListener('DOMContentLoaded', mark);
}
// v89: 演習の敵の艦種・機種。L/W/H: 大きさ [m]、hp: 耐久、guns: 1回に撃つ門数、cal: 口径 [mm]、types: 砲の種類、
//   reload [s]、range [m]、ikn: 最高速度 [IKn]、rel: 自艦に対して近づく・回る速さ [m/s]、tau: 速さを合わせる時間 [s]、standoff: 近づく距離 [m]
const ENEMY_CLASSES = {
  bb: { label: '戦艦', L: 230, W: 34, H: 30, color: 0xc0392b, hp: 900, guns: 6, cal: [356, 460], types: ['ap', 'he'], reload: [22, 30], range: 40000, ikn: [15, 18], rel: 250, tau: 3, standoff: [15000, 25000] },
  ca: { label: '重巡洋艦', L: 190, W: 22, H: 20, color: 0xe67e22, hp: 450, guns: 4, cal: [203, 254], types: ['ap', 'he', 'rail'], reload: [12, 16], range: 30000, ikn: [18, 22], rel: 350, tau: 2.5, standoff: [10000, 18000] },
  cl: { label: '軽巡洋艦', L: 160, W: 17, H: 16, color: 0xf1c40f, hp: 260, guns: 4, cal: [140, 155], types: ['he', 'coil', 'pulse'], reload: [7, 10], range: 25000, ikn: [20, 25], rel: 450, tau: 2, standoff: [7000, 13000] },
  dd: { label: '駆逐艦', L: 115, W: 11, H: 10, color: 0x1abc9c, hp: 140, guns: 2, cal: [100, 130], types: ['he', 'coil', 'pulse'], reload: [4, 6], range: 16000, ikn: [24, 30], rel: 600, tau: 1.5, standoff: [4000, 8000] },
  ac: { label: '対艦攻撃機', L: 18, W: 14, H: 4, color: 0xd35eff, hp: 30, guns: 1, cal: [75, 120], types: ['rail', 'xray'], reload: [3, 5], range: 6000, ikn: [45, 60], rel: 2500, tau: 0.4, standoff: [1000, 3000] },
};
// 難易度: 艦種の出やすさ（重み）、敵の火力の倍率、目標の数
const PRACTICE_DIFFICULTIES = {
  easy: { label: 'やさしい', weights: { bb: 0, ca: 1, cl: 3, dd: 5, ac: 3 }, dmg: 0.6, count: 30 },
  normal: { label: 'ふつう', weights: { bb: 1, ca: 2, cl: 3, dd: 4, ac: 3 }, dmg: 1.0, count: 45 },
  hard: { label: 'むずかしい', weights: { bb: 3, ca: 4, cl: 3, dd: 3, ac: 4 }, dmg: 1.5, count: 45 },
  extreme: { label: '激戦', weights: { bb: 6, ca: 5, cl: 3, dd: 2, ac: 5 }, dmg: 2.2, count: 60 },
};

// v89: 砲の状態の色（画面の番号・照準マーク・装填の棒・小さな図の線）
const WEAPON_STATE_COLORS = {
  ready: 0x3dff6e,   // 撃てる
  moving: 0xffd84a,  // 旋回中
  reload: 0xff4a3a,  // 装填中
  blocked: 0xf2f4f6, // 指向できたが射線が船体・ほかの砲に当たる（白）
  near: 0x8a9099,    // 指向不可だが近くまで寄せている（グレー）
  none: 0x24272c,    // 指向不可（ほぼ黒）
  indep: 0xff9a2e,   // 独立して別の目標を撃っている（橙）
};
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
// v89: 射程の単位（設定画面で選ぶ）
const WEAPON_RANGE_UNITS = {
  km: { label: 'km', m: 1e3 },
  au: { label: '天文単位', m: 1.495978707e11 },
  ld: { label: '光日', m: 299792458 * 86400 },
};
// 射程の目安 [m]: 実弾は初速 × 30 秒、レーザーは 2,000 km
function weaponAutoRange(c) {
  if (c.kind === 'laser') return 2e6;
  return weaponTypeInfo('kinetic', c.type).speed * 30;
}
function weaponRange(c) { return c.range > 0 ? c.range : weaponAutoRange(c); }
// v89: ダメージ（演習）: 口径が大きいほど大きい（口径^1.6）。弾・レーザーの種類で少し変わる。レーザーは充電の割合を掛ける
const WEAPON_DAMAGE_TYPE = { ap: 1.0, he: 1.2, rail: 1.5, coil: 1.1, pulse: 0.8, cw: 1.0, xray: 1.2 };
function weaponDamage(type, caliber, power) {
  return 10 * Math.pow(Math.max(1, caliber) / 100, 1.6) * (WEAPON_DAMAGE_TYPE[type] || 1) * (power === undefined ? 1 : power);
}
// 弾が当たる向き（相手が動く分を先取り）。R: 撃つ側→相手、Vr: 相手の撃つ側に対する速度、s: 弾の速さ。当たるまでの時間も返す
function weaponLeadSolve(R, Vr, s) {
  const a = Vr.dot(Vr) - s * s, b = 2 * R.dot(Vr), c = R.dot(R);
  let tt;
  if (Math.abs(a) < 1e-9) tt = -c / b;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
    tt = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
  }
  if (!(tt > 0) || !Number.isFinite(tt)) return null;
  const p = R.clone().addScaledVector(Vr, tt);
  return { dir: p.clone().normalize(), dist: p.length(), time: tt };
}
function formatWeaponRange(m, unit) {
  const u = WEAPON_RANGE_UNITS[unit] || WEAPON_RANGE_UNITS.km;
  const v = m / u.m;
  const t = v >= 100 ? Math.round(v).toLocaleString('ja-JP') : v >= 1 ? v.toFixed(1) : v.toPrecision(2);
  return `${t} ${u.label}`;
}
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
    group: typeof c.group === 'string' && c.group ? c.group : null, // v89: グループの id
    // v89: 射程 [m]（null なら砲の種類から目安）と、表示の単位
    range: Number(c.range) > 0 ? Number(c.range) : null,
    rangeUnit: WEAPON_RANGE_UNITS[c.rangeUnit] ? c.rangeUnit : 'km',
  };
  if (out.yawMax < out.yawMin) [out.yawMin, out.yawMax] = [out.yawMax, out.yawMin];
  if (out.elevMax < out.elevMin) [out.elevMin, out.elevMax] = [out.elevMax, out.elevMin];
  return out;
}
// v89: 砲塔の名前に口径があれば（「14cm第1副砲」「120mm高角砲」など）、設定の無い砲塔の口径の初期値にする
function weaponCaliberFromName(name) {
  const m = /(\d+(?:\.\d+)?)\s*(cm|mm|センチ|ミリ)/i.exec(String(name || ''));
  if (!m) return null;
  const v = Number(m[1]) * (/cm|センチ/i.test(m[2]) ? 10 : 1);
  return v > 0 ? v : null;
}
// 砲塔 key の設定（無ければ名前から口径を推し量った初期値）
function weaponMountConfigFor(weapons, key) {
  const c = weapons && weapons.mounts ? weapons.mounts[key] : null;
  if (c) return normalizeWeaponMount(c);
  const cal = weaponCaliberFromName(key);
  return normalizeWeaponMount(cal ? { caliber: cal } : null);
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
  // v89: 砲塔のグループ（主砲・副砲など。名前は自由）。autoFire はゲーム開始時の自動射撃
  const groups = (Array.isArray(w.groups) ? w.groups : []).filter((g) => g && g.id).map((g) => ({
    id: String(g.id), name: String(g.name || 'グループ').slice(0, 20), autoFire: !!g.autoFire,
    // v89: 自動射撃の出力（レーザー。充電がこの割合になったら撃つ）[%]
    autoPower: Number(g.autoPower) >= 1 ? Math.min(100, Math.round(Number(g.autoPower))) : 50,
    // v89: 親のグループ（グループの中のグループ。null なら最上位）
    parent: typeof g.parent === 'string' && g.parent && g.parent !== String(g.id) ? g.parent : null,
  }));
  return { mounts, directors, groups };
}

// v89: グループの入れ子。最上位のグループ（親をたどった先。輪になっていても止まる）
function weaponTopGroupId(weapons, id) {
  const byId = new Map((weapons.groups || []).map((g) => [g.id, g]));
  let g = byId.get(id);
  for (let i = 0; g && g.parent && byId.has(g.parent) && i < 16; i++) g = byId.get(g.parent);
  return g ? g.id : id;
}
// id とその中のグループ全部の id
function weaponGroupAndDescendants(weapons, id) {
  const out = new Set([id]);
  for (let changed = true, n = 0; changed && n < 16; n++) {
    changed = false;
    for (const g of weapons.groups || []) if (g.parent && out.has(g.parent) && !out.has(g.id)) { out.add(g.id); changed = true; }
  }
  return out;
}
// 表示用の名前（「主砲 › 前部」）
function weaponGroupPath(weapons, id) {
  const byId = new Map((weapons.groups || []).map((g) => [g.id, g]));
  const names = [];
  let g = byId.get(id);
  for (let i = 0; g && i < 16; i++) { names.unshift(g.name); g = g.parent ? byId.get(g.parent) : null; }
  return names.join(' › ');
}

// v89: 名前から最初のグループ分け（「1番主砲」→主砲、「14cm第1副砲」→副砲）
function weaponAutoGroupName(label) {
  const m = /(主砲|副砲|高角砲|両用砲|機銃|機関砲|ミサイル|魚雷|レーザー砲)/.exec(String(label || ''));
  return m ? m[1] : 'その他';
}
// 全部の砲塔をどれかのグループに入れる（入っていなければ、名前から決めたグループへ。無ければ作る）。weapons を書き換える
function ensureWeaponGroups(weapons, mountKeys) {
  if (!Array.isArray(weapons.groups)) weapons.groups = [];
  const ids = new Set(weapons.groups.map((g) => g.id));
  let n = weapons.groups.reduce((mx, g) => Math.max(mx, Number(/^g(\d+)$/.exec(g.id)?.[1] || 0)), 0);
  for (const key of mountKeys) {
    const c = weaponMountConfigFor(weapons, key);
    if (c.group && ids.has(c.group)) continue;
    const name = weaponAutoGroupName(key);
    let g = weapons.groups.find((x) => x.name === name);
    if (!g) { g = { id: `g${++n}`, name, autoFire: false }; weapons.groups.push(g); ids.add(g.id); }
    c.group = g.id;
    weapons.mounts[key] = c;
  }
  return weapons.groups;
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
        if (!o.isMesh && this.isBarrelName(o.name) && !turrets.some((x) => x !== t && this._isAncestor(x, o))) barrels.push(o);
      });
      // 砲身が砲塔の子ではなく、同じ親の下（兄弟）にあるモデルもある（副砲など）
      if (!barrels.length && t.parent) {
        for (const o of t.parent.children) {
          if (o !== t && !o.isMesh && this.isBarrelName(o.name)) barrels.push(o); // 砲塔の部品のメッシュ（「〜副砲.001」など）は砲身ではない
        }
      }
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
    const restInv = rest.clone().invert();
    const b = barrels.map((node) => {
      // 兄弟の砲身は、砲塔に対する向き・位置で持ち、砲塔の旋回を自分でかける
      const sibling = node.parent !== turret;
      const bRest = sibling ? restInv.clone().multiply(node.quaternion) : node.quaternion.clone();
      const relPos = sibling ? node.position.clone().sub(turret.position).applyQuaternion(restInv) : null;
      const raw = Y.clone().applyQuaternion(bRest); // 砲身の向き（砲塔の座標）
      const h = new THREE.Vector3(raw.x, 0, raw.z);
      if (h.lengthSq() < 1e-8) h.set(1, 0, 0);
      h.normalize();
      const axis = new THREE.Vector3().crossVectors(h, Y).normalize(); // + で砲身が上がる
      const elev0 = Math.asin(clamp(raw.y, -1, 1)); // 元の向きの仰角
      const nm = /^(\d+)/.exec(this.label(node.name));
      return { node, rest: bRest, axis, fwd: h, elev0, num: nm ? Number(nm[1]) : 99, sibling, relPos };
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
    const qT = q.multiply(m.rest);
    m.turret.quaternion.copy(qT);
    for (const b of m.barrels) {
      const qb = new THREE.Quaternion().setFromAxisAngle(b.axis, elev - b.elev0);
      qb.multiply(b.rest);
      if (b.sibling) {
        b.node.quaternion.copy(qT).multiply(qb);
        b.node.position.copy(b.relPos).applyQuaternion(qT).add(m.turret.position);
      } else {
        b.node.quaternion.copy(qb);
      }
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
  // v89: 射線の判定用に、船体を細かい格子（モデルの座標）にする。砲身は回るので入れない。
  //   cell: 0 = 空, 1 = 船体（射撃レーダーなども）, 2 + k = k 番目の砲塔（自分の砲塔には当たらないように区別する）
  //   ボーンが元の向きのとき（読み込んだ直後）に作る
  buildOcclusion(root, rig, res) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const box = new THREE.Box3();
    const meshes = [];
    root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
    const M = new THREE.Matrix4(), v = new THREE.Vector3();
    for (const o of meshes) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (o.isSkinnedMesh && o.skeleton) {
        // スキンは、ボーンごとの行列で置いた範囲を合わせる（メッシュ自身の位置は使われない）
        o.skeleton.bones.forEach((bone, bi) => {
          const BM = new THREE.Matrix4().multiplyMatrices(inv, bone.matrixWorld).multiply(o.skeleton.boneInverses[bi]).multiply(o.bindMatrix);
          box.union(o.geometry.boundingBox.clone().applyMatrix4(BM));
        });
      } else {
        M.multiplyMatrices(inv, o.matrixWorld);
        box.union(o.geometry.boundingBox.clone().applyMatrix4(M));
      }
    }
    if (box.isEmpty()) return null;
    const sz = box.getSize(new THREE.Vector3());
    const cell = Math.max(sz.x, sz.y, sz.z) / (res || 160);
    const min = box.min.clone().addScalar(-cell);
    const nx = Math.ceil(sz.x / cell) + 3, ny = Math.ceil(sz.y / cell) + 3, nz = Math.ceil(sz.z / cell) + 3;
    const grid = new Uint16Array(nx * ny * nz);
    const boneOwner = new Map(); // ボーン → 砲塔の番号（-1 = 砲身。格子に入れない）
    rig.mounts.forEach((m, k) => {
      boneOwner.set(m.turret, k);
      for (const b of m.barrels) boneOwner.set(b.node, -1);
    });
    const mark = (x, y, z, val) => {
      const i = Math.floor((x - min.x) / cell), j = Math.floor((y - min.y) / cell), l = Math.floor((z - min.z) / cell);
      if (i < 0 || j < 0 || l < 0 || i >= nx || j >= ny || l >= nz) return;
      const idx = (l * ny + j) * nx + i;
      if (grid[idx] === 0 || (val >= 2 && grid[idx] === 1)) grid[idx] = val;
    };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    // 砲身のボーンの付け根の位置と向き（モデルの座標）
    const barrelInfo = new Map();
    for (const m of rig.mounts) for (const br of m.barrels) {
      const BM = new THREE.Matrix4().multiplyMatrices(inv, br.node.matrixWorld);
      barrelInfo.set(br.node, { p: new THREE.Vector3().setFromMatrixPosition(BM), d: new THREE.Vector3(0, 1, 0).transformDirection(BM), len: 0 });
    }
    for (const o of meshes) {
      M.multiplyMatrices(inv, o.matrixWorld);
      const g = o.geometry, pos = g.attributes.position, index = g.index;
      const sk = o.isSkinnedMesh && g.attributes.skinIndex && g.attributes.skinWeight ? o.skeleton : null;
      const si = sk ? g.attributes.skinIndex : null, sw = sk ? g.attributes.skinWeight : null;
      // この部品が砲塔の部品なら（ボーンに砲塔を含む）、砲身以外の部分（台座・neutral_bone など）はその砲塔のもの
      let meshOwner = 1;
      if (sk) rig.mounts.forEach((m, k) => { if (sk.bones.includes(m.turret)) meshOwner = 2 + k; });
      // スキンの頂点の位置: three.js が描くときと同じく「ボーンの世界の行列 × ボーンの逆行列 × bindMatrix」で求める
      // （メッシュ自身の位置は使われない。副砲のように、位置をずらしたグループの下のメッシュで二重にずれていた）
      const boneM = sk ? sk.bones.map((bone, bi) => new THREE.Matrix4().multiplyMatrices(inv, bone.matrixWorld).multiply(sk.boneInverses[bi]).multiply(o.bindMatrix)) : null;
      const domBone = (vi) => {
        let best = 0, bw = -1;
        const ws = [sw.getX(vi), sw.getY(vi), sw.getZ(vi), sw.getW(vi)], is = [si.getX(vi), si.getY(vi), si.getZ(vi), si.getW(vi)];
        for (let q = 0; q < 4; q++) if (ws[q] > bw) { bw = ws[q]; best = is[q]; }
        return best;
      };
      const place = (vec, vi) => vec.fromBufferAttribute(pos, vi).applyMatrix4(sk ? boneM[domBone(vi)] : M);
      const ownerOf = (vi) => {
        if (!sk) return 1;
        let best = 0, bw = -1;
        const ws = [sw.getX(vi), sw.getY(vi), sw.getZ(vi), sw.getW(vi)], is = [si.getX(vi), si.getY(vi), si.getZ(vi), si.getW(vi)];
        for (let q = 0; q < 4; q++) if (ws[q] > bw) { bw = ws[q]; best = is[q]; }
        const own = boneOwner.get(sk.bones[best]);
        return own === undefined ? meshOwner : own === -1 ? -1 : 2 + own;
      };
      // v89: 砲身の長さを測る（砲身のボーンに付いた頂点の、付け根から砲身の向きへの最大の距離）
      if (sk) {
        const vtx = new THREE.Vector3();
        for (let vi = 0; vi < pos.count; vi++) {
          const info = barrelInfo.get(sk.bones[domBone(vi)]);
          if (!info) continue;
          place(vtx, vi).sub(info.p);
          info.len = Math.max(info.len, vtx.dot(info.d));
        }
      }
      const triCount = index ? index.count / 3 : pos.count / 3;
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3, i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1, i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const val = ownerOf(i0);
        if (val === -1) continue;
        place(a, i0); place(b, i1); place(c, i2);
        const e = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
        const n = Math.min(64, Math.max(1, Math.ceil(e / (cell * 0.7))));
        for (let u = 0; u <= n; u++) {
          for (let w = 0; w <= n - u; w++) {
            const fu = u / n, fw = w / n, fv = 1 - fu - fw;
            mark(a.x * fv + b.x * fu + c.x * fw, a.y * fv + b.y * fu + c.y * fw, a.z * fv + b.z * fu + c.z * fw, val);
          }
        }
      }
    }
    // 砲身の長さ（世界の大きさ。モデルの拡大率を掛ける）
    const scale = new THREE.Vector3().setFromMatrixScale(root.matrixWorld).x;
    const barrelLen = new Map();
    for (const [node, info] of barrelInfo) if (info.len > 0) barrelLen.set(node, info.len * scale);
    return { grid, nx, ny, nz, cell, min, root, barrelLen };
  },
  // v89: 世界の線分 a→b が船体（格子のどこか）に当たるか。当たればその世界の点。格子の箱の中だけをたどる
  segmentHitsGrid(occ, a, b) {
    if (!occ) return null;
    const inv = new THREE.Matrix4().copy(occ.root.matrixWorld).invert();
    const A = a.clone().applyMatrix4(inv), B = b.clone().applyMatrix4(inv);
    const lo = occ.min, hi = new THREE.Vector3(occ.min.x + occ.nx * occ.cell, occ.min.y + occ.ny * occ.cell, occ.min.z + occ.nz * occ.cell);
    const d = B.clone().sub(A);
    let t0 = 0, t1 = 1;
    for (const k of ['x', 'y', 'z']) {
      if (Math.abs(d[k]) < 1e-12) { if (A[k] < lo[k] || A[k] > hi[k]) return null; continue; }
      let ta = (lo[k] - A[k]) / d[k], tb = (hi[k] - A[k]) / d[k];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    const len = d.length() * (t1 - t0);
    const n = Math.max(1, Math.ceil(len / (occ.cell * 0.5)));
    for (let i = 0; i <= n; i++) {
      const u = t0 + ((t1 - t0) * i) / n;
      const x = A.x + d.x * u, y = A.y + d.y * u, z = A.z + d.z * u;
      const ci = Math.floor((x - lo.x) / occ.cell), cj = Math.floor((y - lo.y) / occ.cell), cl = Math.floor((z - lo.z) / occ.cell);
      if (ci < 0 || cj < 0 || cl < 0 || ci >= occ.nx || cj >= occ.ny || cl >= occ.nz) continue;
      if (occ.grid[(cl * occ.ny + cj) * occ.nx + ci] !== 0) return a.clone().lerp(b, u);
    }
    return null;
  },
  // 世界の点 p から向き dir（世界）へ撃ったとき、船体・ほかの砲塔に当たるか（自分の砲塔 selfK は除く）
  //   v89: 砲口のすぐ周り（格子1つ半）は見ない（砲郭・防盾など、砲口を囲むカバーに当たったと間違えないように）
  lineBlocked(occ, p, dir, selfK) {
    if (!occ) return false;
    const inv = new THREE.Matrix4().copy(occ.root.matrixWorld).invert();
    const o = p.clone().applyMatrix4(inv);
    const d = dir.clone().transformDirection(inv);
    const step = occ.cell * 0.5, maxN = Math.ceil(((occ.nx + occ.ny + occ.nz) * occ.cell) / step);
    const self = 2 + selfK;
    for (let n = 3; n < maxN; n++) {
      const x = o.x + d.x * step * n, y = o.y + d.y * step * n, z = o.z + d.z * step * n;
      const i = Math.floor((x - occ.min.x) / occ.cell), j = Math.floor((y - occ.min.y) / occ.cell), l = Math.floor((z - occ.min.z) / occ.cell);
      if (i < 0 || j < 0 || l < 0 || i >= occ.nx || j >= occ.ny || l >= occ.nz) return false; // 船体の外へ出た
      const v = occ.grid[(l * occ.ny + j) * occ.nx + i];
      if (v !== 0 && v !== self) return true;
    }
    return false;
  },
  restoreAll(rig) {
    if (!rig) return;
    for (const m of rig.mounts) this.setMountAngles(m, 0, 0);
    for (const d of rig.directors) this.setDirectorYaw(d, 0);
  },
};

// -------------------------------------------------------------
// v89: ボーンで動く部品（スキン）のブレ対策
//   three.js はスキンの頂点を「ボーンの世界の行列 × 船体の世界の行列の逆」で GPU（32ビットの小数）で計算する。
//   艦の座標が大きいと、どちらの行列にも大きな位置が入り、GPU の中で打ち消し合うときに桁が落ちて、
//   砲塔・砲身がブレていた。打ち消しを JS（64ビット）で先に済ませ、小さな値だけを GPU に渡す。
// -------------------------------------------------------------
function stabilizeSkinnedMeshes(root) {
  if (!root) return;
  const ident = new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton || o.userData.skinStabilized) return;
    o.userData.skinStabilized = true;
    const mesh = o;
    const meshInv = new THREE.Matrix4(), m = new THREE.Matrix4();
    // 頂点の最後の変換（bindMatrixInverse）は単位行列にし、その分をボーンの行列に含める
    mesh.updateMatrixWorld = function (force) {
      THREE.Mesh.prototype.updateMatrixWorld.call(this, force);
      this.bindMatrixInverse.identity();
    };
    mesh.skeleton.update = function () {
      meshInv.copy(mesh.matrixWorld).invert();
      for (let i = 0; i < this.bones.length; i++) {
        const bone = this.bones[i];
        m.multiplyMatrices(bone ? bone.matrixWorld : ident, this.boneInverses[i]);
        m.premultiply(meshInv);
        m.toArray(this.boneMatrices, i * 16);
      }
      if (this.boneTexture) this.boneTexture.needsUpdate = true;
    };
  });
}

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
    this._modelRoot = modelRoot;
    this.cfg = normalizeShipWeapons(design && design.weapons);
    // v89: グループ（設計に無ければ名前から分ける。ゲームの中だけで、設計は書き換えない）
    const gcfg = normalizeShipWeapons(JSON.parse(JSON.stringify(this.cfg)));
    ensureWeaponGroups(gcfg, rig.mounts.map((m) => m.key));
    this.cfg = gcfg;
    for (const m of rig.mounts) {
      m.cfg = weaponMountConfigFor(this.cfg, m.key);
      m.groupId = m.cfg.group;
      m.reloadLeft = m.barrels.map(() => 0);
    }
    for (const d of rig.directors) d.cfg = normalizeWeaponDirector(this.cfg.directors[d.key]);
    // 画面の番号: 名前の頭の数字（「1番主砲」→1）。無ければ並び順
    // 画面の番号: 並び順（名前の頭の数字の順。「1番主砲」…「12番主砲」、次に副砲など）の通し番号
    rig.mounts.forEach((m, k) => { m.num = k + 1; m.index = k; m.state = 'none'; });
    try { this._occ = WeaponRig.buildOcclusion(modelRoot, rig); } catch (e) { console.warn('射線の判定の準備に失敗しました', e); this._occ = null; }
    if (this._occ) for (const m of rig.mounts) for (const b of m.barrels) b.length = this._occ.barrelLen.get(b.node) || null;
    try { this._buildInset(modelRoot, rig); } catch (e) { console.warn('照準の小さな艦の図の準備に失敗しました', e); this._inset = null; }
    // 自動射撃: mode 'off' 切 / 'max' 最大（満タンで撃つ）/ 'set' 設定した出力（レーザーがその割合まで充電できたら撃つ）
    // v89: ゲームのボタンは最上位のグループだけ（中のグループの砲は、最上位のグループの自動射撃に従う）
    for (const m of rig.mounts) m.topGroupId = weaponTopGroupId(this.cfg, m.groupId);
    this.groups = this.cfg.groups.filter((g) => !g.parent || weaponTopGroupId(this.cfg, g.id) === g.id).map((g) => {
      const mounts = rig.mounts.filter((m) => m.topGroupId === g.id);
      return { id: g.id, name: g.name, mode: g.autoFire ? 'max' : 'off', power: g.autoPower, mounts, hasLaser: mounts.some((m) => m.cfg.kind === 'laser') };
    }).filter((g) => g.mounts.length);
    this._groupById = new Map(this.groups.map((g) => [g.id, g]));
    for (const m of rig.mounts) m.groupId = m.topGroupId;
    this._mainCaliber = Math.max(...rig.mounts.map((m) => m.cfg.caliber), 0);
    this._buildMountUi();
    this._buildGroupUi();
    this._syncUi();
  },
  detach() {
    this.stopPractice();
    this._disposeInset();
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
    this._viewMount = null;
    this.lock = null;
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
    if (on !== this.view) this._setScopeLook(on);
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
    this._time = (this._time || 0) + dt;
    this._dt = dt;
    // v89: 演習の目標を動かし、見ている方向の半球にある目標へ照準を合わせる（自動照準）
    this._updateTargets(dt);
    this._updateLock();
    const dl = this.aimDirLocal();
    const D = dl ? new THREE.Vector3(dl.x, dl.y, dl.z) : null;
    let ready = 0, aimed = 0;
    for (const m of this.rig.mounts) {
      const c = m.cfg;
      let ty = 0, te = 0;
      m.mode = 'none'; // 'exact' ぴったり向けられる / 'near' 範囲の端まで寄せる / 'none' 元の向き
      // v89: 砲ごとの狙う向き（演習の目標があれば、その砲の弾の速さで偏差をつけた向き）
      const Dm = this._mountAimDir(m, D);
      if (Dm) {
        const a = WeaponRig.aimAngles(m, Dm);
        const yMin = toRadW(c.yawMin), yMax = toRadW(c.yawMax), eMin = toRadW(c.elevMin), eMax = toRadW(c.elevMax);
        if (a.yaw >= yMin - 1e-6 && a.yaw <= yMax + 1e-6 && a.elev >= eMin - 1e-6 && a.elev <= eMax + 1e-6) {
          ty = a.yaw; te = a.elev; m.mode = 'exact';
        } else {
          // ぴったりは向けられないが、範囲の端まで回せば近く（30°以内）まで向けられるなら寄せる
          let cy = a.yaw;
          if (cy < yMin || cy > yMax) {
            const dMin = Math.abs(Math.atan2(Math.sin(cy - yMin), Math.cos(cy - yMin)));
            const dMax = Math.abs(Math.atan2(Math.sin(cy - yMax), Math.cos(cy - yMax)));
            cy = dMin <= dMax ? yMin : yMax;
          }
          const ce = clamp(a.elev, eMin, eMax);
          const cosErr = Math.cos(a.elev) * Math.cos(ce) * Math.cos(a.yaw - cy) + Math.sin(a.elev) * Math.sin(ce);
          if (Math.acos(clamp(cosErr, -1, 1)) <= toRadW(this.NEAR_MAX_DEG)) { ty = cy; te = ce; m.mode = 'near'; }
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
      const settled = Math.abs(Math.atan2(Math.sin(ty - yaw), Math.cos(ty - yaw))) < toRadW(0.5) && Math.abs(te - elev) < toRadW(0.5);
      m.onTarget = m.mode === 'exact' && settled;
      for (let i = 0; i < m.reloadLeft.length; i++) m.reloadLeft[i] = Math.max(0, m.reloadLeft[i] - dt);
      // 射線: 狙いが合った砲身ごとに、船体・ほかの砲塔に当たらないか
      m.blocked = m.barrels.map(() => false);
      if (m.onTarget && this._occ) {
        m.turret.updateMatrixWorld(true);
        m.barrels.forEach((b, i) => {
          // 射線は砲口から（砲身の付け根から見ると、付け根を囲む砲郭・防盾に当たったと間違える）
          const { pos, dir } = this._barrelMuzzle(m, b);
          m.blocked[i] = WeaponRig.lineBlocked(this._occ, pos, dir, m.index);
        });
      }
      const canFire = (i) => m.reloadLeft[i] <= 0 && !m.blocked[i];
      // 状態: ready 撃てる（緑）/ moving 旋回中（黄）/ reload 装填中（赤）/ gray 射線が船体に当たる・近くまで寄せただけ / none 向けられない
      // v89: none 指向不可（ほぼ黒）/ near 指向不可だが寄せている（グレー）/ blocked 指向できたが射線が当たる（白）
      if (m.mode === 'none') m.state = 'none';
      else if (m.mode === 'near') m.state = 'near';
      else if (!settled) m.state = 'moving';
      else if (m.blocked.every((x) => x)) m.state = 'blocked';
      else if (m.target && m.target !== this.lock) m.state = 'indep'; // v89: 独立して別の目標を撃っている（橙）
      else if (m.barrels.some((b, i) => canFire(i))) m.state = 'ready';
      else m.state = 'reload';
      // 砲身ごとの状態（装填の棒・小さな図の線の色）
      // v89: 自動射撃を「N%」にしているレーザーは、充電が N% になったら撃てる（緑）とする
      const fullCh = this._fullCharge(m);
      m.barrelStates = m.barrels.map((b, i) => (m.state === 'none' || m.state === 'near' || m.state === 'moving' ? m.state
        : m.state === 'indep' ? (m.blocked[i] ? 'blocked' : 'indep')
        : m.blocked[i] ? 'blocked' : (m.cfg.kind === 'laser' ? this._charge(m, i) < fullCh - 1e-9 : m.reloadLeft[i] > 0) ? 'reload' : 'ready'));
      if (m.onTarget) aimed++;
      if (m.barrels.some((b, i) => this._canFireBarrel(m, i))) ready++;
    }
    // v89: 自動射撃のグループは、狙いが合って装填ができ次第、撃てる砲身を撃ち続ける
    if (this.aim.active && this.groups) {
      for (const g of this.groups) {
        if (g.mode === 'off') continue;
        // レーザーは「最大」なら満タンで、「%」ならその割合まで充電できたら撃つ（実弾砲は装填が済んだら）
        const thr = g.mode === 'set' ? g.power / 100 : 1;
        for (const m of g.mounts) {
          m.barrels.forEach((b, i) => {
            if (!this._canFireBarrel(m, i, thr)) return;
            this._shoot(m, b, i);
          });
        }
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

  // v89: 照準の視点は、射撃レーダー／測距儀の位置から、測距儀でのぞいているように拡大して見る
  //   測距儀の倍率 = ふだんの視野角 ÷ 照準の視野角（ピンチ・ホイールで変える）
  AIM_FOV_DEFAULT: 30, // ふだん（60°）の2倍
  AIM_FOV_MIN: 1,
  AIM_FOV_MAX: 50,
  _aimFov: 30,
  SALVO_TAP_MS: 400, // 「撃て」をこの時間 [ms] より早く続けて押すと一斉射撃
  NEAR_MAX_DEG: 30, // ぴったり向けられない砲を寄せるのは、狙う向きからこの角度まで
  zoomBy(factor) {
    this._aimFov = clamp(this._aimFov * factor, this.AIM_FOV_MIN, this.AIM_FOV_MAX);
  },
  // 照準の視点に入る・出るとき: 視野角を戻すために覚える。船体の面の裏側を描かないようにする
  // （レーダーの中から見るので、レーダー自身や船体の面が視界をふさがないように）
  _setScopeLook(on) {
    if (on) {
      this._savedSides = [];
      if (this._modelRoot) {
        this._modelRoot.traverse((o) => {
          if (!o.material) return;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (m.side !== THREE.FrontSide) { this._savedSides.push([m, m.side]); m.side = THREE.FrontSide; m.needsUpdate = true; }
          }
        });
      }
    } else {
      for (const [m, side] of this._savedSides || []) { m.side = side; m.needsUpdate = true; }
      this._savedSides = null;
      if (this._savedFov && typeof camera !== 'undefined' && camera) {
        camera.fov = this._savedFov;
        camera.updateProjectionMatrix();
      }
      this._savedFov = null;
    }
  },
  // ---------------------------------------------------------
  // v89: 照準の視点の小さな3Dの図（装填の棒の上）
  //   射撃方向を奥に見た艦の概形（全長の1/64の格子の箱）と、砲身ごとの向きの細い薄黄色の線。
  //   艦がどちらを向いていて、どの砲がどこを向いているかが分かる
  // ---------------------------------------------------------
  _buildInset(modelRoot, rig) {
    this._disposeInset();
    const occ = WeaponRig.buildOcclusion(modelRoot, rig, 64);
    if (!occ) return;
    const { grid, nx, ny, nz, cell, min } = occ;
    const at = (i, j, l) => (i < 0 || j < 0 || l < 0 || i >= nx || j >= ny || l >= nz ? 0 : grid[(l * ny + j) * nx + i]);
    const cells = [];
    for (let l = 0; l < nz; l++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!at(i, j, l)) continue;
      // 外から見える箱だけ（6方向のどれかが空）
      if (at(i + 1, j, l) && at(i - 1, j, l) && at(i, j + 1, l) && at(i, j - 1, l) && at(i, j, l + 1) && at(i, j, l - 1)) continue;
      cells.push([i, j, l, at(i, j, l)]);
    }
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x203040, 1.0));
    const ship = new THREE.Group();
    ship.matrixAutoUpdate = false;
    scene.add(ship);
    const geo = new THREE.BoxGeometry(cell, cell, cell);
    const mat = new THREE.MeshLambertMaterial({ color: 0x8aa6c4 });
    const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, cells.length));
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    cells.forEach(([i, j, l, v], k) => {
      m4.makeTranslation(min.x + (i + 0.5) * cell, min.y + (j + 0.5) * cell, min.z + (l + 0.5) * cell);
      inst.setMatrixAt(k, m4);
      inst.setColorAt(k, col.set(v >= 2 ? 0xc8d4e0 : 0x6f8aa8));
    });
    inst.count = cells.length;
    ship.add(inst);
    // 砲身の向きの線（艦の位置を原点にしたゲームの座標で、毎フレーム描き直す）
    const nB = rig.mounts.reduce((n, m) => n + m.barrels.length, 0);
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nB * 6), 3));
    lgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nB * 6), 3));
    const lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }));
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    scene.add(lines);
    const camera = new THREE.PerspectiveCamera(30, 1.5, 0.1, 1e6);
    const size = Math.max(nx, ny, nz) * cell;
    this._inset = { scene, ship, inst, lines, camera, size };
    const frame = document.createElement('div');
    frame.className = 'wpn-inset';
    frame.innerHTML = '<div class="wpn-inset-resize" title="ドラッグで大きさを変える"></div>';
    document.body.appendChild(frame);
    this._inset.frame = frame;
    this._bindInsetDrag(frame);
  },
  // v89: 小さな図は、ドラッグで動かし、右下の角で大きさを変えられる（最後の状態をこの端末に保存。ダブルタップで元の場所へ）
  INSET_LAYOUT_KEY: 'spaceSimWeaponInset',
  _insetLayout() {
    if (this._insetLayoutCache !== undefined) return this._insetLayoutCache;
    let v = null;
    try { v = JSON.parse(localStorage.getItem(this.INSET_LAYOUT_KEY) || 'null'); } catch (e) { v = null; }
    this._insetLayoutCache = v && Number.isFinite(v.x) && Number.isFinite(v.bottom) && v.w > 0 && v.h > 0 ? v : null;
    return this._insetLayoutCache;
  },
  _saveInsetLayout(v) {
    this._insetLayoutCache = v;
    try { if (v) localStorage.setItem(this.INSET_LAYOUT_KEY, JSON.stringify(v)); else localStorage.removeItem(this.INSET_LAYOUT_KEY); } catch (e) { /* ignore */ }
  },
  _bindInsetDrag(frame) {
    let drag = null, lastTap = 0;
    const start = (x, y, id, target) => {
      const b = this._inset && this._inset.box;
      if (!b) return;
      const now = performance.now();
      if (now - lastTap < 350) { this._saveInsetLayout(null); lastTap = 0; drag = null; this._flashStatus('姿勢の図を元の場所に戻しました'); return; }
      lastTap = now;
      drag = { id, x, y, b: { ...b }, resize: target.classList.contains('wpn-inset-resize') };
    };
    const move = (x, y, id) => {
      if (!drag || drag.id !== id) return;
      const dx = x - drag.x, dy = y - drag.y;
      const b = drag.b;
      // 大きさを変えるとき: 右下の角を動かす（左上は動かさない）
      const v = drag.resize
        ? { x: b.x, w: b.w + dx, h: b.h + dy, bottom: b.bottom - dy }
        : { x: b.x + dx, w: b.w, h: b.h, bottom: b.bottom - dy };
      if (drag.resize) { v.w = Math.max(120, v.w); v.h = Math.max(80, v.h); v.bottom = b.bottom + b.h - v.h; }
      this._saveInsetLayout(v);
    };
    const end = (id) => { if (drag && drag.id === id) drag = null; };
    frame.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); const t = e.changedTouches[0]; start(t.clientX, t.clientY, t.identifier, e.target); }, { passive: false });
    frame.addEventListener('touchmove', (e) => { e.preventDefault(); for (const t of e.changedTouches) move(t.clientX, t.clientY, t.identifier); }, { passive: false });
    frame.addEventListener('touchend', (e) => { for (const t of e.changedTouches) end(t.identifier); });
    frame.addEventListener('mousedown', (e) => { e.stopPropagation(); start(e.clientX, e.clientY, 'mouse', e.target); });
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY, 'mouse'));
    window.addEventListener('mouseup', () => end('mouse'));
  },
  _disposeInset() {
    const s = this._inset;
    if (!s) return;
    s.inst.geometry.dispose(); s.inst.material.dispose();
    s.lines.geometry.dispose(); s.lines.material.dispose();
    if (s.frame) s.frame.remove();
    this._inset = null;
  },
  // メインの描画の後に、画面の下の小さな枠へ描く（index.html animateFrame）
  renderInset(renderer) {
    const s = this._inset;
    const show = !!(s && this.view && this.hasWeapons() && this._modelRoot && !(typeof CleanView !== 'undefined' && CleanView.on));
    if (s && s.frame) s.frame.style.display = show ? '' : 'none';
    if (!show) return;
    const ship = State.ship;
    const dl = this.aimDirLocal();
    if (!ship || !dl) return;
    // 置き場所: 動かした・大きさを変えたならその場所（画面に収まるように）、そうでなければ装填の棒（番号）の上
    const small = window.innerWidth <= 700 || window.innerHeight <= 500;
    let w = small ? 170 : 230, h = small ? 104 : 140, x, bottom;
    const L = this._insetLayout();
    if (L) {
      w = Math.round(clamp(L.w, 120, window.innerWidth * 0.9));
      h = Math.round(clamp(L.h, 80, window.innerHeight * 0.8));
      x = Math.round(clamp(L.x, 0, window.innerWidth - w));
      bottom = Math.round(clamp(L.bottom, 0, window.innerHeight - h));
    } else {
      const cr = this._ui.chips.getBoundingClientRect();
      const cx = cr.width > 0 ? cr.left + cr.width / 2 : window.innerWidth / 2;
      bottom = cr.height > 0 ? window.innerHeight - cr.top + 6 : 90;
      x = Math.round(cx - w / 2);
    }
    s.box = { x, bottom, w, h };
    s.frame.style.left = `${x}px`; s.frame.style.bottom = `${bottom}px`;
    s.frame.style.width = `${w}px`; s.frame.style.height = `${h}px`;
    // 艦の概形: モデルの座標 → 艦の位置を原点にしたゲームの座標
    const mw = this._modelRoot.matrixWorld;
    s.ship.matrix.copy(mw);
    s.ship.matrix.elements[12] -= ship.position.x; s.ship.matrix.elements[13] -= ship.position.y; s.ship.matrix.elements[14] -= ship.position.z;
    s.ship.matrixWorldNeedsUpdate = true;
    // 砲身の線
    const a = s.lines.geometry.attributes.position;
    const ca = s.lines.geometry.attributes.color;
    const colorOf = WEAPON_STATE_COLORS;
    const lc = new THREE.Color();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), d = new THREE.Vector3();
    const len = s.size * 0.32;
    let k = 0;
    for (const m of this.rig.mounts) {
      for (const [bi, b] of m.barrels.entries()) {
        b.node.getWorldPosition(p);
        b.node.getWorldQuaternion(q);
        d.set(0, 1, 0).applyQuaternion(q);
        p.x -= ship.position.x; p.y -= ship.position.y; p.z -= ship.position.z;
        // 線の色は、その砲の状態の色（狙っていなければ薄い黄色）
        const bst = m.barrelStates ? m.barrelStates[bi] : m.state;
        lc.setHex(this.aim.active ? (colorOf[bst] || 0xfff0a0) : 0xfff0a0);
        ca.setXYZ(k, lc.r, lc.g, lc.b); ca.setXYZ(k + 1, lc.r, lc.g, lc.b);
        a.setXYZ(k++, p.x, p.y, p.z);
        a.setXYZ(k++, p.x + d.x * len, p.y + d.y * len, p.z + d.z * len);
      }
    }
    a.needsUpdate = true;
    ca.needsUpdate = true;
    // カメラ: 射撃方向を奥に（艦の後ろ、射撃方向の手前から見る）。上は艦の上
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    // 艦の長さが枠の幅にほぼ収まる距離（縦・横の視野角の狭い方に合わせる）
    const tv = Math.tan((s.camera.fov * Math.PI) / 360), th = tv * (w / h);
    const dist = (s.size * 0.5) / Math.min(tv * 1.6, th) * 1.02;
    s.camera.aspect = w / h;
    s.camera.position.set(-dl.x * dist, -dl.y * dist, -dl.z * dist);
    s.camera.up.set(up.x, up.y, up.z);
    s.camera.lookAt(0, 0, 0);
    s.camera.near = dist * 0.05; s.camera.far = dist * 4;
    s.camera.updateProjectionMatrix();
    const y = window.innerHeight - bottom - h;
    const prevAuto = renderer.autoClear;
    const cc = renderer.getClearColor(new THREE.Color()), cAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    renderer.setScissor(x, window.innerHeight - y - h, w, h);
    renderer.setViewport(x, window.innerHeight - y - h, w, h);
    renderer.setClearColor(0x060a10, 1);
    renderer.clear(true, true, false);
    renderer.autoClear = false;
    renderer.render(s.scene, s.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.setClearColor(cc, cAlpha);
    renderer.autoClear = prevAuto;
  },

  // 照準の視点のカメラ（照準の視点でなければ false を返し、ふだんのカメラに任せる）
  // v89: 照準の視点では、自艦の噴射（炎・噴煙・粒）を描かない（レーダーのすぐそばで噴く姿勢スラスターの噴煙で視界が真っ白になるため）
  _setOwnFxVisible(on) {
    if (typeof EngineFx === 'undefined') return;
    if (EngineFx._plumeRoot) EngineFx._plumeRoot.visible = on;
    for (const pool of [EngineFx._mainPool, EngineFx._rcsPool]) if (pool && pool.points) pool.points.visible = on;
  },
  updateCamera(cam) {
    const inView = !!(this.view && this.hasWeapons());
    if (inView !== this._fxHidden) { this._fxHidden = inView; this._setOwnFxVisible(!inView); }
    if (!this.view || !this.hasWeapons()) return false;
    const ship = State.ship;
    const dl = this.aimDirLocal();
    if (!ship || !dl) return false;
    if (!this._savedFov) this._savedFov = cam.fov;
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    const dir = this.rig.directors[0];
    let p;
    const vm = this._viewMount && this.rig.mounts.includes(this._viewMount) ? this._viewMount : null;
    if (vm) {
      // v89: 番号を押した砲の砲口から見る（砲身の後ろから見ると砲身が視界をふさぐので、砲口から）
      ship.mesh.updateMatrixWorld(true);
      const { pos } = this._barrelMuzzle(vm, vm.barrels[0]);
      p = { x: pos.x, y: pos.y, z: pos.z };
    } else if (dir) {
      ship.mesh.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      dir.node.getWorldPosition(v);
      p = { x: v.x, y: v.y, z: v.z };
    } else {
      // 射撃レーダーが無ければ、艦の上（船体の上の縁の少し上）から
      const size = (CameraSystem._shipScale || 1) * 8;
      p = { x: ship.position.x + up.x * size * 0.12, y: ship.position.y + up.y * size * 0.12, z: ship.position.z + up.z * size * 0.12 };
    }
    cam.position.set(p.x, p.y, p.z);
    cam.up.set(up.x, up.y, up.z);
    cam.lookAt(p.x + dl.x, p.y + dl.y, p.z + dl.z);
    if (Math.abs(cam.fov - this._aimFov) > 1e-6) { cam.fov = this._aimFov; cam.updateProjectionMatrix(); }
    const el = this._ui && this._ui.reticle;
    if (el) { el.style.left = '50%'; el.style.top = '50%'; }
    this._placeGunMarks(cam);
    this._placeTargetMarks(cam);
    if (this._ui && this._ui.zoom) {
      const t = `測距儀 ×${(this._savedFov / this._aimFov).toFixed(1)}`;
      if (this._ui.zoom.textContent !== t) this._ui.zoom.textContent = t;
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
      // 指の下の景色が指についてくる速さ（視野角に合わせる。拡大しているほどゆっくり）
      const k = ((this._aimFov * Math.PI) / 180) / Math.max(1, window.innerHeight);
      this._rotateAim(-dx * k, -dy * k);
    };
    const end = (id) => { if (this._drag && this._drag.id === id) this._drag = null; };
    canvas.addEventListener('touchstart', (e) => { const tt = e.targetTouches; if (tt.length === 1) start(tt[0].clientX, tt[0].clientY, tt[0].identifier); else this._drag = null; }, { passive: true });
    canvas.addEventListener('touchmove', (e) => { for (const t of e.changedTouches) move(t.clientX, t.clientY, t.identifier); }, { passive: true });
    canvas.addEventListener('touchend', (e) => { for (const t of e.changedTouches) end(t.identifier); }, { passive: true });
    canvas.addEventListener('mousedown', (e) => start(e.clientX, e.clientY, 'mouse'));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY, 'mouse'));
    window.addEventListener('mouseup', () => end('mouse'));
  },
  _rotateAim(yaw, pitch) {
    this.lock = null; // 自分で照準を動かしたら、合わせていた目標から外す
    this._noAutoLockUntil = (this._time || 0) + 1.5; // 少しのあいだ自動で合わせない（動かしている途中で引き戻されないように）
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
  // v89: 撃つ順番（砲塔の番号順、同じ砲塔の中は砲の番号順）の砲身の並び
  _firingOrder() {
    const list = [];
    for (const m of [...this.rig.mounts].sort((a, b) => a.num - b.num)) {
      m.barrels.map((b, i) => ({ m, b, i })).sort((x, y) => x.b.num - y.b.num).forEach((e) => list.push(e));
    }
    return list;
  },
  // ---------------------------------------------------------
  // v89: 演習モード（射撃の目標）・自動照準・偏差射撃・独立した目標
  // ---------------------------------------------------------
  PRACTICE_GROUPS: 3,
  PRACTICE_PER_GROUP: 15,
  practice: null,
  lock: null,
  _practiceOn() { return !!(this.practice && this.practice.alive > 0); },
  // 演習を始める: 艦のまわりの3方向に、15個ずつの目標のまとまりを置く。
  //   v89: 目標はそれぞれランダムな砲を持ち、自艦へ近づいて撃ってくる。自艦・目標とも耐久があり、当たるごとに減る。
  //   45個を全部壊すと、演習を切るまで次の波を出す
  startPractice(nextWave) {
    const wave = nextWave && this.practice ? this.practice.wave + 1 : 1;
    const keepHP = nextWave && this.practice;
    const diffKey = PRACTICE_DIFFICULTIES[this.difficulty] ? this.difficulty : 'normal';
    const diff = PRACTICE_DIFFICULTIES[diffKey];
    this.stopPractice(true);
    const ship = State.ship;
    if (!ship || !this._scene) return;
    const group = new THREE.Group();
    group.frustumCulled = false;
    this._scene.add(group);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    // まとまりの距離は、主砲の射程に合わせる（射程の 25%・50%・80%。3〜30 km）
    const mainRange = this.rig && this.rig.mounts.length ? Math.max(...this.rig.mounts.map((m) => weaponRange(m.cfg))) : 30000;
    const dists = [0.25, 0.5, 0.8].map((k) => clamp(mainRange * k, 3000, 30000));
    const dirs = [[35, 5], [-70, 0], [150, 10]].map(([y, e]) => [y + (wave - 1) * 47, e]); // 波ごとに方向を変える
    const q = new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    const targets = [];
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const rnd = ([a, b]) => a + Math.random() * (b - a);
    // 難易度の重みで艦種を選ぶ
    const wsum = Object.values(diff.weights).reduce((a, b) => a + b, 0);
    const pickClass = () => { let r = Math.random() * wsum; for (const [k, w] of Object.entries(diff.weights)) { if ((r -= w) <= 0) return k; } return 'dd'; };
    const perGroup = Math.round(diff.count / this.PRACTICE_GROUPS);
    for (let gi = 0; gi < this.PRACTICE_GROUPS; gi++) {
      const [yaw, el] = dirs[gi % dirs.length];
      const d = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(1, 0, 0), toRadW(el)).applyAxisAngle(new THREE.Vector3(0, 1, 0), toRadW(yaw)).applyQuaternion(q);
      const center = new THREE.Vector3(ship.position.x, ship.position.y, ship.position.z).addScaledVector(d, dists[gi]);
      for (let k = 0; k < perGroup; k++) {
        const cls = pickClass();
        const C = ENEMY_CLASSES[cls];
        const off = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(cls === 'ac' ? 2000 : 3000);
        const pos = center.clone().add(off);
        const mat = new THREE.MeshStandardMaterial({ color: C.color, emissive: new THREE.Color(C.color).multiplyScalar(0.35), roughness: 0.6 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.scale.set(C.W, C.H, C.L); // 長さは Z（進む向き）
        mesh.position.copy(pos);
        group.add(mesh);
        const type = pick(C.types);
        const kind = ['pulse', 'cw', 'xray'].includes(type) ? 'laser' : 'kinetic';
        const info = weaponTypeInfo(kind, type);
        const weapon = {
          kind, type, caliber: Math.round(rnd(C.cal)), speed: info.speed || 0, guns: C.guns,
          reload: rnd(C.reload), range: C.range, dmgMul: diff.dmg,
          color: pick(['#ff3a2a', '#3aff6a', '#c050ff', '#ffe23a']),
        };
        targets.push({
          cls, label: C.label, pos, vel: new THREE.Vector3(State.ship.velocity.x, State.ship.velocity.y, State.ship.velocity.z).clampLength(0, C.ikn[1] * SHIP_IKN), size: Math.max(C.W, C.H, C.L) * 0.45, moving: cls === 'ac' || cls === 'dd',
          alive: true, mesh, mat, center, group: gi, distShip: 0,
          hp: C.hp, hpMax: C.hp, weapon, reloadLeft: 2 + Math.random() * weapon.reload,
          maxSpeed: rnd(C.ikn) * SHIP_IKN, rel: C.rel * (0.8 + Math.random() * 0.4), tau: C.tau,
          standoff: rnd(C.standoff), orbitSign: Math.random() < 0.5 ? 1 : -1,
        });
      }
    }
    const shipSize = (CameraSystem._shipScale || 1) * 8;
    const hpMax = keepHP ? keepHP.shipHPMax : Math.max(200, 40 * shipSize);
    this.practice = {
      targets, group, geo, mats: targets.map((t) => t.mat), alive: targets.length, total: targets.length, wave, difficulty: diffKey,
      shipHPMax: hpMax, shipHP: keepHP ? keepHP.shipHP : hpMax,
    };
    this._buildTargetMarkers();
    const count = {};
    for (const t of targets) count[t.label] = (count[t.label] || 0) + 1;
    const comp = Object.entries(count).map(([k, v]) => `${k}${v}`).join('・');
    this._flashStatus(`${wave > 1 ? `第${wave}波` : `演習開始（${diff.label}）`}: ${comp}`);
    this._syncUi();
  },
  stopPractice(keepUi) {
    const P = this.practice;
    if (!P) return;
    this._scene.remove(P.group);
    P.geo.dispose();
    for (const m of P.mats) m.dispose();
    this.practice = null;
    this.lock = null;
    this.autoManeuver = keepUi ? this.autoManeuver : false;
    if (this._ui && this._ui.tmarks) this._ui.tmarks.innerHTML = '';
    if (this.rig) for (const m of this.rig.mounts) { m.target = null; m._indep = null; m._near = null; }
    if (!keepUi) this._syncUi();
  },
  _updateTargets(dt) {
    const P = this.practice;
    if (!P) return;
    const ship = State.ship;
    const sp = new THREE.Vector3(ship.position.x, ship.position.y, ship.position.z);
    const sv = new THREE.Vector3(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    for (const t of P.targets) {
      if (!t.alive) continue;
      // 動き: 自艦へ近づき、決まった距離まで来たら自艦のまわりを回る。自艦が動けば最高速度（15〜30 IKn。攻撃機はもっと速い）まで追う
      const R = sp.clone().sub(t.pos);
      const dist = R.length();
      const rh = R.clone().divideScalar(Math.max(1, dist));
      let desired;
      // 遠いほど速く詰める（自艦が高速で動いて離されても、最高速度の範囲で追いつく）
      if (dist > t.standoff * 1.15) desired = rh.clone().multiplyScalar(Math.max(t.rel * (dist > t.standoff * 3 ? 3 : 1), (dist - t.standoff) / 8));
      else {
        let tang = new THREE.Vector3().crossVectors(rh, new THREE.Vector3(0, 1, 0));
        if (tang.lengthSq() < 1e-6) tang.set(1, 0, 0);
        tang.normalize().multiplyScalar(t.orbitSign * t.rel * 0.7);
        desired = tang.addScaledVector(rh, clamp((dist - t.standoff) * 0.05, -t.rel, t.rel));
      }
      desired.add(sv);
      t.vel.lerp(desired, 1 - Math.exp(-dt / t.tau));
      if (t.vel.length() > t.maxSpeed) t.vel.setLength(t.maxSpeed);
      t.pos.addScaledVector(t.vel, dt);
      // 進む向き（自艦に対する速度の向き）へ艦首を向ける
      const vr = t.vel.clone().sub(sv);
      if (vr.lengthSq() > 1) t.mesh.lookAt(t.pos.clone().add(vr));
      t.mesh.position.copy(t.pos);
      t.distShip = t.pos.distanceTo(sp);
      // 攻撃: 射程に入ったら、装填ができ次第、自艦へ（偏差をつけ、少しばらつかせて）撃つ
      t.reloadLeft -= dt;
      if (t.reloadLeft <= 0 && t.distShip <= t.weapon.range && P.shipHP > 0) {
        t.reloadLeft = t.weapon.reload * (0.85 + Math.random() * 0.3);
        for (let g = 0; g < t.weapon.guns; g++) this._enemyFire(t, sp, sv);
      }
    }
  },
  // 目標が自艦を撃つ
  _enemyFire(t, sp, sv) {
    const w = t.weapon;
    const R = sp.clone().sub(t.pos);
    let dir;
    if (w.kind === 'laser') dir = R.clone().normalize();
    else {
      const L = weaponLeadSolve(R, sv.clone().sub(t.vel), w.speed);
      if (!L) return;
      dir = L.dir;
    }
    // ばらつき（遠いほど外れやすい）
    const spread = toRadW(0.15 + Math.min(1.2, t.distShip / 20000));
    const perp = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    dir.applyAxisAngle(perp, (Math.random() - 0.5) * 2 * spread).applyAxisAngle(dir.clone(), Math.random() * Math.PI * 2).normalize();
    const ship = State.ship;
    const dmg = weaponDamage(w.type, w.caliber) * (w.dmgMul || 1);
    if (w.kind === 'laser') {
      // 光線: 船体に当たればその場で
      const end = t.pos.clone().addScaledVector(dir, w.range);
      const hit = WeaponRig.segmentHitsGrid(this._occ, t.pos, end);
      const len = hit ? hit.distanceTo(t.pos) : Math.min(w.range, t.distShip * 1.5);
      this._spawnBeamFx(t.pos, dir, len, Math.max(0.6, w.caliber / 1000 * 3), new THREE.Color(w.color), 0.25, null);
      if (hit) this._hitShip(hit, dmg);
    } else {
      const v = t.vel.clone().addScaledVector(dir, w.speed);
      this._spawnShellFx(t.pos, v, 0xff5050, clamp(w.caliber / 60, 2, 5), Math.min(60, w.range / w.speed), { enemy: true, dmg });
    }
  },
  // ---------------------------------------------------------
  // v89: 自動操艦（演習中）: 目標の多い方向へ、向けられる砲がいちばん多くなる向きに艦を回し、目標との距離を保つ
  //   ShipController.update から毎フレーム（Navigation.approachInput などと同じく入力を書き換える）
  // ---------------------------------------------------------
  autoManeuver: false,
  maneuverInput(ship, input, dt) {
    if (!this.autoManeuver || !this._practiceOn() || !this.rig || !ship.mesh) return input;
    if (typeof Navigation !== 'undefined' && (Navigation.isWarping() || Navigation.approach || Navigation.departure)) return input;
    const P = this.practice;
    const sp = new THREE.Vector3(ship.position.x, ship.position.y, ship.position.z);
    // 目標の方向（近いほど重く）と、まとまりまでの距離
    const D = new THREE.Vector3();
    let wsum = 0, dsum = 0;
    for (const t of P.targets) {
      if (!t.alive) continue;
      const r = t.pos.clone().sub(sp);
      const d = Math.max(1000, r.length());
      const w = 1 / d;
      D.addScaledVector(r.normalize(), w);
      wsum += w; dsum += d * w;
    }
    if (wsum <= 0 || D.lengthSq() < 1e-12) return input;
    D.normalize();
    const dist = dsum / wsum;
    this._mvT = (this._mvT || 0) - dt;
    if (this._mvT <= 0 || !this._mvQ) { this._mvT = 1.5; this._mvQ = this._bestManeuverQuat(ship, D); }
    const out = { ...input };
    // 回す（自分でスティックを動かしていれば、そちらを優先）
    const userRot = Math.abs(input.rotatePitch) + Math.abs(input.rotateYaw) + Math.abs(input.rotateRoll) > 0.05;
    if (!userRot && this._mvQ) {
      const q = ship.quaternion;
      let qe = multiplyQuat(conjugateQuat(q), this._mvQ);
      if (qe.w < 0) qe = { x: -qe.x, y: -qe.y, z: -qe.z, w: -qe.w };
      const sN = Math.hypot(qe.x, qe.y, qe.z);
      const angle = 2 * Math.atan2(sN, qe.w);
      const maxW = Math.max(1e-6, ship.maxAngularSpeed);
      const alpha = ThrusterSolver._estimateMaxAngularAccel(ship);
      const aMin = Math.max(1e-6, Math.min(alpha.x, alpha.y, alpha.z));
      let rate = angle < 0.003 ? 0 : Math.max(maxW * 0.03, Math.min(maxW * 0.5, angle * 0.8, Math.sqrt(2 * aMin * angle * 0.5)));
      const k = sN > 1e-9 ? rate / sN : 0;
      out.rotatePitch = clamp((qe.x * k) / maxW, -1, 1);
      out.rotateYaw = clamp((qe.y * k) / maxW, -1, 1);
      out.rotateRoll = clamp((qe.z * k) / maxW, -1, 1);
      out.attitudeHold = true;
    }
    // 動かす: まとまりまでの距離を、主砲の射程の 45%（3〜15 km）に保つ（スロットルレバーを使っていなければ）
    if (Math.abs(input.thrustForward) < 0.02 && Math.abs(input.thrustStrafeX) < 0.05 && Math.abs(input.thrustStrafeY) < 0.05) {
      const mainRange = Math.max(...this.rig.mounts.map((m) => weaponRange(m.cfg)));
      const want = clamp(mainRange * 0.45, 3000, 15000);
      const vdes = clamp((dist - want) * 0.05, -150, 150);
      const dv = D.clone().multiplyScalar(vdes).sub(new THREE.Vector3(ship.velocity.x, ship.velocity.y, ship.velocity.z));
      const dvL = dv.applyQuaternion(new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w).invert());
      out.thrustForward = clamp(-dvL.z / 30, -1, 1);
      out.thrustStrafeX = clamp(dvL.x / 30, -1, 1);
      out.thrustStrafeY = clamp(dvL.y / 30, -1, 1);
    }
    return out;
  },
  // 目標の方向 D（今のフレームの座標）に、向けられる砲（口径で重みづけ）がいちばん多くなる艦の向き。
  //   今の上向きのまま左右に回す（15°おき）・少し上下に傾ける（−20°・0°・20°）中から選ぶ。同じくらいなら回す量の少ない方
  _bestManeuverQuat(ship, D) {
    const q0 = new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q0);
    // 砲塔の親の向き（艦に対して。砲塔は回っても親は回らない）
    const sq = new THREE.Quaternion();
    ship.mesh.getWorldQuaternion(sq);
    const sqi = sq.clone().invert();
    for (const m of this.rig.mounts) {
      const pq = new THREE.Quaternion();
      m.turret.parent.getWorldQuaternion(pq);
      m._qpInv = sqi.clone().multiply(pq).invert(); // 艦の座標 → 砲塔の親の座標
    }
    let best = null, bestScore = -Infinity;
    for (let yaw = -180; yaw < 180; yaw += 15) {
      for (const pitch of [-20, 0, 20]) {
        const qc = new THREE.Quaternion().setFromAxisAngle(up, toRadW(yaw)).multiply(q0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), toRadW(pitch)));
        const dS = D.clone().applyQuaternion(qc.clone().invert());
        let score = 0;
        for (const m of this.rig.mounts) {
          const d = dS.clone().applyQuaternion(m._qpInv);
          const upc = d.dot(m.U);
          const h = d.clone().addScaledVector(m.U, -upc);
          const yw = Math.atan2(m.U.dot(new THREE.Vector3().crossVectors(m.F, h)), m.F.dot(h));
          const el = Math.atan2(upc, h.length());
          const c = m.cfg;
          if (yw >= toRadW(c.yawMin) && yw <= toRadW(c.yawMax) && el >= toRadW(c.elevMin) && el <= toRadW(c.elevMax)) score += weaponDamage(c.type, c.caliber) * m.barrels.length;
        }
        score -= (Math.abs(yaw) / 180 + Math.abs(pitch) / 40) * 0.5; // 同じくらいなら回す量の少ない方
        if (score > bestScore) { bestScore = score; best = qc; }
      }
    }
    return best ? { x: best.x, y: best.y, z: best.z, w: best.w } : null;
  },
  // 自艦に当たった
  _hitShip(point, dmg) {
    const P = this.practice;
    if (!P || P.shipHP <= 0) return;
    P.shipHP = Math.max(0, P.shipHP - dmg);
    this._spark(point, 0xff7050, 26);
    if (P.shipHP <= 0) {
      this._flashStatus('大破しました（演習を終えます）');
      setTimeout(() => this.stopPractice(), 0);
    }
  },
  // 目標に当たった: 耐久を減らし、無くなったら壊れる（当たるたびに赤く焼ける）
  _damageTarget(t, dmg, point) {
    if (!t.alive) return;
    t.hp -= dmg;
    this._spark(point || t.pos, 0xffd090, 18);
    const f = clamp(1 - t.hp / t.hpMax, 0, 1);
    t.mat.emissive.setRGB(0.45 + 0.5 * f, 0.15 * (1 - f), 0.05);
    if (t.hp <= 0) this._destroyTarget(t);
  },
  _spark(p, color, size) {
    const ship = State.ship;
    const fmat = new THREE.PointsMaterial({ map: this._dotTexture(), color, size, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([p.x, p.y, p.z]), 3));
    const pts = new THREE.Points(fgeo, fmat);
    pts.frustumCulled = false;
    this._fx.add(pts);
    this._effects.push({ kind: 'flash', obj: pts, rel: { x: p.x - ship.position.x, y: p.y - ship.position.y, z: p.z - ship.position.z }, t: 0, life: 0.3, mats: [fmat] });
  },
  _destroyTarget(t) {
    if (!t.alive) return;
    t.alive = false;
    this.practice.alive--;
    this.practice.group.remove(t.mesh);
    // 小さな爆発（明るい点が広がって消える）
    const ship = State.ship;
    const fmat = new THREE.PointsMaterial({ map: this._dotTexture(), color: 0xffd090, size: 46, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([t.pos.x, t.pos.y, t.pos.z]), 3));
    const flash = new THREE.Points(fgeo, fmat);
    flash.frustumCulled = false;
    this._fx.add(flash);
    this._effects.push({ kind: 'flash', obj: flash, rel: { x: t.pos.x - ship.position.x, y: t.pos.y - ship.position.y, z: t.pos.z - ship.position.z }, t: 0, life: 0.6, mats: [fmat], boom: true });
    if (this.lock === t) {
      // 合わせていた目標を壊したら、近くに残っている目標（同じまとまりを先に）へ照準を合わせ直す
      let best = null, bestD = Infinity;
      for (const o of this.practice.targets) {
        if (!o.alive) continue;
        const d = o.pos.distanceTo(t.pos) * (o.group === t.group ? 1 : 3);
        if (d < bestD && d < 15000) { bestD = d; best = o; }
      }
      this.lock = best;
    }
    if (this.practice.alive === 0) {
      // v89: 全部壊したら、演習を切るまで次の波を出す
      const P = this.practice;
      this._flashStatus(`第${P.wave}波を全部撃ちました。次の波が来ます`);
      setTimeout(() => { if (this.practice === P) this.startPractice(true); }, 1500);
    }
  },
  // 基準のフレームが変わったとき（16-navigation.js switchFrame）: 目標の位置・速度を新しいフレームへ写す
  onFrameSwitch(oldF, newF, nav) {
    const P = this.practice;
    if (!P) return;
    const conv = (p) => { const u = nav.localToUniverse({ x: p.x, y: p.y, z: p.z }, oldF); const l = nav.universeToLocal(u, newF); return new THREE.Vector3(l.x, l.y, l.z); };
    for (const t of P.targets) {
      const np = conv(t.pos);
      const vu = Astro.mat3MulVec(oldF.rot, t.vel);
      const vo = nav._framePointVelocity(oldF, t.pos), vn = nav._framePointVelocity(newF, np);
      const v = Astro.mat3MulVec(newF.rotT, { x: vu.x + vo.x - vn.x, y: vu.y + vo.y - vn.y, z: vu.z + vo.z - vn.z });
      t.pos.copy(np); t.vel.set(v.x, v.y, v.z);
      t.mesh.position.copy(np);
    }
    const seen = new Set();
    for (const t of P.targets) if (!seen.has(t.center)) { seen.add(t.center); t.center.copy(conv(t.center)); }
  },
  // 照準の視点を見ている点（射撃レーダー、無ければ艦の中心）
  _viewOrigin() {
    const dir = this.rig && this.rig.directors[0];
    const v = new THREE.Vector3();
    if (dir) dir.node.getWorldPosition(v);
    else { const p = State.ship.position; v.set(p.x, p.y, p.z); }
    return v;
  },
  // 自動照準: 照準の視点に写っている目標のうち、照準（画面の中央）にいちばん近いものに合わせ、その目標を追う
  _updateLock() {
    if (!this._practiceOn() || !this.aim.active) { if (!this._practiceOn()) this.lock = null; return; }
    const o = this._viewOrigin();
    const dl = this.aimDirLocal();
    if (!dl) return;
    const D = new THREE.Vector3(dl.x, dl.y, dl.z);
    const cone = Math.PI / 2; // v89: 見ている方向の半球全体（中央から 90° まで）
    const angOf = (t) => Math.acos(clamp(t.pos.clone().sub(o).normalize().dot(D), -1, 1));
    if (this.lock && !this.lock.alive) this.lock = null;
    this._visibleTarget = null;
    {
      let best = null, bestA = cone;
      for (const t of this.practice.targets) { if (!t.alive) continue; const a = angOf(t); if (a < bestA) { bestA = a; best = t; } }
      this._visibleTarget = best;
      // v89: 見ている方向の半球に目標があれば自動で照準を合わせる（自分で照準を動かした直後の1.5秒は合わせない）
      if (!this.lock && best && !(this._noAutoLockUntil > this._time)) this.lock = best;
    }
    // 照準（狙う向き・画面の中央）を目標に合わせ続ける（照準の視点から戻っても）
    // v89: 目標が変わっても一気に切り替えず、カメラをパンするように滑らかに回して合わせる
    //   離れているほど速く（最大 約120°/s）、近づくと減速して止まる。合ったあとは目標の動きに付いていく
    if (this.lock) {
      const d = this.lock.pos.clone().sub(o).normalize();
      const ang = Math.acos(clamp(d.dot(D), -1, 1));
      let nd = d;
      const dt = Math.min(this._dt || 0, 0.1);
      if (ang > 1e-4 && dt > 0) {
        const step = Math.min(ang, Math.max(ang * (1 - Math.exp(-dt / this.PAN_TAU)), this.PAN_MIN_RATE * dt), this.PAN_MAX_RATE * dt);
        let axis = new THREE.Vector3().crossVectors(D, d);
        if (axis.lengthSq() < 1e-12) { axis = new THREE.Vector3().crossVectors(D, Math.abs(D.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)); }
        nd = D.clone().applyAxisAngle(axis.normalize(), step).normalize();
      }
      this.lockPanning = ang > 0.01;
      this.aim.dirU = this._toUniverse({ x: nd.x, y: nd.y, z: nd.z });
    } else this.lockPanning = false;
  },
  PAN_TAU: 0.3, // 照準のパンの滑らかさ [s]
  PAN_MIN_RATE: 0.08, // [rad/s] 最後まで止まらずに合わせ切るための最低の速さ
  PAN_MAX_RATE: 2.1, // [rad/s] 約120°/s
  // 見ている方向の半球の目標のうち、中央にいちばん近いものに照準を合わせる（テスト・ほかから呼ぶ用）
  lockNearest() {
    if (!this._visibleTarget) { this._updateLock(); }
    const t = this._visibleTarget;
    if (!t) return false;
    this.lock = t;
    this._updateLock();
    return true;
  },
  _groupMode(m) { const g = this._groupById && this._groupById.get(m.groupId); return g ? g.mode : 'off'; },
  // 偏差: 砲から目標を、その砲の弾が当たる向き（目標が動く分を先取り）。レーザーはまっすぐ
  _lead(m, t) {
    const ship = State.ship;
    const P = new THREE.Vector3();
    m.turret.getWorldPosition(P);
    const R = t.pos.clone().sub(P);
    if (m.cfg.kind === 'laser') return { dir: R.clone().normalize(), dist: R.length() };
    const s = weaponTypeInfo('kinetic', m.cfg.type).speed;
    const Vr = t.vel.clone().sub(new THREE.Vector3(ship.velocity.x, ship.velocity.y, ship.velocity.z));
    const a = Vr.dot(Vr) - s * s, b = 2 * R.dot(Vr), c = R.dot(R);
    let tt;
    if (Math.abs(a) < 1e-9) tt = -c / b;
    else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return { dir: R.clone().normalize(), dist: Infinity };
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
      tt = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
    }
    if (!(tt > 0) || !Number.isFinite(tt)) return { dir: R.clone().normalize(), dist: Infinity };
    const aimP = R.clone().addScaledVector(Vr, tt);
    return { dir: aimP.clone().normalize(), dist: aimP.length() };
  },
  // 線分 a→b が当たる目標（いちばん手前）
  _segmentHit(a, b) {
    const A = new THREE.Vector3(a.x, a.y, a.z), B = new THREE.Vector3(b.x, b.y, b.z);
    const AB = B.clone().sub(A), L2 = Math.max(1e-9, AB.lengthSq());
    let best = null, bestU = 2;
    for (const t of this.practice.targets) {
      if (!t.alive) continue;
      const u = clamp(t.pos.clone().sub(A).dot(AB) / L2, 0, 1);
      const r = t.size * 0.75;
      if (A.clone().addScaledVector(AB, u).distanceToSquared(t.pos) <= r * r && u < bestU) { bestU = u; best = t; }
    }
    return best;
  },
  // レーザーの光線（点 p から向き dir、長さ range）が当たる目標（いちばん手前）
  _laserHit(p, dir, range) {
    if (!this._practiceOn()) return null;
    let best = null;
    for (const t of this.practice.targets) {
      if (!t.alive) continue;
      const w = t.pos.clone().sub(p);
      const along = w.dot(dir);
      if (along < 0 || along > range) continue;
      const r = t.size * 0.75;
      if (w.lengthSq() - along * along <= r * r && (!best || along < best.along)) best = { t, along };
    }
    return best;
  },
  // この砲がこの目標を撃てるか（射程の中で、旋回範囲・仰角の範囲で向けられる）
  _canEngage(m, t) {
    if (!t || !t.alive) return false;
    const L = this._lead(m, t);
    if (!(L.dist <= weaponRange(m.cfg))) return false;
    const a = WeaponRig.aimAngles(m, L.dir), c = m.cfg;
    return a.yaw >= toRadW(c.yawMin) - 1e-6 && a.yaw <= toRadW(c.yawMax) + 1e-6 && a.elev >= toRadW(c.elevMin) - 1e-6 && a.elev <= toRadW(c.elevMax) + 1e-6;
  },
  _nearestEngageable(m, filter) {
    const list = this.practice.targets.filter((t) => t.alive && (!filter || filter(t))).sort((x, y) => x.distShip - y.distShip);
    for (const t of list) if (this._canEngage(m, t)) return t;
    return null;
  },
  // v89: 艦種の大きさ。大口径砲は大型艦（戦艦・重巡洋艦）を、小口径砲は中型〜小型（軽巡洋艦・駆逐艦・攻撃機）を優先して撃つ
  _isLargeTarget(t) { return t.cls === 'bb' || t.cls === 'ca'; },
  // 大口径砲: 主砲（いちばん大きな口径）の 7割以上、かつ 200 mm 以上。それ以外は小口径砲
  _isLargeGun(m) { return m.cfg.caliber >= Math.max(200, this._mainCaliber * 0.7) - 1e-6; },
  // 砲の目標を決める
  //   全門指向（ボタン）がオン: すべての砲が照準の目標へ
  //   手動の砲: 照準の目標
  //   自動射撃の砲:
  //     小口径砲 … 自分の射程の中に目標が入ってきたら、照準とは別に自分でそれを撃つ（中型〜小型を優先、近い順）
  //     そうでなければ、照準の目標が自分の得意な大きさで撃てればそれを。
  //     撃てなければ、得意な大きさの撃てる目標（近い順）、照準の目標、ほかの撃てる目標の順
  _chooseTarget(m) {
    const main = this.lock && this.lock.alive ? this.lock : null;
    const auto = this._groupMode(m) !== 'off';
    if (main && (this.focusAll || !auto)) return main;
    if (!auto) return main;
    // 向けたが射線が船体・ほかの砲に当たって撃てなかった目標は、この砲ではしばらく（3秒）選ばない
    if (m.target && m.state === 'blocked') {
      if (!m._badT) m._badT = new Map();
      m._badT.set(m.target, this._time + 3);
      m._nextPick = 0;
    }
    const ok = (t) => !(m._badT && m._badT.get(t) > this._time);
    const large = this._isLargeGun(m);
    const pref = (t) => (large ? this._isLargeTarget(t) : !this._isLargeTarget(t));
    const mainOk = main && ok(main) && this._canEngage(m, main);
    if (!m._nextPick || this._time >= m._nextPick) {
      m._nextPick = this._time + 0.4 + Math.random() * 0.2;
      const range = weaponRange(m.cfg);
      // 小口径砲の自衛: 射程の中に入ってきた目標
      m._near = large ? null : (this._nearestEngageable(m, (t) => ok(t) && pref(t) && t.distShip <= range) || this._nearestEngageable(m, (t) => ok(t) && t.distShip <= range));
      m._indep = mainOk && pref(main) ? null : (this._nearestEngageable(m, (t) => ok(t) && pref(t)) || (mainOk ? null : this._nearestEngageable(m, ok)));
    }
    if (m._near && m._near.alive && ok(m._near)) return m._near;
    if (mainOk && pref(main)) return main;
    if (m._indep && m._indep.alive && ok(m._indep) && pref(m._indep)) return m._indep;
    if (mainOk) return main;
    if (m._indep && m._indep.alive && ok(m._indep)) return m._indep;
    return main;
  },
  // 砲の狙う向き（ゲームの座標の単位ベクトル）。演習の目標が無ければ照準の向きそのまま
  _mountAimDir(m, D) {
    m.rangeOk = true;
    if (!this._practiceOn() || !this.aim.active) { m.target = null; return D; }
    const t = this._chooseTarget(m);
    m.target = t;
    if (!t) return D;
    const L = this._lead(m, t);
    m.rangeOk = L.dist <= weaponRange(m.cfg);
    return L.dir;
  },
  // v89: 全門指向（ボタン）: オンのあいだ、独立して別の目標を撃っていた砲も含めて、すべての砲を照準の目標へ向ける
  setFocusAll(on) {
    this.focusAll = !!on;
    if (this.rig) for (const m of this.rig.mounts) { m._indep = null; m._near = null; m._nextPick = 0; }
    this._syncUi();
  },

  // v89: レーザーは充電の途中でも撃てる（充電の割合 = 1 − 残り時間 / 充電時間。光線の太さがその割合になる）
  LASER_MIN_CHARGE: 0.05,
  _charge(m, i) { return clamp(1 - m.reloadLeft[i] / weaponReload(m.cfg), 0, 1); },
  // 装填の棒が一番上になる充電の割合: 自動射撃を「N%」にしているグループのレーザーは N%、それ以外は 1（満タン）
  _fullCharge(m) {
    if (m.cfg.kind !== 'laser' || !this.groups) return 1;
    const g = this.groups.find((x) => x.id === m.groupId);
    return g && g.mode === 'set' ? Math.max(this.LASER_MIN_CHARGE, g.power / 100) : 1;
  },
  // minCharge: レーザーの撃てる充電の割合（省略時は LASER_MIN_CHARGE）。実弾砲は装填が済んでいること
  _canFireBarrel(m, i, minCharge) {
    if (!m.onTarget || (m.blocked && m.blocked[i]) || m.rangeOk === false) return false;
    // v89: 演習中は、照準が合っていても撃つ目標が無ければ撃たない
    if (this._practiceOn() && !(m.target && m.target.alive)) return false;
    if (m.cfg.kind === 'laser') return this._charge(m, i) >= Math.max(this.LASER_MIN_CHARGE, (minCharge ?? 0) - 1e-9);
    return m.reloadLeft[i] <= 0;
  },
  _shoot(m, b, i) {
    const power = m.cfg.kind === 'laser' ? this._charge(m, i) : 1;
    m.reloadLeft[i] = weaponReload(m.cfg);
    this._spawnShot(State.ship, m, b, power);
  },
  // 一門ずつ: 前に撃った砲身の次から順に探して、撃てる砲身を1つ撃つ
  fireOne() {
    if (!this.rig) return 0;
    const order = this._firingOrder();
    const start = this._lastShot ? order.findIndex((e) => e.m === this._lastShot.m && e.i === this._lastShot.i) + 1 : 0;
    for (let k = 0; k < order.length; k++) {
      const e = order[(start + k) % order.length];
      if (!this._canFireBarrel(e.m, e.i)) continue;
      this._shoot(e.m, e.b, e.i);
      this._lastShot = { m: e.m, i: e.i };
      return 1;
    }
    return 0;
  },
  // 一斉射撃: 撃てる砲身を全部
  fire() {
    if (!this.rig) return 0;
    const ship = State.ship;
    let n = 0;
    for (const m of this.rig.mounts) {
      m.barrels.forEach((b, i) => {
        if (!this._canFireBarrel(m, i)) return;
        this._shoot(m, b, i);
        n++;
      });
    }
    return n;
  },

  _barrelMuzzle(m, b, pivot) {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion();
    b.node.getWorldPosition(pos);
    b.node.getWorldQuaternion(q);
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
    if (pivot) return { pos, dir };
    // 砲口: 砲身の付け根から、モデルで測った砲身の長さの先（測れなければ「口径の45倍」）
    const len = b.length > 0 ? b.length : (m.cfg.caliber / 1000) * 45;
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
  // power: レーザーの充電の割合（0〜1。光線の太さ・明るさ）
  _spawnShot(ship, m, b, power) {
    const pw = power === undefined ? 1 : clamp(power, 0, 1);
    const { pos, dir } = this._barrelMuzzle(m, b);
    const rel = { x: pos.x - ship.position.x, y: pos.y - ship.position.y, z: pos.z - ship.position.z };
    const size = (CameraSystem._shipScale || 1) * 8;
    const dmg = weaponDamage(m.cfg.type, m.cfg.caliber, pw);
    if (m.cfg.kind === 'laser') {
      const info = weaponTypeInfo('laser', m.cfg.type);
      // v89: 射程まで届く（演習の目標に当たれば、そこで止まって目標の耐久を減らす）
      let len = Math.min(weaponRange(m.cfg), 5e7);
      const hit = this._laserHit(pos, dir, weaponRange(m.cfg));
      if (hit) { len = hit.along; this._damageTarget(hit.t, dmg, pos.clone().addScaledVector(dir, hit.along)); }
      const r = Math.max((m.cfg.caliber / 1000) * 1.5, size * 0.0015) * Math.max(0.12, pw); // 充電の途中で撃つと細い
      // レーザーは砲身に付いたまま（撃っている間、砲の向きに沿う）
      this._spawnBeamFx(pos, dir, len, r, new THREE.Color(m.cfg.color), info.beamTime, { mount: m, barrel: b }, 0.9 * (0.5 + 0.5 * pw));
    } else {
      const info = weaponTypeInfo('kinetic', m.cfg.type);
      const v = new THREE.Vector3(ship.velocity.x, ship.velocity.y, ship.velocity.z).addScaledVector(dir, info.speed);
      // 砲口の閃光
      const fmat = new THREE.PointsMaterial({ map: this._dotTexture(), color: 0xffe0a0, size: clamp(m.cfg.caliber / 25, 6, 28), sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([pos.x, pos.y, pos.z]), 3));
      const flash = new THREE.Points(fgeo, fmat);
      flash.frustumCulled = false;
      this._fx.add(flash);
      this._effects.push({ kind: 'flash', obj: flash, rel: { ...rel }, t: 0, life: 0.12, mats: [fmat] });
      // v89: 射程まで飛ぶ（長すぎる射程は見た目のため 300 秒まで）
      this._spawnShellFx(pos, v, info.tracer, clamp(m.cfg.caliber / 60, 3, 9), Math.min(300, weaponRange(m.cfg) / info.speed), { dmg });
    }
  },
  // 光線の見た目。follow（{ mount, barrel }）があれば砲身に付いて動く。撃った瞬間から pos に置く
  //   （以前は次の更新まで座標の原点にあり、原点から出た光線が描かれることがあった）
  _spawnBeamFx(pos, dir, len, r, color, life, follow, base) {
    const geo = new THREE.CylinderGeometry(r, r, len, 8, 1, true);
    geo.translate(0, len / 2, 0);
    const op = base === undefined ? 0.9 : base;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false });
    const beam = new THREE.Mesh(geo, mat);
    const core = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, len, 0)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const g = new THREE.Group();
    g.add(beam); g.add(core);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.position.copy(pos);
    g.frustumCulled = false; beam.frustumCulled = false; core.frustumCulled = false;
    this._fx.add(g);
    this._effects.push({ kind: 'beam', obj: g, mount: follow ? follow.mount : null, barrel: follow ? follow.barrel : null, t: 0, life, mats: [mat, core.material], base: op });
  },
  // 弾（曳光弾）の見た目と動き。vAbs: 今のフレームの座標での弾の速度。extra: { dmg, enemy }
  //   弾は艦からの相対位置で持つ（艦の位置の付け替え〈原点の移動〉で弾が跳ばないように）
  _spawnShellFx(pos, vAbs, color, ptSize, life, extra) {
    const ship = State.ship;
    const rel = { x: pos.x - ship.position.x, y: pos.y - ship.position.y, z: pos.z - ship.position.z };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([pos.x, pos.y, pos.z, pos.x, pos.y, pos.z]), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    const pmat = new THREE.PointsMaterial({ map: this._dotTexture(), color, size: ptSize, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([pos.x, pos.y, pos.z]), 3));
    const pt = new THREE.Points(pgeo, pmat);
    line.frustumCulled = false; pt.frustumCulled = false;
    this._fx.add(line); this._fx.add(pt);
    this._effects.push({ kind: 'shell', line, pt, rel, v: { x: vAbs.x, y: vAbs.y, z: vAbs.z }, t: 0, life, mats: [mat, pmat], last: null, dmg: (extra && extra.dmg) || 0, enemy: !!(extra && extra.enemy) });
  },
  _updateEffects(dt) {
    const ship = State.ship;
    if (!this._effects.length || !ship) return;
    if (typeof Navigation !== 'undefined' && Navigation.isWarping && Navigation.isWarping()) { this._clearEffects(); return; }
    const keep = [];
    // 途中で増える効果（目標の爆発など）は、この下で this._effects に足される
    const list = this._effects;
    this._effects = [];
    for (const e of list) {
      e.t += dt;
      const k = 1 - e.t / e.life;
      if (k <= 0) { this._disposeEffect(e); continue; }
      if (e.kind === 'beam') {
        if (e.mount) {
          const { pos, dir } = this._barrelMuzzle(e.mount, e.barrel);
          e.obj.position.copy(pos);
          e.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        }
        e.mats[0].opacity = (e.base ?? 0.9) * Math.min(1, k * 3);
        e.mats[1].opacity = Math.min(1, k * 3);
      } else if (e.kind === 'flash') {
        const a = e.obj.geometry.attributes.position;
        a.setXYZ(0, ship.position.x + e.rel.x, ship.position.y + e.rel.y, ship.position.z + e.rel.z);
        a.needsUpdate = true;
        e.mats[0].opacity = k;
        if (e.boom) e.mats[0].size = 46 + (1 - k) * 60; // 爆発は広がって消える
      } else {
        e.rel.x += (e.v.x - ship.velocity.x) * dt;
        e.rel.y += (e.v.y - ship.velocity.y) * dt;
        e.rel.z += (e.v.z - ship.velocity.z) * dt;
        const p = { x: ship.position.x + e.rel.x, y: ship.position.y + e.rel.y, z: ship.position.z + e.rel.z };
        // v89: 演習の目標に当たったか（このフレームに進んだ線分と、目標の球）
        if (this.practice && e.last) {
          if (e.enemy) {
            // 目標の弾: 自艦の船体に当たったか
            const hp = WeaponRig.segmentHitsGrid(this._occ, new THREE.Vector3(e.last.x, e.last.y, e.last.z), new THREE.Vector3(p.x, p.y, p.z));
            if (hp) { this._hitShip(hp, e.dmg); this._disposeEffect(e); continue; }
          } else if (this._practiceOn()) {
            const t = this._segmentHit(e.last, p);
            if (t) { this._damageTarget(t, e.dmg, new THREE.Vector3(p.x, p.y, p.z)); this._disposeEffect(e); continue; }
          }
        }
        e.last = p;
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
    this._effects = keep.concat(this._effects);
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
      <div class="wpn-groups"></div>
      <select class="wpn-difficulty" title="演習の難易度"></select>
      <button type="button" class="wpn-btn wpn-practice">演習</button>
      <div class="wpn-hp"><div class="wpn-hp-fill"></div><span class="wpn-hp-text"></span></div>
      <button type="button" class="wpn-btn wpn-maneuver">自動操艦</button>
      <button type="button" class="wpn-btn wpn-focus" title="オン: すべての砲を照準の目標へ向ける／オフ: 自動射撃の砲は艦種や距離で自分の目標を選ぶ">全門指向</button>
      <button type="button" class="wpn-btn wpn-fire">撃て</button>
      <button type="button" class="wpn-btn wpn-view">照準</button>
      <button type="button" class="wpn-btn wpn-stop">照準やめ</button>`;
    document.body.appendChild(box);
    const reticle = document.createElement('div');
    reticle.className = 'wpn-reticle';
    document.body.appendChild(reticle);
    const marks = document.createElement('div');
    marks.className = 'wpn-gunmarks';
    document.body.appendChild(marks);
    const chips = document.createElement('div');
    chips.className = 'wpn-chips';
    document.body.appendChild(chips);
    const hint = document.createElement('div');
    hint.className = 'wpn-hint';
    hint.innerHTML = '<span class="wpn-zoom"></span>　画面をドラッグして狙う方向を決めます・ピンチで拡大（「照準」をもう一度押すと元の視点へ。狙いは続けます）';
    document.body.appendChild(hint);
    const stop = (e) => { e.stopPropagation(); };
    box.addEventListener('touchstart', stop, { passive: true });
    box.querySelector('.wpn-view').addEventListener('click', () => this.setView(!this.view));
    box.querySelector('.wpn-stop').addEventListener('click', () => this.stopAim());
    // 1回押すと一門ずつ（砲塔の番号順・砲の番号順）、素早く続けて押すと一斉射撃
    let lastPress = 0;
    box.querySelector('.wpn-fire').addEventListener('click', () => {
      const now = performance.now();
      const rapid = now - lastPress < this.SALVO_TAP_MS;
      lastPress = now;
      const n = rapid ? this.fire() : this.fireOne();
      if (rapid && n) this._flashStatus(`一斉射撃 ${n}門`);
      if (!n) this._flashStatus(this.aim.active ? '撃てる砲がありません（旋回中・装填中・範囲外）' : '先に「照準」で狙ってください');
    });
    const tmarks = document.createElement('div');
    tmarks.className = 'wpn-tmarks';
    document.body.appendChild(tmarks);
    // v89: 難易度（演習モードだけ。選んだものを覚えておく）
    const dsel = box.querySelector('.wpn-difficulty');
    for (const [k, d] of Object.entries(PRACTICE_DIFFICULTIES)) dsel.appendChild(new Option(`難易度: ${d.label}`, k));
    try { this.difficulty = localStorage.getItem('spaceSimPracticeDifficulty') || 'normal'; } catch (e) { this.difficulty = 'normal'; }
    if (!PRACTICE_DIFFICULTIES[this.difficulty]) this.difficulty = 'normal';
    dsel.value = this.difficulty;
    dsel.addEventListener('change', () => {
      this.difficulty = dsel.value;
      try { localStorage.setItem('spaceSimPracticeDifficulty', this.difficulty); } catch (e) { /* ignore */ }
    });
    box.querySelector('.wpn-practice').addEventListener('click', () => {
      if (this.practice) { this.stopPractice(); this._flashStatus('演習をやめました'); } else this.startPractice();
    });
    box.querySelector('.wpn-maneuver').addEventListener('click', () => {
      this.autoManeuver = !this.autoManeuver;
      this._mvQ = null;
      this._flashStatus(this.autoManeuver ? '自動操艦: 目標の多い方へ、撃てる砲の多い向きに回します' : '自動操艦を切りました');
      this._syncUi();
    });
    box.querySelector('.wpn-focus').addEventListener('click', () => {
      this.setFocusAll(!this.focusAll);
      this._flashStatus(this.focusAll ? '全門指向: すべての砲を照準の目標へ向けます' : '全門指向を切りました（自動射撃の砲は自分で目標を選びます）');
    });
    this._ui = { box, tmarks, dsel, hp: box.querySelector('.wpn-hp'), hpFill: box.querySelector('.wpn-hp-fill'), hpText: box.querySelector('.wpn-hp-text'), maneuverBtn: box.querySelector('.wpn-maneuver'), practice: box.querySelector('.wpn-practice'), focusBtn: box.querySelector('.wpn-focus'), groups: box.querySelector('.wpn-groups'), reticle, marks, chips, hint, zoom: hint.querySelector('.wpn-zoom'), status: box.querySelector('.wpn-status'), view: box.querySelector('.wpn-view'), stop: box.querySelector('.wpn-stop'), fire: box.querySelector('.wpn-fire') };
    this._syncUi();
  },
  // 砲塔ごとの小さな照準マーク（照準の視点）と、下の番号（装填・指向の状態）
  _buildMountUi() {
    const u = this._ui;
    if (!u) return;
    u.chips.innerHTML = '';
    u.marks.innerHTML = '';
    if (!this.rig) return;
    const sorted = [...this.rig.mounts].sort((a, b) => a.num - b.num);
    for (const m of sorted) {
      // 番号の上に、砲身ごとの装填の棒（下から緑で埋まる）
      const col = document.createElement('div');
      col.className = 'wpn-chipcol';
      const bars = document.createElement('div');
      bars.className = 'wpn-bars';
      m._bars = m.barrels.map((b, i) => ({ b, i })).sort((x, y) => x.b.num - y.b.num).map(({ i }) => {
        const bar = document.createElement('div');
        bar.className = 'wpn-bar';
        const fill = document.createElement('div');
        fill.className = 'wpn-bar-fill';
        bar.appendChild(fill);
        bars.appendChild(bar);
        return { i, bar, fill, last: -1 };
      });
      const chip = document.createElement('div');
      chip.className = 'wpn-chip st-none';
      chip.textContent = String(m.num);
      chip.title = m.key;
      col.appendChild(bars);
      col.appendChild(chip);
      u.chips.appendChild(col);
      m._chip = chip;
      // v89: 番号を押すと、その砲から見る視点に（もう一度押すとレーダーから）
      col.addEventListener('click', () => {
        this._viewMount = this._viewMount === m ? null : m;
        if (!this.view) this.setView(true);
        for (const x of this.rig.mounts) if (x._chip) x._chip.classList.toggle('viewing', x === this._viewMount);
        this._flashStatus(this._viewMount ? `${m.num}番（${m.key}）の砲口から見ています` : '射撃レーダーから見ています');
      });
      const mk = document.createElement('div');
      mk.className = 'wpn-gunmark st-none';
      mk.innerHTML = `<span>${m.num}</span>`;
      u.marks.appendChild(mk);
      m._mark = mk;
    }
  },
  // グループごとの自動射撃の入れ・切り（「撃て」の上）
  _buildGroupUi() {
    const u = this._ui;
    if (!u) return;
    u.groups.innerHTML = '';
    for (const g of this.groups || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `wpn-btn wpn-auto${g.mode !== 'off' ? ' active' : ''}`;
      b.innerHTML = `<span class="wpn-auto-name"></span><span class="wpn-auto-state"></span>`;
      b.querySelector('.wpn-auto-name').textContent = g.name;
      const label = () => (g.mode === 'off' ? '自動 切' : g.mode === 'max' ? '自動 最大' : `自動 ${g.power}%`);
      const sync = () => { b.classList.toggle('active', g.mode !== 'off'); b.querySelector('.wpn-auto-state').textContent = label(); };
      sync();
      // 押すたびに 切 → 最大 → 設定した出力（レーザーのあるグループだけ） → 切
      b.addEventListener('click', () => {
        g.mode = g.mode === 'off' ? 'max' : g.mode === 'max' && g.hasLaser ? 'set' : 'off';
        sync();
        this._flashStatus(`${g.name}: ${g.mode === 'off' ? '自動射撃を切りました' : g.mode === 'max' ? '自動射撃（最大の出力で）' : `自動射撃（出力 ${g.power}% で）`}`);
      });
      u.groups.appendChild(b);
    }
  },
  _buildTargetMarkers() {
    const u = this._ui;
    if (!u || !this.practice) return;
    u.tmarks.innerHTML = '';
    // v89: 目標のまとまりごとの橙の枠と、画面の外なら端の矢印（自動航行の目的地と同じ見た目）
    this.practice.clusters = [];
    for (let gi = 0; gi < this.PRACTICE_GROUPS; gi++) {
      const frame = document.createElement('div');
      frame.className = 'space-target-marker wpn-cluster';
      frame.innerHTML = '<div class="stm-corner tl"></div><div class="stm-corner tr"></div><div class="stm-corner bl"></div><div class="stm-corner br"></div><div class="stm-text"></div>';
      const arrow = document.createElement('div');
      arrow.className = 'space-target-arrow wpn-cluster-arrow';
      arrow.textContent = '➤';
      u.tmarks.appendChild(frame);
      u.tmarks.appendChild(arrow);
      this.practice.clusters.push({ gi, frame, text: frame.querySelector('.stm-text'), arrow, name: `目標群${'ABCDEFGH'[gi]}` });
    }
    for (const t of this.practice.targets) {
      const el = document.createElement('div');
      el.className = `wpn-tmark${t.moving ? ' moving' : ''}`;
      u.tmarks.appendChild(el);
      t.el = el;
    }
  },
  _placeTargetMarks(cam) {
    if (!this.practice) return;
    const v = new THREE.Vector3();
    const W = window.innerWidth, H = window.innerHeight;
    // まとまりの枠: 生き残っている目標を囲む（画面の外なら、まとまりの中心の向きに端の矢印）
    const camQ = cam.quaternion.clone().invert();
    for (const c of this.practice.clusters || []) {
      const alive = this.practice.targets.filter((t) => t.group === c.gi && t.alive);
      if (!alive.length) { c.frame.style.display = 'none'; c.arrow.style.display = 'none'; continue; }
      const center = alive.reduce((a, t) => a.add(t.pos), new THREE.Vector3()).multiplyScalar(1 / alive.length);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, inView = 0;
      for (const t of alive) {
        v.copy(t.pos).project(cam);
        if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
        inView++;
        const sx = ((v.x + 1) / 2) * W, sy = ((1 - v.y) / 2) * H;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      const dist = center.distanceTo(cam.position);
      if (inView) {
        const pad = 14;
        c.frame.style.display = 'block';
        c.frame.style.width = `${Math.max(26, x1 - x0 + pad * 2)}px`;
        c.frame.style.height = `${Math.max(26, y1 - y0 + pad * 2)}px`;
        c.frame.style.transform = `translate(${Math.round(Math.min(x0 - pad, (x0 + x1) / 2 - 13))}px, ${Math.round(Math.min(y0 - pad, (y0 + y1) / 2 - 13))}px)`;
        c.text.textContent = `${c.name} 残り${alive.length} ${dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m'}`;
        c.arrow.style.display = 'none';
      } else {
        c.frame.style.display = 'none';
        const rel = center.clone().sub(cam.position).applyQuaternion(camQ); // カメラから見た向き（-Z が前）
        const ang = Math.atan2(-rel.y, rel.x);
        const r = Math.min(W, H) * 0.42;
        c.arrow.style.display = 'block';
        c.arrow.style.transform = `translate(${Math.round(W / 2 + Math.cos(ang) * r - 10)}px, ${Math.round(H / 2 + Math.sin(ang) * r - 10)}px) rotate(${ang}rad)`;
      }
    }
    for (const t of this.practice.targets) {
      const el = t.el;
      if (!el) continue;
      if (!t.alive) { el.style.display = 'none'; continue; }
      v.copy(t.pos).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.left = `${((v.x + 1) / 2) * W}px`;
      el.style.top = `${((1 - v.y) / 2) * H}px`;
      el.classList.toggle('locked', t === this.lock);
    }
  },
  _placeGunMarks(cam) {
    if (!this.rig) return;
    const q = new THREE.Quaternion(), v = new THREE.Vector3();
    const W = window.innerWidth, H = window.innerHeight;
    for (const m of this.rig.mounts) {
      const mk = m._mark;
      if (!mk) continue;
      if (m.mode === 'none') { mk.style.display = 'none'; continue; }
      m.barrels[0].node.getWorldQuaternion(q);
      v.set(0, 1, 0).applyQuaternion(q);
      v.multiplyScalar(1e4).add(cam.position).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { mk.style.display = 'none'; continue; }
      mk.style.display = '';
      mk.style.left = `${((v.x + 1) / 2) * W}px`;
      mk.style.top = `${((1 - v.y) / 2) * H}px`;
    }
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
    if (u.focusBtn) { u.focusBtn.style.display = this.aim.active ? '' : 'none'; u.focusBtn.classList.toggle('active', !!this.focusAll); }
    if (u.maneuverBtn) { u.maneuverBtn.style.display = this.practice ? '' : 'none'; u.maneuverBtn.classList.toggle('active', !!this.autoManeuver); }
    if (u.hp) u.hp.style.display = this.practice ? '' : 'none';
    // v89: 演習は演習モード（index.html?mode=practice）だけ
    if (u.practice) { u.practice.style.display = PRACTICE_MODE ? '' : 'none'; u.practice.textContent = this.practice ? '演習をやめる' : '演習開始'; u.practice.classList.toggle('active', !!this.practice); }
    if (u.dsel) u.dsel.style.display = PRACTICE_MODE && !this.practice ? '' : 'none';
    if (u.tmarks) u.tmarks.style.display = has && this.view && this.practice ? '' : 'none';
    u.fire.style.display = this.aim.active ? '' : 'none';
    u.reticle.style.display = has && this.view ? '' : 'none';
    u.marks.style.display = has && this.view ? '' : 'none';
    u.chips.style.display = has && this.aim.active ? '' : 'none';
    u.hint.style.display = has && this.view ? '' : 'none';
    document.body.classList.toggle('weapon-aim-view', has && this.view);
    this._updateUiState();
  },
  _updateUiState() {
    const u = this._ui;
    if (!u || !this.rig) return;
    const s = this._status || { aimed: 0, ready: 0, total: this.rig.mounts.length };
    let text = this.aim.active ? `指向 ${s.aimed}/${s.total}基・発射可 ${s.ready}基` : `砲塔 ${s.total}基`;
    if (this.practice) {
      const P = this.practice;
      text += `・${PRACTICE_DIFFICULTIES[P.difficulty] ? PRACTICE_DIFFICULTIES[P.difficulty].label : ''} 第${P.wave}波 残り ${P.alive}/${P.total}`;
      const f = clamp(P.shipHP / P.shipHPMax, 0, 1);
      if (u.hpFill) { u.hpFill.style.width = `${(f * 100).toFixed(1)}%`; u.hpFill.style.background = f > 0.5 ? '#3dff6e' : f > 0.25 ? '#ffd84a' : '#ff4a3a'; }
      if (u.hpText) u.hpText.textContent = `耐久 ${Math.ceil(f * 100)}%`;
    }
    if (this._statusOverride && performance.now() < this._statusOverride.until) text = this._statusOverride.text;
    if (u.status.textContent !== text) u.status.textContent = text;
    u.fire.disabled = !(s.ready > 0);
    for (const m of this.rig.mounts) {
      const st = this.aim.active ? m.state : 'none';
      if (m._chip && m._lastState !== st) {
        m._lastState = st;
        m._chip.className = `wpn-chip st-${st}`;
        if (m._mark) m._mark.className = `wpn-gunmark st-${st}`;
      }
      // 砲身ごとの装填の棒: 砲身の状態の色で、装填の済んだ割合だけ下から伸びる
      const rt = weaponReload(m.cfg);
      for (const bb of m._bars || []) {
        // 自動射撃を「N%」にしているレーザーは、N% で一番上まで（その割合まで溜まったら撃つので）
        const k = Math.round(clamp((1 - m.reloadLeft[bb.i] / rt) / this._fullCharge(m), 0, 1) * 100);
        if (k !== bb.last) { bb.last = k; bb.fill.style.height = `${k}%`; }
        const bst = this.aim.active && m.barrelStates ? m.barrelStates[bb.i] : 'none';
        if (bst !== bb.lastSt) { bb.lastSt = bst; bb.bar.className = `wpn-bar st-${bst}`; }
      }
    }
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
    // v89: 射程（数値と単位）
    for (const [k, u] of Object.entries(WEAPON_RANGE_UNITS)) $('wpnRangeUnit').appendChild(new Option(u.label, k));
    $('wpnRange').addEventListener('change', () => this._edit((m) => {
      const v = Number($('wpnRange').value);
      m.range = $('wpnRange').value === '' || !(v > 0) ? null : v * WEAPON_RANGE_UNITS[m.rangeUnit].m;
    }));
    $('wpnRangeUnit').addEventListener('change', () => this._edit((m) => { m.rangeUnit = $('wpnRangeUnit').value; }));
    $('wpnColor').addEventListener('input', () => this._edit((m) => { m.color = $('wpnColor').value; }));
    // v89: 砲塔・射撃レーダーのプルダウン
    $('wpnPartSel').addEventListener('change', () => {
      const v = $('wpnPartSel').value;
      const i = v.indexOf(':');
      if (i > 0) this._select(v.slice(0, i), v.slice(i + 1));
    });
    // v89: グループ
    $('wpnGroupSel').addEventListener('change', () => this._edit((m) => { m.group = $('wpnGroupSel').value; }));
    $('wpnGroupName').addEventListener('change', () => this._editGroup((g) => { g.name = $('wpnGroupName').value.trim().slice(0, 20) || g.name; }));
    $('wpnGroupAuto').addEventListener('change', () => this._editGroup((g) => { g.autoFire = $('wpnGroupAuto').checked; }));
    $('wpnGroupPower').addEventListener('change', () => this._editGroup((g) => { const v = Number($('wpnGroupPower').value); if (v >= 1) g.autoPower = Math.min(100, Math.round(v)); }));
    $('wpnGroupElevBtn').addEventListener('click', () => {
      const g = this._currentGroup();
      if (!g) return;
      const lo = Number($('wpnGroupElevMin').value), hi = Number($('wpnGroupElevMax').value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || $('wpnGroupElevMin').value === '' || $('wpnGroupElevMax').value === '') return;
      const d = this._opts.getDesign();
      for (const m of this._groupMounts(g.id)) {
        const c = weaponMountConfigFor(d.weapons, m.key);
        c.elevMin = Math.min(lo, hi); c.elevMax = Math.max(lo, hi);
        d.weapons.mounts[m.key] = normalizeWeaponMount(c);
      }
      this._opts.onChange();
      this.refresh();
    });
    const addGroup = (asChild) => {
      const d = this._opts.getDesign();
      const n = d.weapons.groups.reduce((mx, g) => Math.max(mx, Number(/^g(\d+)$/.exec(g.id)?.[1] || 0)), 0) + 1;
      const parent = asChild ? this._selGroup : null;
      const g = { id: `g${n}`, name: `グループ${n}`, autoFire: false, autoPower: 50, parent };
      d.weapons.groups.push(g);
      this._selGroup = g.id;
      // 選んでいる砲塔があれば、新しいグループへ移す
      const part = this._findSel();
      if (part && part.kind === 'mount') { const c = weaponMountConfigFor(d.weapons, part.key); c.group = g.id; d.weapons.mounts[part.key] = c; }
      this._opts.onChange();
      this.refresh();
    };
    $('wpnGroupAddBtn').addEventListener('click', () => addGroup(false));
    $('wpnGroupAddChildBtn').addEventListener('click', () => addGroup(true));
    // v89: 親のグループ（既存のグループを、ほかのグループの中へ入れられる）
    $('wpnGroupParent').addEventListener('change', () => this._editGroup((g) => { g.parent = $('wpnGroupParent').value || null; }));
    $('wpnGroupDelBtn').addEventListener('click', () => {
      const d = this._opts.getDesign();
      const g = this._currentGroup();
      if (!g || d.weapons.groups.length <= 1) return;
      if (!confirm(`グループ「${g.name}」を消しますか？（中の砲塔・グループは、${g.parent ? '親のグループ' : '名前から決まるグループ'}へ移ります）`)) return;
      d.weapons.groups = d.weapons.groups.filter((x) => x.id !== g.id);
      for (const x of d.weapons.groups) if (x.parent === g.id) x.parent = g.parent || null;
      for (const m of this._rig.mounts) {
        const c = weaponMountConfigFor(d.weapons, m.key);
        if (c.group === g.id) { c.group = g.parent || null; d.weapons.mounts[m.key] = c; }
      }
      this._selGroup = null;
      this._opts.onChange();
      this.refresh();
    });
    $('wpnApplyGroupBtn').addEventListener('click', () => {
      const cur = this._currentMountCfg();
      if (!cur) return;
      const d = this._opts.getDesign();
      for (const m of this._groupMounts(cur.group)) {
        const c = weaponMountConfigFor(d.weapons, m.key);
        Object.assign(c, { kind: cur.kind, type: cur.type, caliber: cur.caliber, reload: cur.reload, color: cur.color, traverseRate: cur.traverseRate, elevRate: cur.elevRate, range: cur.range, rangeUnit: cur.rangeUnit });
        d.weapons.mounts[m.key] = c;
      }
      this._opts.onChange();
      this.refresh();
    });
    $('wpnApplyAllBtn').addEventListener('click', () => {
      const cur = this._currentMountCfg();
      if (!cur) return;
      const d = this._opts.getDesign();
      for (const m of this._rig.mounts) {
        const c = weaponMountConfigFor(d.weapons, m.key);
        Object.assign(c, { kind: cur.kind, type: cur.type, caliber: cur.caliber, reload: cur.reload, color: cur.color, traverseRate: cur.traverseRate, elevRate: cur.elevRate, range: cur.range, rangeUnit: cur.rangeUnit });
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
    // 欄を閉じたらマークを消す
    const sec = $('weaponSection');
    if (sec) sec.addEventListener('toggle', () => this._rebuildMarks());
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
    return weaponMountConfigFor(this._opts.getDesign().weapons, part.key);
  },
  _edit(fn) {
    const part = this._findSel();
    if (!part || part.kind !== 'mount') return;
    const d = this._opts.getDesign();
    const c = weaponMountConfigFor(d.weapons, part.key);
    fn(c);
    d.weapons.mounts[part.key] = normalizeWeaponMount(c);
    this._opts.onChange();
    this.refresh();
  },
  _currentGroup() {
    const d = this._opts.getDesign();
    return (d.weapons.groups || []).find((g) => g.id === this._selGroup) || null;
  },
  // グループ id の砲塔（中のグループの砲塔も含む）
  _groupMounts(id) {
    const d = this._opts.getDesign();
    const ids = weaponGroupAndDescendants(d.weapons, id);
    return this._rig.mounts.filter((m) => ids.has(weaponMountConfigFor(d.weapons, m.key).group));
  },
  // 表示の順（親の次にその中のグループ）と深さ
  _groupTree(groups) {
    const out = [];
    const ids = new Set(groups.map((g) => g.id));
    const visit = (g, depth) => {
      if (out.some((x) => x.g === g) || depth > 8) return;
      out.push({ g, depth });
      for (const c of groups) if (c.parent === g.id) visit(c, depth + 1);
    };
    for (const g of groups) if (!g.parent || !ids.has(g.parent)) visit(g, 0);
    for (const g of groups) if (!out.some((x) => x.g === g)) out.push({ g, depth: 0 }); // 輪になっていたら最上位として出す
    return out;
  },
  _editGroup(fn) {
    const g = this._currentGroup();
    if (!g) return;
    fn(g);
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
    this._rebuildMarks();
  },
  _select(kind, key) {
    if (this._rig) WeaponRig.restoreAll(this._rig);
    this._sel = { kind, key };
    this.$('wpnTestYaw').value = '0'; this.$('wpnTestElev').value = '0'; this.$('dirTestYaw').value = '0';
    this.refresh();
    this._applyTest();
  },

  refresh() {
    this._refreshUi();
    this._rebuildMarks();
  },
  _refreshUi() {
    const $ = this.$;
    const design = this._opts.getDesign();
    if (!design || !$) return;
    design.weapons = normalizeShipWeapons(design.weapons);
    const rig = this._ensureRig();
    const has = rig.mounts.length + rig.directors.length > 0;
    $('wpnFound').textContent = !this._rigRoot
      ? 'モデルを読み込むと、モデルの中の砲塔・射撃レーダーを見つけて設定できます。'
      : has ? `砲塔 ${rig.mounts.length}基（砲身 ${rig.mounts.reduce((s, m) => s + m.barrels.length, 0)}門）・射撃レーダー／測距儀 ${rig.directors.length}基` : 'モデルの中に砲塔（名前に「砲塔」を含む部品）が見つかりません。';
    // v89: グループ（全部の砲塔がどれかに入るように）
    const groups = rig.mounts.length ? ensureWeaponGroups(design.weapons, rig.mounts.map((m) => m.key)) : [];
    const selPart0 = this._findSel();
    const locked = this._groupLocked; // 砲塔の無いグループを選んだところ
    this._groupLocked = false;
    if (selPart0 && selPart0.kind === 'mount' && !locked) this._selGroup = weaponMountConfigFor(design.weapons, selPart0.key).group;
    if (!groups.some((g) => g.id === this._selGroup)) this._selGroup = groups.length ? groups[0].id : null;
    const gl = $('wpnGroupList');
    gl.innerHTML = '';
    const tree = this._groupTree(groups);
    // 最上位のグループごとに1行（その中のグループは同じ行に続ける）
    let row = null;
    for (const { g, depth } of tree) {
      if (depth === 0 || !row) {
        row = document.createElement('div');
        row.className = 'grp-row';
        gl.appendChild(row);
      }
      const b = document.createElement('button');
      b.type = 'button';
      const n = this._groupMounts(g.id).length;
      b.className = `pod-chip grp-chip${g.id === this._selGroup ? ' selected' : ''}${!g.parent && g.autoFire ? ' auto' : ''}${depth ? ' sub' : ''}`;
      b.textContent = `${depth ? '└'.padStart(depth, '　') + ' ' : ''}${g.name}（${n}基）`;
      b.addEventListener('click', () => {
        this._selGroup = g.id;
        const first = this._groupMounts(g.id)[0];
        if (first) this._select('mount', first.key);
        else { this._sel = null; this._groupLocked = true; this.refresh(); }
      });
      row.appendChild(b);
    }
    const cg = groups.find((g) => g.id === this._selGroup);
    $('wpnGroupEditor').style.display = cg ? '' : 'none';
    if (cg) {
      if (document.activeElement !== $('wpnGroupName')) $('wpnGroupName').value = cg.name;
      $('wpnGroupAuto').checked = !!cg.autoFire;
      if (document.activeElement !== $('wpnGroupPower')) $('wpnGroupPower').value = String(cg.autoPower ?? 50);
      const members = this._groupMounts(cg.id);
      // 親のグループの選択肢（自分と自分の中のグループは選べない）
      const own = weaponGroupAndDescendants(design.weapons, cg.id);
      const ps = $('wpnGroupParent');
      ps.innerHTML = '';
      ps.appendChild(new Option('なし（最上位）', ''));
      for (const { g, depth } of tree) if (!own.has(g.id)) ps.appendChild(new Option(`${'　'.repeat(depth)}${g.name}`, g.id));
      ps.value = cg.parent || '';
      // 自動射撃は最上位のグループで決める
      const top = !cg.parent;
      $('wpnGroupAutoRow').style.display = top ? '' : 'none';
      $('wpnGroupSubNote').style.display = top ? 'none' : '';
      if (members.length && document.activeElement !== $('wpnGroupElevMin') && document.activeElement !== $('wpnGroupElevMax')) {
        const c0 = weaponMountConfigFor(design.weapons, members[0].key);
        $('wpnGroupElevMin').value = String(c0.elevMin);
        $('wpnGroupElevMax').value = String(c0.elevMax);
      }
      $('wpnGroupDelBtn').disabled = groups.length <= 1;
    }
    const gs = $('wpnGroupSel');
    gs.innerHTML = '';
    for (const { g } of tree) gs.appendChild(new Option(weaponGroupPath(design.weapons, g.id), g.id));
    // v89: 砲塔・射撃レーダーはプルダウンで選ぶ（数が多いので）。グループごとに見出し（optgroup）で分ける
    const sel = $('wpnPartSel');
    sel.innerHTML = '';
    if (!this._sel && rig.mounts.length && !locked) {
      const first = rig.mounts.find((m) => weaponMountConfigFor(design.weapons, m.key).group === this._selGroup) || rig.mounts[0];
      this._sel = { kind: 'mount', key: first.key };
    }
    if (locked && !this._sel) sel.appendChild(new Option('（このグループに砲塔はありません）', ''));
    for (const { g } of tree) {
      const og = document.createElement('optgroup');
      og.label = weaponGroupPath(design.weapons, g.id);
      for (const m of rig.mounts) {
        const c = weaponMountConfigFor(design.weapons, m.key);
        if (c.group !== g.id) continue;
        og.appendChild(new Option(`${m.key}・${weaponTypeInfo(c.kind, c.type).label} ${c.caliber}mm×${m.barrels.length}`, `mount:${m.key}`));
      }
      if (og.children.length) sel.appendChild(og);
    }
    if (rig.directors.length) {
      const og = document.createElement('optgroup');
      og.label = '射撃レーダー・測距儀';
      for (const d of rig.directors) og.appendChild(new Option(d.key, `director:${d.key}`));
      sel.appendChild(og);
    }
    sel.value = this._sel ? `${this._sel.kind}:${this._sel.key}` : '';
    sel.disabled = !(rig.mounts.length + rig.directors.length);
    const part = this._findSel();
    $('wpnEditor').style.display = part && part.kind === 'mount' ? '' : 'none';
    $('dirEditor').style.display = part && part.kind === 'director' ? '' : 'none';
    if (!part) return;
    const active = document.activeElement;
    const setVal = (id, v) => { if (active !== $(id)) $(id).value = v; };
    if (part.kind === 'mount') {
      const c = weaponMountConfigFor(design.weapons, part.key);
      $('wpnEditorTitle').textContent = `${part.key}（砲身 ${part.barrels.length}門）`;
      $('wpnGroupSel').value = c.group || '';
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
      const ru = WEAPON_RANGE_UNITS[c.rangeUnit];
      $('wpnRangeUnit').value = c.rangeUnit;
      setVal('wpnRange', c.range > 0 ? String(Number((c.range / ru.m).toPrecision(6))) : '');
      $('wpnRange').placeholder = `自動（${formatWeaponRange(weaponAutoRange(c), c.rangeUnit)}）`;
      $('wpnTraverse').placeholder = `自動（${weaponAutoTraverseRate(c)}）`;
      $('wpnTestYaw').min = String(c.yawMin); $('wpnTestYaw').max = String(c.yawMax);
      $('wpnTestElev').min = String(c.elevMin); $('wpnTestElev').max = String(c.elevMax);
      const info = weaponTypeInfo(c.kind, c.type);
      $('wpnLine').textContent = c.kind === 'laser'
        ? `${info.label}・口径 ${c.caliber}mm・充電 ${weaponReload(c)}秒・照射 ${info.beamTime}秒・射程 ${formatWeaponRange(weaponRange(c), c.rangeUnit)}`
        : `${info.label}・口径 ${c.caliber}mm・装填 ${weaponReload(c)}秒・初速 ${info.speed.toLocaleString('ja-JP')} m/s・射程 ${formatWeaponRange(weaponRange(c), c.rangeUnit)}・旋回 ${weaponTraverseRate(c)}°/s・俯仰 ${weaponElevRate(c)}°/s`;
    } else {
      const c = normalizeWeaponDirector(design.weapons.directors[part.key]);
      $('dirEditorTitle').textContent = part.key;
      setVal('dirYawMin', String(c.yawMin));
      setVal('dirYawMax', String(c.yawMax));
      $('dirTestYaw').min = String(c.yawMin); $('dirTestYaw').max = String(c.yawMax);
    }
  },

  // ---------------------------------------------------------
  // v89: 3Dビューの旋回範囲のマーク（武装の欄を開いている間）
  //   各砲塔: 旋回範囲の扇形（砲塔の位置・旋回の軸に垂直な面）と、元の向き（0°）の線。
  //   選んでいる砲塔は明るく、砲身の仰角の範囲（今の旋回角での縦の扇形）と今の向きの線も出す。
  //   射撃レーダー／測距儀は緑の扇形。船体に隠れないよう、いちばん手前に描く
  // ---------------------------------------------------------
  _rebuildMarks() {
    const scene = this._opts && this._opts.scene;
    if (!scene) return;
    if (!this._marks) {
      this._marks = new THREE.Group();
      this._marks.renderOrder = 20;
      scene.add(this._marks);
    }
    for (const c of [...this._marks.children]) {
      this._marks.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    const design = this._opts.getDesign();
    const sec = this.$ && this.$('weaponSection');
    if (!design || !this._rig || !this._rigRoot || (sec && !sec.open)) return;
    this._rigRoot.updateMatrixWorld(true);
    const size = (design.hull && design.hull.size) || 100;
    const sel = this._findSel();
    for (const m of this._rig.mounts) {
      const c = weaponMountConfigFor(design.weapons, m.key);
      const on = sel === m;
      // 扇形の大きさは口径に合わせる（副砲などの小さな砲は小さく。たくさん並んでも重なりにくいように）
      const r0 = clamp((c.caliber / 1000) * 30, size * 0.01, size * 0.045);
      const r = on ? Math.max(r0 * 1.6, size * 0.03) : r0;
      this._addPartMarks(m, m.turret, c.yawMin, c.yawMax, r, on ? 0xff7a50 : 0xff9070, on ? 0.38 : 0.16, on);
      if (on) {
        // 砲身の仰角の範囲: 今の旋回角での、旋回の軸を含む縦の扇形
        const Fy = m.F.clone().applyAxisAngle(m.U, m.yaw);
        const pts = this._fanPoints((e) => Fy.clone().multiplyScalar(Math.cos(e)).addScaledVector(m.U, Math.sin(e)), toRadW(c.elevMin), toRadW(c.elevMax), r * 0.85);
        this._addFan(m.turret, pts, 0xffd060, 0.42);
        const cur = Fy.clone().multiplyScalar(Math.cos(m.elev)).addScaledVector(m.U, Math.sin(m.elev));
        this._addLine(m.turret, [new THREE.Vector3(), cur.multiplyScalar(r * 1.15)], 0xffffff, 1);
      }
    }
    for (const d of this._rig.directors) {
      const c = normalizeWeaponDirector(design.weapons.directors[d.key]);
      const on = sel === d;
      const r = size * (on ? 0.06 : 0.04);
      this._addPartMarks(d, d.node, c.yawMin, c.yawMax, r, 0x70ff9a, on ? 0.38 : 0.16, on);
    }
  },
  _addPartMarks(part, node, yawMin, yawMax, r, color, opacity, on) {
    const pts = this._fanPoints((a) => part.F.clone().applyAxisAngle(part.U, a), toRadW(yawMin), toRadW(yawMax), r);
    this._addFan(node, pts, color, opacity);
    // 元の向き（0°）
    this._addLine(node, [new THREE.Vector3(), part.F.clone().multiplyScalar(r * 1.1)], color, on ? 0.9 : 0.5);
    if (on) {
      const cur = part.F.clone().applyAxisAngle(part.U, part.yaw);
      this._addLine(node, [new THREE.Vector3(), cur.multiplyScalar(r * 1.15)], 0xffffff, 1);
    }
  },
  _fanPoints(dirAt, a0, a1, r) {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / toRadW(5)));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(dirAt(a0 + ((a1 - a0) * i) / n).normalize().multiplyScalar(r));
    return pts;
  },
  // 部品の位置に、部品の親の向きで置く（U・F は親の座標）。拡大率は使わない（大きさは m 単位で決める）
  _placeAt(node, obj) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    node.getWorldPosition(p);
    node.parent.getWorldQuaternion(q);
    obj.position.copy(p);
    obj.quaternion.copy(q);
    obj.renderOrder = 20;
    this._marks.add(obj);
  },
  _addFan(node, pts, color, opacity) {
    const pos = [];
    for (let i = 0; i + 1 < pts.length; i++) pos.push(0, 0, 0, pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const fan = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), ...pts, new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity * 2.4), depthTest: false, depthWrite: false }));
    const g = new THREE.Group();
    g.add(fan); g.add(edge);
    fan.renderOrder = 20; edge.renderOrder = 21;
    this._placeAt(node, g);
  },
  _addLine(node, pts, color, opacity) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
    this._placeAt(node, line);
    line.renderOrder = 22;
  },
};
