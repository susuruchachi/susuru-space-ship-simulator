// =============================================================
// 21-ship-design.js
// 艦の設計（名前を付けて保存できる自作の艦）と、重心を基準にした
// 推力の自動配分（バランス制御）
//
// v78: 「船の大きさを10m位から最大5000mまで自由にいじれるように、
// エンジンの最大出力・重量・エンジンの位置・重心を自由に設定できる
// ように。メインエンジンの軸上に重心を置けるように、姿勢スラスターも
// 自由な位置（最も近い船体表面上）に置けるように。出力は重心位置から
// 自動制御してバランスをとるように。船ごとに名前と一緒に保存したい」
// という要望で新設。
//
// 艦船建造画面（ship-builder.html）・設定画面（settings.html）・ゲーム
// （index.html）の3画面で共有する。Three.js には依存しない。
//
// 座標系:
//   設計座標（D）: 建造画面のワールド座標そのもの。船体は補正（回転・
//     スケール・中心合わせ）後に原点を中心として置かれる。艦首は-Z、
//     上は+Y、右は+X。単位はメートル。
//   物理座標（P）: 重心を原点にした艦のローカル座標（04-flight-physics.js
//     が使う座標）。P = D - 重心。
// =============================================================

const SHIP_DESIGN_SIZE_MIN = 5;    // 最大寸法の下限 [m]（ロケット級の8mも入るよう、要望の「10m位」より少し下まで）
const SHIP_DESIGN_SIZE_MAX = 5000; // 最大寸法の上限 [m]

// 艦種プリセットごとの仮船体（箱）の寸法。index.html の仮メッシュと同じ。
const SHIP_TEMPLATE_DIMS = {
  rocket: { x: 2, y: 2, z: 8 },
  cruiser: { x: 12, y: 8, z: 60 },
  battleship: { x: 24, y: 18, z: 140 },
};

// -------------------------------------------------------------
// テンプレート（艦種プリセット）から、性能の「密度」を取り出す。
// 大きさを変えても、質量あたりの推力（=加速度）や最高速度が保たれる
// ように、新しい設計の初期値はこの値から計算する。
// -------------------------------------------------------------
function shipTemplateSpec(baseClass) {
  const key = ShipClassPresets[baseClass] ? baseClass : 'rocket';
  const preset = ShipClassPresets[key];
  const dims = SHIP_TEMPLATE_DIMS[key];
  const main = preset.thrusters.filter((t) => t.kind === 'main').reduce((s, t) => s + t.maxThrust, 0);
  const retro = preset.thrusters.filter((t) => t.id.startsWith('retro')).reduce((s, t) => s + t.maxThrust, 0);
  const rcs = preset.thrusters.find((t) => t.kind === 'rcs' && !t.id.startsWith('retro'));
  // 慣性の係数: 船体の外形に内接する楕円体に質量が一様に詰まっているときの
  // 慣性モーメント（3軸の平均）に対する、プリセットの慣性モーメントの比。
  // プリセットは操縦しやすいよう質量が重心近くに集まった艦として調整されて
  // いるため、1より小さい（巡洋艦・戦艦ほど小さい）。
  const e = ellipsoidInertia(preset.mass, dims);
  return {
    baseClass: key,
    label: preset.label,
    dims,
    size: Math.max(dims.x, dims.y, dims.z),
    mass: preset.mass,
    inertiaFactor: preset.inertia / ((e.x + e.y + e.z) / 3),
    mainAccel: main / preset.mass,
    retroAccel: retro / preset.mass,
    rcsAccel: (rcs ? rcs.maxThrust : main * 0.04) / preset.mass,
    maxSpeed: preset.maxSpeed,
    maxAngularSpeed: preset.maxAngularSpeed,
    speedCapMode: preset.speedCapMode,
  };
}

// 外形（バウンディングボックスの寸法）に内接する楕円体に、質量 m が一様に
// 詰まっているときの慣性モーメント（I = m(b²+c²)/5 など。b,c は半径）
function ellipsoidInertia(m, dims) {
  const a = dims.x / 2, b = dims.y / 2, c = dims.z / 2;
  return { x: (m * (b * b + c * c)) / 5, y: (m * (a * a + c * c)) / 5, z: (m * (a * a + b * b)) / 5 };
}

// 大きさ（最大寸法）から、質量・推力などの目安の値を求める。
// 質量は体積（大きさの3乗）に比例、推力は質量に比例（加速度を保つ）、
// 最大角速度は大きいほど控えめにする（大きさの平方根に反比例）。
function shipDesignAutoSpec(baseClass, size) {
  const t = shipTemplateSpec(baseClass);
  const k = size / t.size;
  const mass = t.mass * k * k * k;
  return {
    mass,
    mainThrust: mass * t.mainAccel,
    retroThrust: mass * t.retroAccel,
    rcsThrust: mass * t.rcsAccel,
    maxSpeed: t.maxSpeed,
    maxAngularSpeed: clamp(t.maxAngularSpeed / Math.sqrt(k), 0.02, 3.0),
  };
}

