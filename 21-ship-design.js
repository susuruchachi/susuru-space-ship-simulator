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
    main: { position: { x: 0, y: 0, z: dims.z / 2 }, thrust: auto.mainThrust },
    retro: { thrust: auto.retroThrust },
    rcs: { thrust: auto.rcsThrust, pods: defaultRcsPodsForBox(dims) },
    maxSpeed: auto.maxSpeed,
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

// 古いデータや手で書き換えたデータでも壊れないよう、足りない項目を補う
function normalizeShipDesign(d) {
  if (!d) return null;
  const base = createShipDesign(d.baseClass || 'rocket', d.name);
  const out = { ...base, ...d };
  out.hull = { ...base.hull, ...(d.hull || {}) };
  out.main = { ...base.main, ...(d.main || {}) };
  out.retro = { ...base.retro, ...(d.retro || {}) };
  out.rcs = { ...base.rcs, ...(d.rcs || {}) };
  if (!Array.isArray(out.rcs.pods)) out.rcs.pods = [];
  out.cog = { ...base.cog, ...(d.cog || {}) };
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

  // 主エンジン: 後方(+Z)へ噴射し、艦を前方(-Z)へ押す
  thrusters.push({
    id: 'main', position: P(d.main.position), direction: { x: 0, y: 0, z: 1 },
    maxThrust: Math.max(0, d.main.thrust), kind: 'main',
  });
  // 逆噴射: 艦首の面に、重心の左右対称に2基（重心をはさむので回転を生まない）
  if (d.retro.thrust > 0) {
    const zFront = -dims.z / 2;
    const dx = dims.x * 0.15;
    for (const [id, sx] of [['retro_left', -1], ['retro_right', 1]]) {
      thrusters.push({
        id, position: P({ x: c.x + sx * dx, y: c.y, z: zFront }), direction: { x: 0, y: 0, z: -1 },
        maxThrust: d.retro.thrust / 2, kind: 'rcs', group: 'retro',
      });
    }
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
    maxSpeed: Math.max(1, d.maxSpeed),
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
  ship.maxAngularSpeed = spec.maxAngularSpeed;
  ship.speedCapMode = spec.speedCapMode;
  ship.size = spec.size;
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
// という箱制約付き最小二乗問題を、加速付きの射影勾配法（FISTA）で解く。
// トルクの誤差に大きな重みを置くので、重心が主エンジンの推力線から
// ずれていても、姿勢スラスターで回転を打ち消すように配分される
// （打ち消しきれない場合は主エンジンの出力が自動的に絞られる）。
// 回転の能力（どれだけ強く回せるか）は姿勢スラスターだけで見積もる。
// 逆噴射の左右2基は1組として同じ出力で吹かす（片側だけ吹かして回転に
// 使うような配分をしない）。正則化は出力比の2乗の小さな項だけにする
// （出力比そのものに比例するコストを入れると、小さな要求に対して何も
// 噴射しない「不感帯」ができ、自動ドッキングの微調整が効かなくなるため）。
//
// 従来の艦種プリセット（03-thruster-solver.js の貪欲法）とは別の方式で、
// 自作の艦（ship.allocation === 'balanced'）にだけ使う。
// =============================================================
const ShipAllocator = {
  ITERATIONS: 80,
  CAP_ITERATIONS: 400,
  FORCE_WEIGHT: 1.0,
  TORQUE_WEIGHT: 3.0,
  L2_REG: 2e-4,  // 出力比の2乗和の小さな正則化（解を一意にする）

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
        cols.push({ isEngine: false });
      }
      colOfThruster[i] = c;
      if (t.kind === 'main' || t.id.startsWith('retro')) cols[c].isEngine = true;
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
    const a = {
      thrusters: ts, capRatio, N, B, naivePos, naiveNeg, colOfThruster,
      ids: ts.map((t) => t.id),
      r: new Float64Array(N),
      capPos: new Float64Array(6), capNeg: new Float64Array(6),
      _A: new Float64Array(6 * N), _y: new Float64Array(N), _x: new Float64Array(N),
      _xPrev: new Float64Array(N), _res: new Float64Array(6),
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
        }
        if (sign > 0) a.capPos[row] = cap; else a.capNeg[row] = cap;
      }
    }
    return a;
  },

  // 箱制約付き最小二乗（FISTA）。r は初期値として使い、結果で上書きする。
  //   mask: 使ってよい列（null なら全部）
  _solveCore(a, target, scale, weight, iterations, r, mask) {
    const { N, B } = a;
    const A = a._A;
    const bvec = a._res; // 一時的に右辺を入れる
    const rhs = [0, 0, 0, 0, 0, 0];
    for (let row = 0; row < 6; row++) {
      const c = weight[row] * scale[row];
      rhs[row] = c * target[row];
      for (let k = 0; k < N; k++) A[k * 6 + row] = mask && !mask[k] ? 0 : c * B[k * 6 + row];
    }
    // リプシッツ定数 = (A Aᵀ) の最大固有値（6x6 なのでべき乗法で十分）
    const M = new Float64Array(36);
    for (let i = 0; i < 6; i++) {
      for (let j = i; j < 6; j++) {
        let s = 0;
        for (let k = 0; k < N; k++) s += A[k * 6 + i] * A[k * 6 + j];
        M[i * 6 + j] = s; M[j * 6 + i] = s;
      }
    }
    let v = [1, 1, 1, 1, 1, 1], lam = 0;
    for (let it = 0; it < 40; it++) {
      const w = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) w[i] += M[i * 6 + j] * v[j];
      const n = Math.hypot(...w);
      if (n < 1e-30) break;
      lam = n / Math.max(1e-30, Math.hypot(...v));
      v = w.map((x) => x / n);
    }
    const L = Math.max(lam, 1e-12) + this.L2_REG;
    const step = 1 / L;
    const y = a._y, xPrev = a._xPrev, x = a._x;
    for (let k = 0; k < N; k++) { y[k] = r[k]; xPrev[k] = r[k]; }
    let tk = 1;
    for (let it = 0; it < iterations; it++) {
      // 残差 = A y − rhs
      for (let row = 0; row < 6; row++) bvec[row] = -rhs[row];
      for (let k = 0; k < N; k++) {
        const yk = y[k];
        if (yk === 0) continue;
        const o = k * 6;
        bvec[0] += A[o] * yk; bvec[1] += A[o + 1] * yk; bvec[2] += A[o + 2] * yk;
        bvec[3] += A[o + 3] * yk; bvec[4] += A[o + 4] * yk; bvec[5] += A[o + 5] * yk;
      }
      // 勾配ステップ → [0,1] へ射影
      for (let k = 0; k < N; k++) {
        const o = k * 6;
        const g = A[o] * bvec[0] + A[o + 1] * bvec[1] + A[o + 2] * bvec[2]
          + A[o + 3] * bvec[3] + A[o + 4] * bvec[4] + A[o + 5] * bvec[5]
          + this.L2_REG * y[k];
        let nx = y[k] - step * g;
        if (nx < 0 || (mask && !mask[k])) nx = 0; else if (nx > 1) nx = 1;
        x[k] = nx;
      }
      const tk1 = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2;
      const mom = (tk - 1) / tk1;
      for (let k = 0; k < N; k++) {
        y[k] = x[k] + mom * (x[k] - xPrev[k]);
        if (y[k] < 0) y[k] = 0; else if (y[k] > 1) y[k] = 1;
        xPrev[k] = x[k];
      }
      tk = tk1;
    }
    for (let k = 0; k < N; k++) r[k] = xPrev[k];
    return r;
  },

  // 欲しい力・トルク（各成分 -1..1）→ 各スラスターの出力比
  solve(ship, desiredForce, desiredTorque) {
    const a = this.prepare(ship);
    const comps = [desiredForce.x, desiredForce.y, desiredForce.z, desiredTorque.x, desiredTorque.y, desiredTorque.z];
    const target = new Float64Array(6), scale = new Float64Array(6), weight = new Float64Array(6);
    for (let row = 0; row < 6; row++) {
      const v = clamp(comps[row] || 0, -1, 1);
      const cap = v >= 0 ? a.capPos[row] : a.capNeg[row];
      target[row] = v * cap;
      scale[row] = 1 / Math.max(a.capPos[row], a.capNeg[row], a.naivePos[row] * 0.05, a.naiveNeg[row] * 0.05, 1e-9);
      weight[row] = row < 3 ? this.FORCE_WEIGHT : this.TORQUE_WEIGHT;
    }
    const r = a.r; // 前フレームの解から始める（収束が速い）
    this._solveCore(a, target, scale, weight, this.ITERATIONS, r, null);
    const ratios = {};
    for (let i = 0; i < a.ids.length; i++) {
      const v = r[a.colOfThruster[i]];
      ratios[a.ids[i]] = v < 1e-4 ? 0 : v;
    }
    return ratios;
  },

  // 自動ドッキング等が使う能力の見積もり（03-thruster-solver.js から呼ぶ）
  estimateMaxAngularAccel(ship) {
    const a = this.prepare(ship);
    const I = ship.inertiaTensor || { x: ship.inertia, y: ship.inertia, z: ship.inertia };
    const f = 0.9;
    return {
      x: (Math.min(a.capPos[3], a.capNeg[3]) / I.x) * f,
      y: (Math.min(a.capPos[4], a.capNeg[4]) / I.y) * f,
      z: (Math.min(a.capPos[5], a.capNeg[5]) / I.z) * f,
    };
  },
  estimateMaxLinearDecel(ship) {
    const a = this.prepare(ship);
    return Math.max(1e-3, (a.capPos[2] / ship.mass) * 0.85);
  },
  estimateMaxLateralDecel(ship) {
    const a = this.prepare(ship);
    const minForce = Math.min(a.capPos[0], a.capNeg[0], a.capPos[1], a.capNeg[1]);
    return Math.max(1e-3, (minForce / ship.mass) * 0.6);
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