function generateShipDesignId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `design-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// -------------------------------------------------------------
// 新しい設計を作る（テンプレートの艦種の形・性能が初期値）
// -------------------------------------------------------------
function createShipDesign(baseClass, name) {
  const t = shipTemplateSpec(baseClass);
  const auto = shipDesignAutoSpec(t.baseClass, t.size);
  const dims = { ...t.dims };
  const now = Date.now();
  const design = {
    version: 1,
    id: generateShipDesignId(),
    name: name || `${t.label}の改造艦`,
    baseClass: t.baseClass,
    createdAt: now,
    updatedAt: now,
    hull: {
      hasModel: false,
      modelFileName: null,
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: 1,
      offset: { x: 0, y: 0, z: 0 },
      size: t.size,
      dims,
      // モデルが無いときの箱の仮船体の縦横比（最大寸法を1とした比）
      boxRatio: { x: dims.x / t.size, y: dims.y / t.size, z: dims.z / t.size },
    },
    mass: auto.mass,
    // 慣性モーメントの係数（1 = 質量が船体全体に一様に詰まっている。小さいほど
    // 質量が重心の近くに集まっていて回りやすい）。初期値はひな形のプリセットと
    // 同じ回りやすさになる値。
    inertiaFactor: t.inertiaFactor,
    cog: { x: 0, y: 0, z: 0 },
    // v81: 主エンジンは複数持てる（初期は艦尾の中央に1基）
    // v84: diameter はノズルの直径 [m]（null なら大きさから自動で決める。噴射の太さ・長さに使う）
    mains: [{ id: 'm1', position: { x: 0, y: 0, z: dims.z / 2 }, thrust: auto.mainThrust, diameter: null }],
    // v84: 逆噴射のノズルは船体の表面の好きな位置に置ける（推力は全ノズルで等分）
    retro: { thrust: auto.retroThrust, nozzles: defaultRetroNozzles(dims, { x: 0, y: 0, z: 0 }), custom: false },
    rcs: { thrust: auto.rcsThrust, pods: defaultRcsPodsForBox(dims) },
    maxSpeed: auto.maxSpeed,       // v85: null なら速度は無制限
    maxAccel: null,                // v85: 最大加速度 [m/s²]（null なら推力のまま）
    maxAngularSpeed: auto.maxAngularSpeed,
    speedCapMode: t.speedCapMode,
    dockingFace: null,
    collision: null,
  };
  return design;
}

// 箱の仮船体用の姿勢スラスター初期配置: 艦首・艦尾寄りの断面の上下左右、計8基
function defaultRcsPodsForBox(dims) {
  const pods = [];
  const hx = dims.x / 2, hy = dims.y / 2;
  for (const z of [-dims.z * 0.4, dims.z * 0.4]) {
    pods.push({ position: { x: 0, y: hy, z }, normal: { x: 0, y: 1, z: 0 } });
    pods.push({ position: { x: 0, y: -hy, z }, normal: { x: 0, y: -1, z: 0 } });
    pods.push({ position: { x: hx, y: 0, z }, normal: { x: 1, y: 0, z: 0 } });
    pods.push({ position: { x: -hx, y: 0, z }, normal: { x: -1, y: 0, z: 0 } });
  }
  return pods.map((p, i) => ({ id: `p${i + 1}`, ...p }));
}

// v84: 逆噴射ノズルの初期配置（v83までの固定位置と同じ）: 艦首の面の、重心をはさんだ左右対称の2か所
function defaultRetroNozzles(dims, cog) {
  const zFront = -dims.z / 2;
  const dx = dims.x * 0.15;
  return [['r1', -1], ['r2', 1]].map(([id, sx]) => ({
    id, position: { x: cog.x + sx * dx, y: cog.y, z: zFront }, normal: { x: 0, y: 0, z: -1 }, diameter: null,
  }));
}

// v84: ノズルの直径の自動の値 [m]。v83までの噴射の見た目（艦の大きさ・基数で決めていた
// 太さ）とほぼ同じになる値。kind: 'main' | 'retro'
function shipDesignAutoNozzleDiameter(d, kind) {
  const size = Math.max(d.hull.dims.x, d.hull.dims.y, d.hull.dims.z);
  const fx = Math.pow(Math.max(1, size / 8), 0.85);
  if (kind === 'retro') {
    const n = Math.max(1, ((d.retro && d.retro.nozzles) || []).length);
    return 0.45 * fx / Math.sqrt(Math.max(1, n / 2));
  }
  return 0.9 * fx / Math.sqrt(Math.max(1, (d.mains || []).length));
}
function shipDesignNozzleDiameter(d, part, kind) {
  return part && part.diameter > 0 ? part.diameter : shipDesignAutoNozzleDiameter(d, kind);
}
// v84: 全開のときの噴射のおよその太さ・長さ [m]（設定画面の表示用）。
// 07-engine-fx.js の粒子の大きさ（直径の約1.3倍）・速さ・寿命・減衰から見積もった値
function shipDesignPlumeEstimate(d, part, kind) {
  const dia = shipDesignNozzleDiameter(d, part, kind);
  const size = Math.max(d.hull.dims.x, d.hull.dims.y, d.hull.dims.z);
  const lenFx = Math.max(1, size / 8) * dia / shipDesignAutoNozzleDiameter(d, kind);
  const length = 8.8 * lenFx * (kind === 'retro' ? 0.6 : 1);
  return { diameter: dia, width: dia * 1.3, length, endWidth: dia * 1.3 + length * 0.1 };
}

// 主エンジンの推力の合計と、推力の中心（推力で重み付けした噴射口の平均位置）。
// 全エンジンを同じ出力で吹かしたときの合力は、この点を通る前後方向の線（推力線）に沿う。
function shipDesignMainThrust(d) {
  return (d.mains || []).reduce((s, e) => s + Math.max(0, e.thrust || 0), 0);
}
function shipDesignThrustCenter(d) {
  const total = shipDesignMainThrust(d);
  const c = { x: 0, y: 0, z: 0 };
  const list = d.mains || [];
  if (!list.length) return c;
  for (const e of list) {
    const w = total > 0 ? Math.max(0, e.thrust || 0) / total : 1 / list.length;
    c.x += e.position.x * w; c.y += e.position.y * w; c.z += e.position.z * w;
  }
  return c;
}

// 古いデータや手で書き換えたデータでも壊れないよう、足りない項目を補う
function normalizeShipDesign(d) {
  if (!d) return null;
  const base = createShipDesign(d.baseClass || 'rocket', d.name);
  const out = { ...base, ...d };
  out.hull = { ...base.hull, ...(d.hull || {}) };
  // v81: 主エンジン1基（main）の形の古いデータは、複数（mains）の形に直す
  let mains = Array.isArray(d.mains) ? d.mains : (d.main ? [{ id: 'm1', ...d.main }] : base.mains);
  mains = mains.filter((e) => e && e.position).map((e, i) => ({
    id: e.id || `m${i + 1}`,
    position: { x: Number(e.position.x) || 0, y: Number(e.position.y) || 0, z: Number(e.position.z) || 0 },
    thrust: Math.max(0, Number(e.thrust) || 0),
    diameter: Number(e.diameter) > 0 ? Number(e.diameter) : null,
  }));
  out.mains = mains.length ? mains : base.mains;
  delete out.main;
  out.retro = { ...base.retro, ...(d.retro || {}) };
  // v84: ノズルの位置を持たない古いデータは、v83までと同じ位置（重心をはさむ左右）にする
  if (!Array.isArray(d.retro && d.retro.nozzles)) {
    out.retro.nozzles = defaultRetroNozzles(out.hull.dims, { ...base.cog, ...(d.cog || {}) });
    out.retro.custom = false;
  }
  out.retro.nozzles = out.retro.nozzles.filter((n) => n && n.position).map((n, i) => ({
    id: n.id || `r${i + 1}`,
    position: { x: Number(n.position.x) || 0, y: Number(n.position.y) || 0, z: Number(n.position.z) || 0 },
    normal: n.normal ? { x: Number(n.normal.x) || 0, y: Number(n.normal.y) || 0, z: Number(n.normal.z) || 0 } : { x: 0, y: 0, z: -1 },
    diameter: Number(n.diameter) > 0 ? Number(n.diameter) : null,
  }));
  out.rcs = { ...base.rcs, ...(d.rcs || {}) };
  if (!Array.isArray(out.rcs.pods)) out.rcs.pods = [];
  out.cog = { ...base.cog, ...(d.cog || {}) };
  // v85: 最高速度は空欄（null）なら無制限。最大加速度は無ければ制限なし
  out.maxSpeed = d.maxSpeed === null ? null : (Number(d.maxSpeed) > 0 ? Number(d.maxSpeed) : base.maxSpeed);
  out.maxAccel = Number(d.maxAccel) > 0 ? Number(d.maxAccel) : null;
  return out;
}

// -------------------------------------------------------------
// 姿勢スラスター（RCS）のポッド1基を、噴射口5つに展開する。
// 実在の宇宙機のRCSクワッドと同じく、船体表面の外向き（法線方向）1つと、
// 表面に沿った4方向（艦の前後方向に近い向き±、それに直交する向き±）。
// 法線方向の噴射は艦をその点で内側へ押し、表面に沿った噴射は前後・横移動と
// ロール（艦軸まわりの回転）に効く。
// -------------------------------------------------------------
function rcsPodNozzleDirections(normal) {
  const n = vecNormalize(normal);
  // 表面に沿った第1の向き: 艦の前後軸(Z)を接平面に投影したもの。
  // 法線がほぼ前後を向いている（艦首・艦尾の面）ときは左右軸(X)を使う。
  let t1 = { x: -n.x * n.z, y: -n.y * n.z, z: 1 - n.z * n.z };
  if (vecLength(t1) < 0.35) {
    t1 = { x: 1 - n.x * n.x, y: -n.y * n.x, z: -n.z * n.x };
  }
  t1 = vecNormalize(t1);
  const t2 = vecNormalize(vecCross(n, t1));
  return [
    { key: 'out', dir: n },
    { key: 'a', dir: t1 },
    { key: 'b', dir: vecScale(t1, -1) },
    { key: 'c', dir: t2 },
    { key: 'd', dir: vecScale(t2, -1) },
  ];
}

// -------------------------------------------------------------
// 設計 → ゲーム用の物理パラメータ（createShipState の艦に上書きする値）
// -------------------------------------------------------------
function buildShipSpecFromDesign(design) {
  const d = normalizeShipDesign(design);
  const c = d.cog;
  const P = (p) => ({ x: p.x - c.x, y: p.y - c.y, z: p.z - c.z });
  const dims = d.hull.dims;
  const thrusters = [];

  // 主エンジン: 後方(+Z)へ噴射し、艦を前方(-Z)へ押す。複数あれば1基ずつ別に
  // 出力を決める（重心が推力線からずれていれば、左右・上下の出力差でも釣り合いをとる）
  // v84: nozzleDiameter（ノズルの直径）と plumeScale（自動の直径に対する比。噴射の長さに
  // 掛ける）は 07-engine-fx.js の噴射の見た目に使う
  for (const e of d.mains) {
    const dia = shipDesignNozzleDiameter(d, e, 'main');
    thrusters.push({
      id: `main_${e.id}`, position: P(e.position), direction: { x: 0, y: 0, z: 1 },
      maxThrust: Math.max(0, e.thrust), kind: 'main',
      nozzleDiameter: dia, plumeScale: dia / shipDesignAutoNozzleDiameter(d, 'main'),
    });
  }
  // 逆噴射: 前（-Z）へ噴射して艦を後ろへ押す。v84: ノズルは船体表面の好きな位置に置け、
  // 1基ずつ別に出力を決める（重心をはさまない配置でも、出力差と姿勢スラスターで
  // 回転しないように釣り合いをとる）
  const retroNozzles = d.retro.thrust > 0 ? d.retro.nozzles : [];
  for (const n of retroNozzles) {
    const dia = shipDesignNozzleDiameter(d, n, 'retro');
    thrusters.push({
      id: `retro_${n.id}`, position: P(n.position), direction: { x: 0, y: 0, z: -1 },
      maxThrust: d.retro.thrust / retroNozzles.length, kind: 'rcs',
      nozzleDiameter: dia, plumeScale: dia / shipDesignAutoNozzleDiameter(d, 'retro'),
    });
  }
  // 姿勢スラスター
  for (const pod of d.rcs.pods) {
    const thrust = pod.thrust > 0 ? pod.thrust : d.rcs.thrust;
    for (const nz of rcsPodNozzleDirections(pod.normal)) {
      thrusters.push({
        id: `rcs_${pod.id}_${nz.key}`, position: P(pod.position), direction: nz.dir,
        maxThrust: thrust, kind: 'rcs', pod: pod.id,
      });
    }
  }

  // 慣性モーメント: 船体の外形（バウンディングボックス）に内接する
  // 楕円体に質量が一様に詰まっているときの値に、慣性の係数を掛ける。
  const m = Math.max(1, d.mass);
  const e = ellipsoidInertia(m, dims);
  const f = clamp(Number(d.inertiaFactor) || 1, 0.001, 2);
  const inertiaTensor = {
    x: Math.max(1e-6, e.x * f),
    y: Math.max(1e-6, e.y * f),
    z: Math.max(1e-6, e.z * f),
  };
  const size = Math.max(dims.x, dims.y, dims.z);
  return {
    label: d.name,
    mass: m,
    inertia: (inertiaTensor.x + inertiaTensor.y + inertiaTensor.z) / 3,
    inertiaTensor,
    thrusters,
    maxSpeed: d.maxSpeed > 0 ? Math.max(1, d.maxSpeed) : Infinity,
    maxAccel: d.maxAccel > 0 ? d.maxAccel : null,
    maxAngularSpeed: Math.max(0.001, d.maxAngularSpeed),
    speedCapMode: d.speedCapMode,
    size,
    dims: { ...dims },
    cog: { ...c },
  };
}

// createShipState() で作った艦に設計の値を反映する
function applyShipDesignToShip(ship, design) {
  const spec = buildShipSpecFromDesign(design);
  ship.label = spec.label;
  ship.mass = spec.mass;
  ship.inertia = spec.inertia;
  ship.inertiaTensor = spec.inertiaTensor;
  ship.thrusters = spec.thrusters;
  ship.maxSpeed = spec.maxSpeed;
  ship.maxAccel = spec.maxAccel;
  ship.maxAngularSpeed = spec.maxAngularSpeed;
  ship.speedCapMode = spec.speedCapMode;
  ship.size = spec.size;
  ship.hullDims = { ...spec.dims }; // v84: ポートの当たり判定の細かさの目安
  ship.designId = design.id;
  // 推力の配分は重心まわりの力・トルクの釣り合いを解く方式（ShipAllocator）
  ship.allocation = 'balanced';
  ship._alloc = null;
  ship.thrusterOutputRatios = {};
  return spec;
}

// =============================================================
// 推力の自動配分（バランス制御）
//
// 欲しい並進力・トルク（艦のローカル座標、各成分 -1..1 の「最大能力に
// 対する割合」）から、全スラスターの出力比（0..1）を求める。
// 各スラスターが重心まわりに生む力とトルク（6成分）を並べた行列 B を
// 作り、
//   最小化  Σ 重み × (B r − 目標)²  ＋ 小さな正則化
//   制約    0 ≤ r ≤ 1
// という箱制約付き最小二乗問題を解く（v83から有効制約法で厳密に）。
// トルクの誤差に大きな重みを置くので、重心が主エンジンの推力線から
// ずれていても、姿勢スラスターで回転を打ち消すように配分される
// （打ち消しきれない場合は主エンジンの出力が自動的に絞られる）。
// 回転の能力（どれだけ強く回せるか）は姿勢スラスターだけで見積もる。
// （v83までは逆噴射の左右2基を1組として同じ出力で吹かしていた。v84 からノズルを
// 好きな位置に置けるようになったので、主エンジンと同じく1基ずつ出力を決める）。正則化は出力比の2乗の小さな項だけにする
// （出力比そのものに比例するコストを入れると、小さな要求に対して何も
// 噴射しない「不感帯」ができ、自動ドッキングの微調整が効かなくなるため）。
//
// 従来の艦種プリセット（03-thruster-solver.js の貪欲法）とは別の方式で、
// 自作の艦（ship.allocation === 'balanced'）にだけ使う。
//
// v83: 「姿勢スラスターで加減速してしまう」不具合の修正。力の誤差を
// 「主エンジンまで含めた最大の力」で割って測っていたため、主エンジンが
// 姿勢スラスターより何千倍も強い艦では、旋回のために主エンジンを左右で
// 出力差をつけて吹かす（その副作用で大きく前進する）配分を「誤差が小さい」と
// みなしていた。力の誤差は「要求した力」か「姿勢スラスターだけで出せる力」の
// 大きい方で割るようにし、要求していない向きの力を厳しく抑える。
// あわせて、解き方を反復法（FISTA）から厳密に解く有効制約法に変えた（_solveCore）。
// =============================================================
const ShipAllocator = {
  ITERATIONS: 0,        // （v83: 厳密に解くようになったので使わない。呼び出しの互換のため残す）
  CAP_ITERATIONS: 0,
  FORCE_WEIGHT: 1.0,
  TORQUE_WEIGHT: 3.0,
  ZERO_FORCE_WEIGHT: 12.0, // v83: 力を要求していない軸の誤差の重み
  // v83: 自動ドッキング中に使う加速度・角加速度の上限。自動ドッキングの制御は
  // ふつうの艦（加速度 数〜20 m/s² 程度）に合わせて調整してあるため、主エンジンが
  // 何百〜何万 m/s² も出る艦では、わずかな指示でも1フレームで行き過ぎて、
  // 停止すべきところで速度が振動し続け、入港できなかった。
  DOCKING_MAX_ACCEL: 15,        // [m/s²]
  DOCKING_MAX_ANGULAR_ACCEL: 3, // [rad/s²]

  // 自動ドッキング中なら、行（Fx Fy Fz Tx Ty Tz）ごとの上限（物理量）。それ以外は null
  _dockingLimits(ship) {
    if (!(ship && ship.autoDockingEnabled && typeof State !== 'undefined' && State.dockingTarget)) return null;
    const I = ship.inertiaTensor || { x: ship.inertia, y: ship.inertia, z: ship.inertia };
    const f = ship.mass * this.DOCKING_MAX_ACCEL;
    const aa = this.DOCKING_MAX_ANGULAR_ACCEL;
    return [f, f, f, I.x * aa, I.y * aa, I.z * aa];
  },
  L2_REG: 2e-4,  // 出力比の2乗和の小さな正則化（解を一意にする）
  // v84: 姿勢スラスター・逆噴射の正則化の重みは主エンジンの何倍か。主エンジンで
  // 足りる力を姿勢スラスターで分担しない（「まっすぐ吹かすだけで姿勢スラスターが
  // 噴射する」の修正）。大きすぎると、姿勢スラスターしか効かない向きで出力が
  // 指示より弱くなり、自動ドッキングで止まり切れなくなる。
  RCS_REG_FACTOR: 10,

  // 艦ごとの前計算（スラスター構成が変わったときだけやり直す）
  prepare(ship) {
    const capRatio = State.settings.rcsThrustCapRatio ?? 1.0;
    const cached = ship._alloc;
    if (cached && cached.thrusters === ship.thrusters && cached.capRatio === capRatio) return cached;

    const ts = ship.thrusters;
    // 同じ group のスラスター（逆噴射の左右など）は1つの「列」にまとめ、同じ出力比で吹かす
    const cols = [];
    const colByKey = new Map();
    const colOfThruster = new Int32Array(ts.length);
    ts.forEach((t, i) => {
      const key = t.group || t.id;
      let c = colByKey.get(key);
      if (c === undefined) {
        c = cols.length;
        colByKey.set(key, c);
        cols.push({ isEngine: false, isMain: false });
      }
      colOfThruster[i] = c;
      if (t.kind === 'main' || t.id.startsWith('retro')) cols[c].isEngine = true;
      if (t.kind === 'main') cols[c].isMain = true;
    });
    const N = cols.length;
    const B = new Float64Array(6 * N); // 列ごとに [Fx Fy Fz Tx Ty Tz]
    ts.forEach((t, i) => {
      const d = vecNormalize(t.direction);
      const T = getEffectiveMaxThrust(ship, t);
      const fx = -d.x * T, fy = -d.y * T, fz = -d.z * T;
      const p = t.position;
      const o = colOfThruster[i] * 6;
      B[o] += fx; B[o + 1] += fy; B[o + 2] += fz;
      B[o + 3] += p.y * fz - p.z * fy;
      B[o + 4] += p.z * fx - p.x * fz;
      B[o + 5] += p.x * fy - p.y * fx;
    });
    // 単純な上限（各成分について、その向きに寄与するスラスターの合計）
    const naivePos = new Float64Array(6), naiveNeg = new Float64Array(6);
    for (let k = 0; k < N; k++) {
      for (let row = 0; row < 6; row++) {
        const v = B[k * 6 + row];
        if (v > 0) naivePos[row] += v; else naiveNeg[row] -= v;
      }
    }
    const rcsOnly = new Uint8Array(N);
    for (let k = 0; k < N; k++) rcsOnly[k] = cols[k].isEngine ? 0 : 1;
    // v84: 主エンジンだけの前進（-Z）推力。手動のスロットルではこれを上限にする
    // （姿勢スラスターまで足した最大値を上限にすると、全開で加速するたびに
    // 姿勢スラスターも前進に使ってしまう）
    const mainOnly = new Uint8Array(N);
    let mainFwd = 0;
    for (let k = 0; k < N; k++) {
      mainOnly[k] = cols[k].isMain ? 1 : 0;
      if (cols[k].isMain && B[k * 6 + 2] < 0) mainFwd -= B[k * 6 + 2];
    }

    const a = {
      thrusters: ts, capRatio, N, B, naivePos, naiveNeg, colOfThruster, lamCol: new Float64Array(N), isMainCol: mainOnly,
      ids: ts.map((t) => t.id),
      r: new Float64Array(N),
      capPos: new Float64Array(6), capNeg: new Float64Array(6), mainFwd,
      // v83: 姿勢スラスターだけで出せる並進の力（力の誤差の物差しに使う）
      rcsCapPos: new Float64Array(3), rcsCapNeg: new Float64Array(3),
      _A: new Float64Array(6 * N), _colNorm: new Float64Array(N), _res: new Float64Array(6),
    };
    ship._alloc = a;

    // 実際に出せる最大値: ほかの5成分をゼロに保ったまま（=純粋な前進や
    // 純粋なピッチ回転として）その成分をどこまで大きくできるか
    const scale = new Float64Array(6), weight = new Float64Array(6), target = new Float64Array(6);
    for (let row = 0; row < 6; row++) {
      for (const sign of [1, -1]) {
        const naive = sign > 0 ? naivePos[row] : naiveNeg[row];
        let cap = 0;
        if (naive > 1e-9) {
          for (let j = 0; j < 6; j++) {
            const ref = Math.max(naivePos[j], naiveNeg[j], 1e-9);
            scale[j] = 1 / ref;
            weight[j] = j === row ? 1 : 30;
            target[j] = 0;
          }
          target[row] = sign * naive * 1.05;
          const r = new Float64Array(N);
          // 回転（トルク）の能力は姿勢スラスターだけで見積もる
          this._solveCore(a, target, scale, weight, this.CAP_ITERATIONS, r, row >= 3 ? rcsOnly : null);
          let achieved = 0;
          for (let k = 0; k < N; k++) achieved += B[k * 6 + row] * r[k];
          cap = Math.max(0, achieved * sign);
          if (row < 3) {
            // 同じ向きの力を、姿勢スラスターだけで（回転させずに）どこまで出せるか
            const r2 = new Float64Array(N);
            this._solveCore(a, target, scale, weight, this.CAP_ITERATIONS, r2, rcsOnly);
            let ach2 = 0;
            for (let k = 0; k < N; k++) ach2 += B[k * 6 + row] * r2[k];
            if (sign > 0) a.rcsCapPos[row] = Math.max(0, ach2); else a.rcsCapNeg[row] = Math.max(0, -ach2);
          }
        }
        if (sign > 0) a.capPos[row] = cap; else a.capNeg[row] = cap;
      }
    }
    return a;
  },

  // 箱制約付き最小二乗を厳密に解く（有効制約法）。r は初期値として使い、結果で上書きする。
  //   mask: 使ってよい列（null なら全部）
  // v83: 反復で少しずつ近づける方法（FISTA）は、主エンジンと姿勢スラスターの
  // 強さが何千倍も違う艦や、複数の主エンジンをそろえて吹かす必要がある艦で
  // 収束に何百フレームもかかった（全開まで数秒かかる・旋回で横滑りする）。
  // 出力比が 0 か 1 に張り付いていないスラスター（自由な列）だけについて
  // 最適解を式で求め（行が6つしかないので 6×6 の連立方程式で済む）、
  // 範囲をはみ出すもの・張り付きを外すべきものを1つずつ入れ替える。
  // 前フレームの解から始めるので、ふつうは数回の入れ替えで終わる。
  _solveCore(a, target, scale, weight, iterations, r, mask) {
    const { N, B } = a;
    const A = a._A;
    const res = a._res;
    const colNorm = a._colNorm;
    const lamCol = a.lamCol;
    const rhs = [0, 0, 0, 0, 0, 0];
    for (let row = 0; row < 6; row++) {
      const c = weight[row] * scale[row];
      rhs[row] = c * target[row];
      for (let k = 0; k < N; k++) A[k * 6 + row] = mask && !mask[k] ? 0 : c * B[k * 6 + row];
    }
    // 列の状態: 0 = 自由、-1 = 0に固定、1 = 1に固定、2 = 使わない（0のまま）
    const st = a._st || (a._st = new Int8Array(N));
    for (let k = 0; k < N; k++) {
      const o = k * 6;
      colNorm[k] = A[o] * A[o] + A[o + 1] * A[o + 1] + A[o + 2] * A[o + 2]
        + A[o + 3] * A[o + 3] + A[o + 4] * A[o + 4] + A[o + 5] * A[o + 5];
      if ((mask && !mask[k]) || colNorm[k] <= 0) { r[k] = 0; st[k] = 2; continue; }
      lamCol[k] = this.L2_REG * (a.isMainCol[k] ? 1 : this.RCS_REG_FACTOR);
      let v = r[k];
      if (!(v > 1e-12)) { r[k] = 0; st[k] = -1; } else if (v >= 1 - 1e-12) { r[k] = 1; st[k] = 1; } else st[k] = 0;
    }
    const G = new Float64Array(36);
    const bp = new Float64Array(6);
    const z = new Float64Array(6);
    const rs = a._rs || (a._rs = new Float64Array(N));
    const maxIter = Math.max(20, 4 * N + 20);
    for (let iter = 0; iter < maxIter; iter++) {
      // 自由な列だけの最適解（列ごとの正則化 λ_k）:
      //   r_F = Λ⁻¹ A_Fᵀ (I + A_F Λ⁻¹ A_Fᵀ)⁻¹ (右辺 − 1に固定した列の寄与)
      for (let i = 0; i < 6; i++) bp[i] = rhs[i];
      G.fill(0);
      for (let i = 0; i < 6; i++) G[i * 7] = 1;
      for (let k = 0; k < N; k++) {
        const o = k * 6;
        if (st[k] === 1) {
          for (let i = 0; i < 6; i++) bp[i] -= A[o + i];
        } else if (st[k] === 0) {
          const il = 1 / lamCol[k];
          for (let i = 0; i < 6; i++) {
            const ai = A[o + i] * il;
            if (ai === 0) continue;
            for (let j = i; j < 6; j++) G[i * 6 + j] += ai * A[o + j];
          }
        }
      }
      for (let i = 0; i < 6; i++) for (let j = 0; j < i; j++) G[i * 6 + j] = G[j * 6 + i];
      this._solve6(G, bp, z);
      // 今の点から最適解へ向かい、範囲（0..1）にぶつかるならそこで止めて固定する
      let alpha = 1, block = -1, blockTo = 0;
      for (let k = 0; k < N; k++) {
        if (st[k] !== 0) continue;
        const o = k * 6;
        const v = (A[o] * z[0] + A[o + 1] * z[1] + A[o + 2] * z[2] + A[o + 3] * z[3] + A[o + 4] * z[4] + A[o + 5] * z[5]) / lamCol[k];
        rs[k] = v;
        if (v < 0) {
          const t = r[k] / (r[k] - v);
          if (t < alpha) { alpha = t; block = k; blockTo = -1; }
        } else if (v > 1) {
          const t = (1 - r[k]) / (v - r[k]);
          if (t < alpha) { alpha = t; block = k; blockTo = 1; }
        }
      }
      for (let k = 0; k < N; k++) if (st[k] === 0) r[k] += alpha * (rs[k] - r[k]);
      if (block >= 0) {
        r[block] = blockTo > 0 ? 1 : 0;
        st[block] = blockTo;
        continue;
      }
      // 最適性の確認: 0に固定した列は増やすと得をしないか、1に固定した列は減らすと得をしないか
      for (let row = 0; row < 6; row++) res[row] = -rhs[row];
      for (let k = 0; k < N; k++) {
        const rk = r[k];
        if (!rk) continue;
        const o = k * 6;
        for (let row = 0; row < 6; row++) res[row] += A[o + row] * rk;
      }
      let worst = -1, worstV = 1e-10;
      for (let k = 0; k < N; k++) {
        if (st[k] !== -1 && st[k] !== 1) continue;
        const o = k * 6;
        const g = A[o] * res[0] + A[o + 1] * res[1] + A[o + 2] * res[2]
          + A[o + 3] * res[3] + A[o + 4] * res[4] + A[o + 5] * res[5] + lamCol[k] * r[k];
        const viol = st[k] === -1 ? -g : g;
        if (viol > worstV) { worstV = viol; worst = k; }
      }
      if (worst < 0) break;
      st[worst] = 0;
    }
    for (let k = 0; k < N; k++) {
      if (r[k] < 0) r[k] = 0; else if (r[k] > 1) r[k] = 1;
    }
    return r;
  },

  // 6×6 の対称正定値の連立方程式 G z = b（コレスキー分解）
  _solve6(G, b, z) {
    const L = this._L || (this._L = new Float64Array(36));
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = G[i * 6 + j];
        for (let k = 0; k < j; k++) sum -= L[i * 6 + k] * L[j * 6 + k];
        if (i === j) L[i * 6 + i] = Math.sqrt(Math.max(sum, 1e-300));
        else L[i * 6 + j] = sum / L[j * 6 + j];
      }
    }
    const y = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) {
      let sum = b[i];
      for (let k = 0; k < i; k++) sum -= L[i * 6 + k] * y[k];
      y[i] = sum / L[i * 6 + i];
    }
    for (let i = 5; i >= 0; i--) {
      let sum = y[i];
      for (let k = i + 1; k < 6; k++) sum -= L[k * 6 + i] * z[k];
      z[i] = sum / L[i * 6 + i];
    }
    return z;
  },

  // 欲しい力・トルク（各成分 -1..1）→ 各スラスターの出力比
  // opts.manualThrottle: 手動のスロットルによる前進は主エンジンの推力までにする
  solve(ship, desiredForce, desiredTorque, opts) {
    const a = this.prepare(ship);
    const lim = this._dockingLimits(ship);
    const comps = [desiredForce.x, desiredForce.y, desiredForce.z, desiredTorque.x, desiredTorque.y, desiredTorque.z];
    const target = new Float64Array(6), scale = new Float64Array(6), weight = new Float64Array(6);
    for (let row = 0; row < 6; row++) {
      const v = clamp(comps[row] || 0, -1, 1);
      let cap = v >= 0 ? a.capPos[row] : a.capNeg[row];
      if (lim) cap = Math.min(cap, lim[row]);
      if (row === 2 && v < 0 && opts && opts.manualThrottle && a.mainFwd > 0) cap = Math.min(cap, a.mainFwd);
      target[row] = v * cap;
      if (row < 3) {
        // 力の誤差の物差し: 要求した力か、姿勢スラスターだけで出せる力の大きい方
        // （要求していない向きへの、主エンジンによる余計な加減速を厳しく抑える）
        const rcs = Math.max(a.rcsCapPos[row], a.rcsCapNeg[row]);
        const base = rcs > 0 ? rcs : Math.max(a.capPos[row], a.capNeg[row]) * 0.05;
        scale[row] = 1 / Math.max(Math.abs(target[row]), base, 1e-9);
      } else {
        scale[row] = 1 / Math.max(a.capPos[row], a.capNeg[row], a.naivePos[row] * 0.05, a.naiveNeg[row] * 0.05, 1e-9);
      }
      // v83: 要求していない向きの力（旋回中の横滑り・加減速）はより強く嫌う
      weight[row] = row < 3 ? (Math.abs(v) < 1e-6 ? this.ZERO_FORCE_WEIGHT : this.FORCE_WEIGHT) : this.TORQUE_WEIGHT;
    }
    const r = a.r; // 前フレームの解から始める（収束が速い）
    this._solveCore(a, target, scale, weight, this.ITERATIONS, r, null);
    const ratios = {};
    for (let i = 0; i < a.ids.length; i++) {
      const v = r[a.colOfThruster[i]];
      // v83: 以前は 1e-4 未満を0に切り捨てていたが、主エンジンが極端に強い艦では
      // 自動ドッキングの微調整に必要な出力比がそれより小さく、何も噴射しなく
      // なって止まってしまった（噴射の見た目は 07-engine-fx.js で1%未満を出さない）
      ratios[a.ids[i]] = v < 1e-12 ? 0 : v;
    }
    return ratios;
  },

  // 自動ドッキング等が使う能力の見積もり（03-thruster-solver.js から呼ぶ）
  estimateMaxAngularAccel(ship) {
    const a = this.prepare(ship);
    const lim = this._dockingLimits(ship);
    const I = ship.inertiaTensor || { x: ship.inertia, y: ship.inertia, z: ship.inertia };
    const f = 0.9;
    const cap = (row) => Math.min(a.capPos[row], a.capNeg[row], lim ? lim[row] : Infinity);
    return {
      x: (cap(3) / I.x) * f,
      y: (cap(4) / I.y) * f,
      z: (cap(5) / I.z) * f,
    };
  },
  estimateMaxLinearDecel(ship) {
    const a = this.prepare(ship);
    const lim = this._dockingLimits(ship);
    return Math.max(1e-3, (Math.min(a.capPos[2], lim ? lim[2] : Infinity) / ship.mass) * 0.85);
  },
  estimateMaxLateralDecel(ship) {
    const a = this.prepare(ship);
    const lim = this._dockingLimits(ship);
    const minForce = Math.min(a.capPos[0], a.capNeg[0], a.capPos[1], a.capNeg[1], lim ? lim[0] : Infinity);
    return Math.max(1e-3, (minForce / ship.mass) * 0.6);
  },

  // v83: その向き（艦のローカル座標の単位ベクトル）に出せる最大の加速度 [m/s²]
  maxAccelAlong(ship, dirLocal) {
    const a = this.prepare(ship);
    const lim = this._dockingLimits(ship);
    let m = 0;
    const comps = [dirLocal.x, dirLocal.y, dirLocal.z];
    for (let i = 0; i < 3; i++) {
      const d = comps[i];
      if (Math.abs(d) < 0.05) continue;
      let cap = d > 0 ? a.capPos[i] : a.capNeg[i];
      if (lim) cap = Math.min(cap, lim[i]);
      m = Math.max(m, cap / ship.mass);
    }
    return m;
  },

  // 出力比 → 実際に生じる力・トルク（艦のローカル座標、物理量）
  resultant(ship, ratios) {
    const a = this.prepare(ship);
    const out = [0, 0, 0, 0, 0, 0];
    const done = new Set();
    for (let i = 0; i < a.ids.length; i++) {
      const k = a.colOfThruster[i];
      if (done.has(k)) continue;
      done.add(k);
      const r = ratios[a.ids[i]] || 0;
      if (!r) continue;
      for (let row = 0; row < 6; row++) out[row] += a.B[k * 6 + row] * r;
    }
    return { force: { x: out[0], y: out[1], z: out[2] }, torque: { x: out[3], y: out[4], z: out[5] } };
  },
};

// =============================================================
// 設計の保存（IndexedDB）
//
// 設計の本体（名前・寸法・性能・スラスター配置など、数KB）と、船体
// モデル（GLB/OBJ、数MB〜数百MB）は別のストアに分けて保存する。
// 設定画面で一覧を出すときに、モデルまで読み込まずに済むようにするため。
// =============================================================
const SHIP_DESIGN_DB_NAME = 'spaceSimShipDesigns';
const SHIP_DESIGN_DB_VERSION = 1;
let shipDesignDbPromise = null;

function openShipDesignDb() {
  if (shipDesignDbPromise) return shipDesignDbPromise;
  shipDesignDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('このブラウザ環境ではIndexedDBが利用できません。'));
      return;
    }
    const req = indexedDB.open(SHIP_DESIGN_DB_NAME, SHIP_DESIGN_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('designs')) db.createObjectStore('designs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('models')) db.createObjectStore('models');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDBを開けませんでした。'));
  });
  return shipDesignDbPromise;
}

function _shipDesignTx(store, mode, fn) {
  return openShipDesignDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

async function listShipDesigns() {
  try {
    const all = await _shipDesignTx('designs', 'readonly', (s) => s.getAll());
    return (all || []).map(normalizeShipDesign).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  } catch (e) {
    console.warn('艦の設計一覧の読み込みに失敗しました。', e);
    return [];
  }
}

async function loadShipDesign(id) {
  if (!id) return null;
  try {
    const d = await _shipDesignTx('designs', 'readonly', (s) => s.get(id));
    return d ? normalizeShipDesign(d) : null;
  } catch (e) {
    console.warn(`艦の設計(${id})の読み込みに失敗しました。`, e);
    return null;
  }
}

// opts.keepTimestamp: 更新日時を書き換えない（同期で他の端末の設計を取り込むとき）
async function saveShipDesign(design, opts) {
  if (!(opts && opts.keepTimestamp)) design.updatedAt = Date.now();
  await _shipDesignTx('designs', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(design))));
  forgetShipDesignTombstone(design.id);
}

async function loadShipDesignModel(id) {
  try {
    return (await _shipDesignTx('models', 'readonly', (s) => s.get(id))) || null;
  } catch (e) {
    console.warn(`艦の設計(${id})のモデルの読み込みに失敗しました。`, e);
    return null;
  }
}

async function saveShipDesignModel(id, model) {
  await _shipDesignTx('models', 'readwrite', (s) => (model ? s.put(model, id) : s.delete(id)));
}

// opts.noTombstone: 削除の記録を残さない（同期で他の端末の削除を反映するとき）
async function deleteShipDesign(id, opts) {
  await _shipDesignTx('designs', 'readwrite', (s) => s.delete(id));
  await _shipDesignTx('models', 'readwrite', (s) => s.delete(id));
  if (!(opts && opts.noTombstone)) recordShipDesignTombstone(id);
}

// -------------------------------------------------------------
// v80: 削除の記録（端末間の同期用）。消した設計が、まだ消していない別の端末から
// 同期で戻ってこないよう、「いつ消したか」を残しておく。
// -------------------------------------------------------------
const SHIP_DESIGN_TOMBSTONE_KEY = 'spaceSimDesignTombstones';
function loadShipDesignTombstones() {
  try {
    return JSON.parse(localStorage.getItem(SHIP_DESIGN_TOMBSTONE_KEY) || '{}') || {};
  } catch (e) {
    return {};
  }
}
function recordShipDesignTombstone(id) {
  const t = loadShipDesignTombstones();
  t[id] = Date.now();
  try { localStorage.setItem(SHIP_DESIGN_TOMBSTONE_KEY, JSON.stringify(t)); } catch (e) {}
}
function forgetShipDesignTombstone(id) {
  const t = loadShipDesignTombstones();
  if (!(id in t)) return;
  delete t[id];
  try { localStorage.setItem(SHIP_DESIGN_TOMBSTONE_KEY, JSON.stringify(t)); } catch (e) {}
}
