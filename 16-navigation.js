// =============================================================
// 16-navigation.js
// 航法: 艦の座標系（どの天体と一緒に動くか）・ワープ・自動航行・地表への衝突防止
//
// v77: 太陽系を実寸で再現したことに伴い新設。
//
// 座標系（フレーム）の考え方:
//   艦の物理（04-flight-physics.js）や自動ドッキング（03-thruster-solver.js）、
//   ドッキングポート（10-docking-platform.js）は従来どおり「ローカル座標」
//   （単位m、原点付近にポートがある）だけで動く。ここでは、そのローカル座標が
//   宇宙のどこにあり、どちらを向いているかを決める。
//     宇宙座標 = 基準天体の位置 + offset + rot × ローカル座標
//   - 母港フレーム: 地球の高度2,000kmの点を原点とし、地球と一緒に動く。
//     ドッキングポートの座標はすべてこのフレームの値。軸の向きは起動時の
//     太陽と地球の位置関係から、前方やや下に地球、右手に太陽が来るよう決める。
//   - それ以外: ワープ中・ワープ後は、最寄りの天体（影響圏の内側）と一緒に動く
//     フレームに乗る（軸は宇宙座標と同じ）。到着した天体に対して静止する。
//
// ワープ（巡航ドライブ）:
//   光速を大きく超える移動が必要なので、通常の推進とは別の「ワープ」で移動する。
//   速度の上限は「最寄りの天体の表面までの距離 × 1/秒」（天体の近くでは自動的に
//   減速する、Elite: Dangerous の超光速巡航に近い考え方）。スロットルで
//   1km/s〜光速の約2000倍の間を対数的に選ぶ。
// =============================================================

const Navigation = {
  HOME_ALTITUDE_KM: 2000,
  // 母港の向き: 地球の中心が「前方から何度下」に見えるか
  HOME_EARTH_BELOW_DEG: 70,

  WARP_K_SURFACE: 1.3,           // 速度上限 = 表面までの距離 × この値 [1/s]
  WARP_K_TARGET: 1.4,            // 自動航行時の目的地までの距離による上限 [1/s]
  WARP_MIN_SPEED: 1000,          // スロットル0%付近の速度 [m/s]
  WARP_MAX_SPEED: 2000 * 299792458, // 太陽系内での最高速（光速の2000倍）
  WARP_ACCEL_DECADES: 1.8,       // 1秒あたりに速度が何桁上がるか
  WARP_DECEL_DECADES: 3.0,
  // v83: 自動航行の到着（この距離・速さまで減速してからワープを抜ける）
  ARRIVAL_DISTANCE: 25,          // [m]
  ARRIVAL_SPEED: 25,             // [m/s]
  // 到着後に天体のほうへ向き直るときの最大角速度 [rad/s]（ゆっくり回す）
  ARRIVAL_TURN_RATE: 0.12,
  arrivalHold: null, // 到着後の姿勢合わせ { kind: 'body', bodyId } | { kind: 'home' }

  frame: null,      // { bodyId, offset, rot(3x3 local→universe), rotT, quat(THREE), isHome }
  homeFrame: null,
  target: null,     // { kind: 'body'|'home', id }
  warp: {
    active: false,
    speed: 0,
    throttle: 0.6,  // 0..1（キーボード操作時の保持値）
    autopilot: false,
    status: '',
  },
  lastCollisionWarning: 0,
  _shipU: { x: 0, y: 0, z: 0 },

  init() {
    SolarSystem.update(SimClock.jd);
    this.homeFrame = this._computeHomeFrame();
    this.frame = this._cloneFrame(this.homeFrame);
  },

  _cloneFrame(f) {
    return { ...f, offset: { ...f.offset }, rot: f.rot.slice(), rotT: f.rotT.slice(), quat: f.quat.clone() }; // orbit・lagrange は共有でよい（変更しない）
  },

  isHome() {
    return !!(this.frame && this.frame.isHome);
  },

  isWarping() {
    return this.warp.active;
  },

  // -----------------------------------------------------------
  // 母港フレームの計算
  // -----------------------------------------------------------
  _computeHomeFrame() {
    const earth = SolarSystem.byId.earth;
    const sun = SolarSystem.byId.sun;
    const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const add = (a, b, s = 1) => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
    const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });

    const s = norm({ x: sun.pos.x - earth.pos.x, y: sun.pos.y - earth.pos.y, z: sun.pos.z - earth.pos.z });
    const north = { x: 0, y: 1, z: 0 };
    const nPerp = norm(add(north, s, -dot(north, s)));
    // 母港は昼側（太陽直下点から60°北寄り）の上空。見下ろすと昼の地球と、奥に夜の側が見える
    const a60 = (60 * Math.PI) / 180;
    const u = norm(add(scale(s, Math.cos(a60)), nPerp, Math.sin(a60)));
    const e = scale(u, -1); // 母港から地球中心への方向

    // 水平方向 h（u に直交）を回して、太陽が右手やや前方に来る向きを探す
    let h0 = norm(cross(u, { x: 0, y: 0, z: 1 }));
    if (!Number.isFinite(h0.x)) h0 = norm(cross(u, { x: 1, y: 0, z: 0 }));
    const h1 = cross(u, h0);
    const beta = (this.HOME_EARTH_BELOW_DEG * Math.PI) / 180;
    let best = null;
    for (let deg = 0; deg < 360; deg += 2) {
      const t = (deg * Math.PI) / 180;
      const h = add(scale(h0, Math.cos(t)), h1, Math.sin(t));
      const f = norm(add(scale(e, Math.cos(beta)), h, Math.sin(beta)));   // 前方(-Z)
      const dn = norm(add(scale(e, Math.sin(beta)), h, -Math.cos(beta))); // 下(-Y)
      const Z = scale(f, -1), Y = scale(dn, -1);
      const X = cross(Y, Z);
      const sl = { x: dot(s, X), y: dot(s, Y), z: dot(s, Z) };
      const score = sl.x * 1.0 - sl.z * 0.35 + sl.y * 0.15;
      if (!best || score > best.score) best = { score, X, Y, Z };
    }
    const rot = Astro.mat3FromColumns(best.X, best.Y, best.Z);
    const r0 = earth.rM + this.HOME_ALTITUDE_KM * 1000;
    const offset = scale(u, r0);
    const f = this._makeFrame('earth', offset, rot, true);
    // v85: 母港は地球を回る円軌道に乗っている。フレームの原点（ポートの付近）が軌道を回り、
    // 軸も一緒に回る（地球が常に同じ向きに見える）。ポートの座標はこのフレームの値のまま
    const nrm = norm(add(north, u, -dot(north, u)));
    f.orbit = {
      r0, u0: u, nrm, rot0: rot.slice(), jd0: SimClock.jd,
      n: Math.sqrt((earth.gm * 1e9) / (r0 * r0 * r0)), // 平均運動 [rad/s]
    };
    return f;
  },

  // -----------------------------------------------------------
  // v85: 天体の重力
  //
  // 艦の物理は「フレーム」（ローカル座標）の中で計算するので、艦に働く重力から
  // フレームの原点そのものの加速度を引いた分が、フレームの中で見た加速度になる。
  //   天体と一緒に動くフレーム: 原点の加速度 = その天体が他の天体から受ける重力
  //     （地上に静止している人が「重力で落ちる」のと同じ。止まっていれば天体へ落ちる）
  //   母港（円軌道を回るフレーム）・ラグランジュ点: 原点は重力だけで動いている
  //     （自由落下）ので、原点の近くでは重力がほぼ打ち消し合う。母港は回転するフレームなので
  //     コリオリの力・遠心力も加える（ポートの近くで止まっていると、ゆっくり離れていく）
  // -----------------------------------------------------------
  GRAVITY_MIN_GM: 1e-3, // [km^3/s^2] これより小さな天体の重力は無視する

  gravityOn() {
    return State.settings.gravityEnabled !== false;
  },

  // 母港以外では、速度を保つ・止める補助（スロットル＝目標の速度、横滑りの自動停止、
  // 最高速度）を使わない（重力で回っている軌道を壊してしまうため）。スロットルは推力の割合
  newtonianFlight() {
    return this.gravityOn() && !!this.frame && !this.frame.isHome && !this.warp.active;
  },

  // 点 p（宇宙座標）での重力加速度の合計 [m/s^2]。skipId の天体は除く
  _gAt(p, skipId) {
    let ax = 0, ay = 0, az = 0;
    for (const b of SolarSystem.bodies) {
      if (b.id === skipId || !(b.gm > this.GRAVITY_MIN_GM)) continue;
      const dx = b.pos.x - p.x, dy = b.pos.y - p.y, dz = b.pos.z - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const rMin = b.rM * 0.5;
      if (d2 < rMin * rMin) continue;
      const k = (b.gm * 1e9) / (d2 * Math.sqrt(d2));
      ax += dx * k; ay += dy * k; az += dz * k;
    }
    return { x: ax, y: ay, z: az };
  },

  _gOne(b, p) {
    const dx = b.pos.x - p.x, dy = b.pos.y - p.y, dz = b.pos.z - p.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const k = (b.gm * 1e9) / (d2 * Math.sqrt(d2));
    return { x: dx * k, y: dy * k, z: dz * k };
  },

  // フレームの原点の加速度（宇宙座標）
  _frameOriginAccel(f) {
    if (f.lagrange) return this._gAt(this.frameOrigin(f), null);
    const body = SolarSystem.byId[f.bodyId];
    const a = this._gAt(body.pos, body.id);
    if (f.orbit) {
      const g = this._gOne(body, this.frameOrigin(f));
      a.x += g.x; a.y += g.y; a.z += g.z;
    }
    return a;
  },

  // フレームの回転の角速度ベクトル（宇宙座標）。回らないフレームは null
  _frameOmega(f) {
    if (!f.orbit) return null;
    const o = f.orbit;
    return { x: o.nrm.x * o.n, y: o.nrm.y * o.n, z: o.nrm.z * o.n };
  },

  // 艦（ローカル座標の位置・速度）に働く重力などの加速度（ローカル座標）
  gravityAccel(ship) {
    if (!this.gravityOn() || !this.frame || this.warp.active) return null;
    const f = this.frame;
    const u = this.localToUniverse(ship.position);
    const aS = this._gAt(u, null);
    const aO = this._frameOriginAccel(f);
    let a = { x: aS.x - aO.x, y: aS.y - aO.y, z: aS.z - aO.z };
    const w = this._frameOmega(f);
    if (w) {
      const r = Astro.mat3MulVec(f.rot, ship.position);
      const v = Astro.mat3MulVec(f.rot, ship.velocity);
      const cr = (p, q) => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x });
      const cor = cr(w, v), cen = cr(w, cr(w, r));
      a = { x: a.x - 2 * cor.x - cen.x, y: a.y - 2 * cor.y - cen.y, z: a.z - 2 * cor.z - cen.z };
    }
    return Astro.mat3MulVec(f.rotT, a);
  },

  // 天体の速度（前のフレームとの位置の差から）[m/s]
  _bodyVel: {},
  _prevBodyPos: null,
  _prevJd: null,
  _updateBodyVelocities() {
    const jd = SolarSystem.jd;
    if (this._prevBodyPos && this._prevJd !== null && jd !== this._prevJd) {
      const dt = (jd - this._prevJd) * 86400;
      for (const b of SolarSystem.bodies) {
        const p = this._prevBodyPos[b.id];
        if (p) this._bodyVel[b.id] = { x: (b.pos.x - p.x) / dt, y: (b.pos.y - p.y) / dt, z: (b.pos.z - p.z) / dt };
      }
    }
    if (jd !== this._prevJd) {
      this._prevBodyPos = {};
      for (const b of SolarSystem.bodies) this._prevBodyPos[b.id] = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
      this._prevJd = jd;
    }
  },
  bodyVelocity(id) {
    return this._bodyVel[id] || { x: 0, y: 0, z: 0 };
  },

  // フレームの中の点 pLocal が宇宙座標で動く速度
  _framePointVelocity(f, pLocal) {
    let v;
    if (f.lagrange) v = this._lagrangePoint(f.lagrange, true);
    else {
      const bv = this.bodyVelocity(f.bodyId);
      v = { x: bv.x, y: bv.y, z: bv.z };
    }
    const w = this._frameOmega(f);
    if (w) {
      const r = { x: f.offset.x, y: f.offset.y, z: f.offset.z };
      const rp = Astro.mat3MulVec(f.rot, pLocal);
      r.x += rp.x; r.y += rp.y; r.z += rp.z;
      v.x += w.y * r.z - w.z * r.y; v.y += w.z * r.x - w.x * r.z; v.z += w.x * r.y - w.y * r.x;
    }
    return v;
  },

  // 母港フレームを、時刻に合わせて軌道上の位置・向きへ動かす
  _applyHomeOrbit(f) {
    const o = f.orbit;
    if (!o) return;
    const th = o.n * (SimClock.jd - o.jd0) * 86400;
    const R = this._axisAngleMat(o.nrm, th);
    const p = Astro.mat3MulVec(R, o.u0);
    f.offset = { x: p.x * o.r0, y: p.y * o.r0, z: p.z * o.r0 };
    f.rot = Astro.mat3Mul(R, o.rot0);
    f.rotT = Astro.mat3Transpose(f.rot);
    const q = Astro.quatFromMat3(f.rot);
    f.quat.set(q.x, q.y, q.z, q.w);
  },

  // 軸 n（単位ベクトル）まわりに角度 a 回す回転行列（mat3、行優先）
  _axisAngleMat(n, a) {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    const { x, y, z } = n;
    return [
      t * x * x + c, t * x * y - s * z, t * x * z + s * y,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c,
    ];
  },

  // -----------------------------------------------------------
  // v85: ラグランジュ点（主天体 primary と、それを回る天体 secondary の組）
  //   L1・L2: secondary の手前・向こう（ヒル半径の距離）
  //   L3: primary をはさんだ反対側
  //   L4・L5: 公転の向きに60°前・後ろ（primary・secondary と正三角形）
  // velocity=true なら、その点の速度を返す（位置と同じ式に天体の速度を入れる）
  // -----------------------------------------------------------
  _lagrangePoint(L, velocity) {
    const P = SolarSystem.byId[L.primary], S = SolarSystem.byId[L.secondary];
    const pp = velocity ? this.bodyVelocity(P.id) : P.pos, sp = velocity ? this.bodyVelocity(S.id) : S.pos;
    const R = { x: sp.x - pp.x, y: sp.y - pp.y, z: sp.z - pp.z };
    const mu = S.gm / (P.gm + S.gm);
    const h = Math.cbrt(mu / 3);
    switch (L.n) {
      case 1: return { x: sp.x - R.x * h, y: sp.y - R.y * h, z: sp.z - R.z * h };
      case 2: return { x: sp.x + R.x * h, y: sp.y + R.y * h, z: sp.z + R.z * h };
      case 3: { const k = 1 + (5 * mu) / 12; return { x: pp.x - R.x * k, y: pp.y - R.y * k, z: pp.z - R.z * k }; }
      default: {
        const M = this._axisAngleMat(L.normal, (L.n === 4 ? 1 : -1) * Math.PI / 3);
        const r = Astro.mat3MulVec(M, R);
        return { x: pp.x + r.x, y: pp.y + r.y, z: pp.z + r.z };
      }
    }
  },

  // body を回る主天体（衛星なら親の惑星、惑星などは太陽）
  lagrangePrimary(b) {
    if (!b || b.type === 'star') return null;
    return b.parent && SolarSystem.byId[b.parent] ? SolarSystem.byId[b.parent] : SolarSystem.byId.sun;
  },

  _lagrangeSpec(b, n) {
    const P = this.lagrangePrimary(b);
    if (!P) return null;
    const R = { x: b.pos.x - P.pos.x, y: b.pos.y - P.pos.y, z: b.pos.z - P.pos.z };
    const vp = this.bodyVelocity(P.id), vs = this.bodyVelocity(b.id);
    const V = { x: vs.x - vp.x, y: vs.y - vp.y, z: vs.z - vp.z };
    let nrm = { x: R.y * V.z - R.z * V.y, y: R.z * V.x - R.x * V.z, z: R.x * V.y - R.y * V.x };
    let l = Math.hypot(nrm.x, nrm.y, nrm.z);
    if (!(l > 0)) { nrm = { x: 0, y: 1, z: 0 }; l = 1; }
    return { primary: P.id, secondary: b.id, n, normal: { x: nrm.x / l, y: nrm.y / l, z: nrm.z / l } };
  },

  // 毎フレーム（SolarSystem.update の後、艦の物理の前）
  updateFrames() {
    this._updateBodyVelocities();
    this._applyHomeOrbit(this.homeFrame);
    if (this.frame.orbit) this._applyHomeOrbit(this.frame);
  },

  _makeFrame(bodyId, offset, rot, isHome) {
    const q = Astro.quatFromMat3(rot);
    return {
      bodyId,
      offset: { x: offset.x, y: offset.y, z: offset.z },
      rot,
      rotT: Astro.mat3Transpose(rot),
      quat: new THREE.Quaternion(q.x, q.y, q.z, q.w),
      isHome: !!isHome,
    };
  },

  // -----------------------------------------------------------
  // 座標変換
  // -----------------------------------------------------------
  frameOrigin(frame) {
    const f = frame || this.frame;
    if (f.lagrange) {
      const L = this._lagrangePoint(f.lagrange, false);
      return { x: L.x + f.offset.x, y: L.y + f.offset.y, z: L.z + f.offset.z };
    }
    const b = SolarSystem.byId[f.bodyId];
    return { x: b.pos.x + f.offset.x, y: b.pos.y + f.offset.y, z: b.pos.z + f.offset.z };
  },

  localToUniverse(p, frame) {
    const f = frame || this.frame;
    const o = this.frameOrigin(f);
    const r = Astro.mat3MulVec(f.rot, p);
    return { x: o.x + r.x, y: o.y + r.y, z: o.z + r.z };
  },

  universeToLocal(u, frame) {
    const f = frame || this.frame;
    const o = this.frameOrigin(f);
    return Astro.mat3MulVec(f.rotT, { x: u.x - o.x, y: u.y - o.y, z: u.z - o.z });
  },

  shipUniverse() {
    const ship = State.ship;
    if (!ship) return this.frameOrigin();
    return this.localToUniverse(ship.position);
  },

  // 艦の宇宙座標での向き（クォータニオン）
  shipUniverseQuat() {
    const ship = State.ship;
    const q = new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    return this.frame.quat.clone().multiply(q);
  },

  // Universe.setView() に渡す視点（カメラはローカル座標系のTHREE.Camera）
  buildView(camera) {
    const f = this.frame;
    const r = Astro.mat3MulVec(f.rot, camera.position);
    // v85: ラグランジュ点のフレームは原点が天体の位置+offset ではないので、天体からの位置に直す
    let off = f.offset;
    if (f.lagrange) {
      const o = this.frameOrigin(f), b = SolarSystem.byId[f.bodyId];
      off = { x: o.x - b.pos.x, y: o.y - b.pos.y, z: o.z - b.pos.z };
    }
    return {
      anchorId: f.bodyId,
      offset: { x: off.x + r.x, y: off.y + r.y, z: off.z + r.z },
      quat: f.quat.clone().multiply(camera.quaternion),
      fov: camera.fov,
      aspect: camera.aspect,
    };
  },

  // -----------------------------------------------------------
  // フレームの切り替え（艦の宇宙座標・向きは変えずに、基準だけ付け替える）
  // -----------------------------------------------------------
  // carry: 艦の宇宙での速度を保つ（フレームどうしの動きの違いを速度に足す。重力で
  // 軌道を回っている艦の原点の付け替え・影響圏の乗り換え用）。false なら従来どおり
  // 「向きの違いの分だけ回す」（ワープの出入りなど、新しいフレームに対して止める場合）
  switchFrame(newFrame, carry) {
    const ship = State.ship;
    const old = this.frame;
    if (ship) {
      const u = this.localToUniverse(ship.position, old);
      const qU = old.quat.clone().multiply(new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w));
      const p = this.universeToLocal(u, newFrame);
      const qL = newFrame.quat.clone().invert().multiply(qU).normalize();
      // 速度・角速度はローカル（艦固定/フレーム）基準なので、向きの変化分だけ回す
      let v = Astro.mat3MulVec(newFrame.rotT, Astro.mat3MulVec(old.rot, ship.velocity));
      if (carry) {
        const vu = Astro.mat3MulVec(old.rot, ship.velocity);
        const vo = this._framePointVelocity(old, ship.position);
        const vn = this._framePointVelocity(newFrame, p);
        v = Astro.mat3MulVec(newFrame.rotT, { x: vu.x + vo.x - vn.x, y: vu.y + vo.y - vn.y, z: vu.z + vo.z - vn.z });
      }
      ship.position = { x: p.x, y: p.y, z: p.z };
      ship.quaternion = { x: qL.x, y: qL.y, z: qL.z, w: qL.w };
      ship.velocity = v;
      this._shiftEngineParticles(old, newFrame);
    }
    this.frame = newFrame;
    if (!newFrame.isHome && ship) ship.autoDockingEnabled = false;
  },

  // 噴射の粒子（ローカル座標で保持されている）を新しいフレームへ写す
  _shiftEngineParticles(oldF, newF) {
    if (typeof EngineFx === 'undefined') return;
    for (const pool of [EngineFx._mainPool, EngineFx._rcsPool]) {
      if (!pool) continue;
      for (const p of pool.particles) {
        if (!p.active) continue;
        const u = this.localToUniverse({ x: p.x, y: p.y, z: p.z }, oldF);
        const l = this.universeToLocal(u, newF);
        const v = Astro.mat3MulVec(newF.rotT, Astro.mat3MulVec(oldF.rot, { x: p.vx, y: p.vy, z: p.vz }));
        p.x = l.x; p.y = l.y; p.z = l.z;
        p.vx = v.x; p.vy = v.y; p.vz = v.z;
      }
    }
  },

  // 艦の現在位置を原点とし、最寄りの天体と一緒に動くフレームへ乗り換える
  _rebaseToDominantBody(keepRotation, carry) {
    const u = this.shipUniverse();
    const body = SolarSystem.dominantBody(u);
    const rot = keepRotation ? this.frame.rot : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const offset = { x: u.x - body.pos.x, y: u.y - body.pos.y, z: u.z - body.pos.z };
    this.switchFrame(this._makeFrame(body.id, offset, rot, false), carry);
  },

  // 決まった天体と一緒に動くフレームへ（艦の位置を原点に）
  _rebaseToBody(body, carry) {
    const u = this.shipUniverse();
    const offset = { x: u.x - body.pos.x, y: u.y - body.pos.y, z: u.z - body.pos.z };
    this.switchFrame(this._makeFrame(body.id, offset, [1, 0, 0, 0, 1, 0, 0, 0, 1], false), carry);
  },

  goHomeFrameIfNear() {
    // 母港の近く（100km以内）に戻ってきたら母港フレームへ
    const u = this.shipUniverse();
    const o = this.frameOrigin(this.homeFrame);
    if (Math.hypot(u.x - o.x, u.y - o.y, u.z - o.z) < 100e3) {
      this.switchFrame(this._cloneFrame(this.homeFrame));
      return true;
    }
    return false;
  },

  // -----------------------------------------------------------
  // 目的地
  // -----------------------------------------------------------
  setTarget(target) {
    this.target = target;
  },

  targetLabel(t) {
    const tg = t || this.target;
    if (!tg) return '';
    if (tg.kind === 'home') return '母港（地球周回軌道）';
    const b = SolarSystem.byId[tg.id];
    return b ? b.ja : '';
  },

  // 目的地の到着点（宇宙座標）と、目的地として見る天体の中心
  targetArrival(t) {
    const tg = t || this.target;
    if (!tg) return null;
    if (tg.kind === 'home') {
      const local = { x: 0, y: 150, z: 2500 };
      const p = this.localToUniverse(local, this.homeFrame);
      const c = this.frameOrigin(this.homeFrame);
      // v85: 母港は軌道を回っているので、到着点も動いている（その速度）
      return { point: p, center: c, arrivalDist: 0, body: SolarSystem.byId.earth, velocity: this._framePointVelocity(this.homeFrame, local) };
    }
    const b = SolarSystem.byId[tg.id];
    if (!b) return null;
    // v85: ラグランジュ点へ
    const mode = this.arrivalMode;
    if (mode.kind === 'lagrange' && this.lagrangePrimary(b)) {
      const spec = this._lagrangeSpec(b, mode.n);
      const p = this._lagrangePoint(spec, false);
      return { point: p, center: b.pos, arrivalDist: 0, body: b, lagrange: spec, velocity: this._lagrangePoint(spec, true) };
    }
    const shipU = this._shipU;
    const sun = SolarSystem.byId.sun;
    // v85: 軌道に乗せる高度（指定が無ければ、天体全体が画面に収まる距離）
    const arrivalDist = this.orbitRadius(b);
    // 到着方向: 艦のいる側と太陽の側の中間（昼側が見えるように）
    let dx = shipU.x - b.pos.x, dy = shipU.y - b.pos.y, dz = shipU.z - b.pos.z;
    let dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    if (b.id !== 'sun') {
      let sx = sun.pos.x - b.pos.x, sy = sun.pos.y - b.pos.y, sz = sun.pos.z - b.pos.z;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl; sy /= sl; sz /= sl;
      dx = dx * 0.55 + sx * 0.45; dy = dy * 0.55 + sy * 0.45; dz = dz * 0.55 + sz * 0.45;
      dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
    }
    return {
      point: { x: b.pos.x + dx * arrivalDist, y: b.pos.y + dy * arrivalDist, z: b.pos.z + dz * arrivalDist },
      center: b.pos,
      arrivalDist,
      body: b,
    };
  },

  // v85: 自動航行の到着のしかた。{ kind: 'orbit', altitudeKm: null（自動）| 数値 } | { kind: 'lagrange', n: 1..5 }
  arrivalMode: { kind: 'orbit', altitudeKm: null },

  // 軌道に乗せる半径 [m]（天体の中心から）。高度の指定が低すぎるときは、地表への衝突防止の高さまで上げる
  orbitRadius(b) {
    const R = Math.max(b.rM, b.rpM, b.rbM);
    const alt = this.arrivalMode.altitudeKm;
    const minR = R + this.minAltitude(b) * 1.05;
    if (alt > 0) return Math.max(minR, b.rM + alt * 1000);
    return Math.max(minR, this.arrivalDistance(b));
  },

  // 到着地点の天体中心からの距離: 追従カメラの画面（縦60°）に天体全体が
  // 収まる程度（見かけの直径 約25°、環のある惑星は環まで収まる距離）
  arrivalDistance(b) {
    if (b.type === 'star') return b.rM * 14;
    if (b.rings) return Math.max(b.rM * 4.5, b.rings.outer * 1000 * 3.4);
    const R = Math.max(b.rM, b.rpM, b.rbM);
    return Math.max(R * 4.5, R + 30e3);
  },

  // -----------------------------------------------------------
  // ワープ
  // -----------------------------------------------------------
  engageWarp(autopilot) {
    const ship = State.ship;
    if (!ship) return false;
    if (autopilot && !this.target) return false;
    this.warp.active = true;
    this.warp.autopilot = !!autopilot;
    this._leverTouched = false;
    this.warp.speed = Math.max(this.WARP_MIN_SPEED, vecLength(ship.velocity));
    ship.autoDockingEnabled = false;
    this.arrivalHold = null;
    // 母港フレームから出る（ポートの座標系を壊さないため、艦の位置に新しい原点を置く）
    this._rebaseToDominantBody(false);
    ship.velocity = { x: 0, y: 0, z: 0 };
    this.warp.status = autopilot ? '自動航行' : 'ワープ';
    return true;
  },

  disengageWarp(reason) {
    const ship = State.ship;
    this.arrivalHold = null;
    this.warp.active = false;
    this.warp.autopilot = false;
    this.warp.speed = 0;
    if (ship) {
      ship.velocity = { x: 0, y: 0, z: 0 };
      ship.angularVelocity = { x: 0, y: 0, z: 0 };
    }
    // 到着した天体（または最寄りの天体）に対して静止するフレームへ
    if (!this.goHomeFrameIfNear()) this._rebaseToDominantBody(false);
    this.warp.status = reason || '';
  },

  // ワープ中の1フレーム。回転は通常の物理（RCS）、並進はワープで動かす。
  stepWarp(ship, input, dt) {
    const shipU = this.shipUniverse();
    this._shipU = shipU;
    const w = this.warp;

    // 回転入力（自動航行時は目的地へ機首を向ける）
    const rotInput = { ...input, thrustForward: 0, thrustStrafeX: 0, thrustStrafeY: 0, boost: false };
    let arrival = null;
    let alignCos = 1;
    if (w.autopilot && this.target) {
      arrival = this.targetArrival();
      if (arrival) {
        // v85: まっすぐ進むと天体にぶつかるときは、天体の横を回る経由点へ向かう
        const steer = this._steerToward(ship, this._detourPoint(shipU, arrival.point));
        rotInput.rotatePitch = steer.pitch;
        rotInput.rotateYaw = steer.yaw;
        alignCos = steer.alignCos;
      }
    }
    ship.velocity = { x: 0, y: 0, z: 0 };
    FlightPhysics.step(ship, rotInput, dt);
    ship.velocity = { x: 0, y: 0, z: 0 };
    ShipController._integratePose(ship, dt);
    // v85: ワープ中も主エンジンの噴射を見せる（見た目だけ。強さはワープの速さの桁で決める）
    if (w.speed > 50) {
      const level = clamp(Math.log10(w.speed / this.WARP_MIN_SPEED) / Math.log10(this.WARP_MAX_SPEED / this.WARP_MIN_SPEED) * 0.7 + 0.3, 0.3, 1);
      const fx = { ...ship.thrusterOutputRatios };
      for (const t of ship.thrusters) if (t.kind === 'main') fx[t.id] = Math.max(fx[t.id] || 0, level);
      ship.fxOutputRatios = fx;
    }

    // 速度の上限（天体表面までの距離に比例）。天体から遠ざかる向きに進んで
    // いるときは衝突の心配が無いので、上限を緩めて重力圏を早く抜けられるようにする。
    const near = SolarSystem.nearestBody(shipU, (b) => b.gm > 1e-3);
    const surf = near ? Math.max(near.surfaceDist, 10) : 1e12;
    let outward = 0;
    if (near) {
      const fwd0 = Astro.mat3MulVec(this.frame.rot, rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion));
      const rx = shipU.x - near.body.pos.x, ry = shipU.y - near.body.pos.y, rz = shipU.z - near.body.pos.z;
      const rl = Math.hypot(rx, ry, rz) || 1;
      outward = Math.max(0, (fwd0.x * rx + fwd0.y * ry + fwd0.z * rz) / rl);
    }
    let vLimit = Math.min(this.WARP_MAX_SPEED, surf * this.WARP_K_SURFACE * (1 + 8 * outward * outward));

    // 目標速度
    let vTarget;
    if (w.autopilot && arrival) {
      const dx = arrival.point.x - shipU.x, dy = arrival.point.y - shipU.y, dz = arrival.point.z - shipU.z;
      const distA = Math.hypot(dx, dy, dz);
      w.targetDistance = distA;
      vTarget = Math.min(vLimit, distA * this.WARP_K_TARGET);
      // 機首が目的地を向くまでは加速しない
      const alignFactor = Math.max(0, (alignCos - 0.9) / 0.1);
      // v83: 到着点の手前では、ゆっくり（最後は数十 m/s まで）減速してから到着する。
      // 以前は到着点の数百〜数千km手前で、秒速数千kmから一瞬で止まっていた。
      const floor = Math.min(this.WARP_MIN_SPEED * 0.2, Math.max(this.ARRIVAL_SPEED, distA * this.WARP_K_TARGET));
      vTarget = Math.max(floor, vTarget * alignFactor * alignFactor);
      // 到着
      // v85: ラグランジュ点は動いている（月の L 点で秒速約1km）ので、ゆっくり追いかけても
      // 追いつかない。数km まで近づいたら、その点に合わせて到着する
      if (distA < Math.max(arrival.lagrange ? 5000 : this.ARRIVAL_DISTANCE, w.speed * dt * 1.5)) {
        this._arrive(arrival);
        return;
      }
    } else {
      const th = this._warpThrottle(input, dt);
      w.throttle = th;
      const vMaxThrottle = this.WARP_MIN_SPEED * Math.pow(this.WARP_MAX_SPEED / this.WARP_MIN_SPEED, th);
      vTarget = th <= 0.001 ? 0 : Math.min(vLimit, vMaxThrottle);
    }

    // 対数スケールで滑らかに加減速
    const cur = Math.max(w.speed, 1);
    const tgt = Math.max(vTarget, 1);
    const logDiff = Math.log10(tgt) - Math.log10(cur);
    const maxUp = this.WARP_ACCEL_DECADES * dt;
    const maxDown = this.WARP_DECEL_DECADES * dt;
    const step = Math.max(-maxDown, Math.min(maxUp, logDiff));
    w.speed = vTarget <= 0 && cur < 50 ? 0 : Math.pow(10, Math.log10(cur) + step);
    // 表面への接近は常に上限で抑える（減速が間に合わない分）
    w.speed = Math.min(w.speed, vLimit * 1.05);

    // v85: 動いている到着点（軌道を回る母港・ラグランジュ点）へは、その動きにも乗って進む
    // （ワープの速さは「到着点に対して」の速さになり、近づくとちゃんと止まれる）
    if (arrival && arrival.velocity) {
      const fv = this._framePointVelocity(this.frame, ship.position);
      this.frame.offset.x += (arrival.velocity.x - fv.x) * dt;
      this.frame.offset.y += (arrival.velocity.y - fv.y) * dt;
      this.frame.offset.z += (arrival.velocity.z - fv.z) * dt;
    }

    // 機首方向（ローカル -Z）へ移動。ワープ中のフレームは軸=宇宙座標なので、
    // ローカルの移動量 = 宇宙座標の移動量。原点を艦に合わせて動かし続ける。
    const fwd = rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion);
    const fwdU = Astro.mat3MulVec(this.frame.rot, fwd);
    const ds = w.speed * dt;
    this.frame.offset.x += fwdU.x * ds;
    this.frame.offset.y += fwdU.y * ds;
    this.frame.offset.z += fwdU.z * ds;

    // 天体の影響圏をまたいだら、基準天体を付け替える（艦の位置は変えない）
    const newU = this.shipUniverse();
    this._shipU = newU;
    const dom = SolarSystem.dominantBody(newU);
    if (dom.id !== this.frame.bodyId) {
      // フレームの軸は変えず基準天体だけ替える: 原点 = 艦の宇宙座標 − rot×艦のローカル座標
      const r = Astro.mat3MulVec(this.frame.rot, ship.position);
      const offset = { x: newU.x - dom.pos.x - r.x, y: newU.y - dom.pos.y - r.y, z: newU.z - dom.pos.z - r.z };
      this.frame = this._makeFrame(dom.id, offset, this.frame.rot, false);
    }
    this._guardSurface(true);
  },

  // v85: 艦（p）から目的地（q）へまっすぐ進むと天体の安全な高さより内側を通るなら、
  // その天体の横（艦がいる側）を回る経由点を返す。通らなければ q のまま
  _detourPoint(p, q) {
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
    const L2 = dx * dx + dy * dy + dz * dz;
    if (!(L2 > 0)) return q;
    let best = null;
    for (const b of SolarSystem.bodies) {
      if (!(b.gm > this.GRAVITY_MIN_GM)) continue;
      const R = Math.max(b.rM, b.rpM, b.rbM) + this.minAltitude(b) * 2;
      const t = ((b.pos.x - p.x) * dx + (b.pos.y - p.y) * dy + (b.pos.z - p.z) * dz) / L2;
      if (t <= 0 || t >= 1) continue;
      const cx = p.x + dx * t - b.pos.x, cy = p.y + dy * t - b.pos.y, cz = p.z + dz * t - b.pos.z;
      const miss = Math.hypot(cx, cy, cz);
      if (miss >= R) continue;
      if (!best || t < best.t) best = { b, t, cx, cy, cz, miss, R };
    }
    if (!best) return q;
    let { cx, cy, cz, miss } = best;
    if (miss < 1) {
      // ちょうど中心を通る: 進む向きに垂直な適当な向きへよける
      const l = Math.sqrt(L2);
      const ux = dx / l, uy = dy / l, uz = dz / l;
      const ax = Math.abs(uy) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      cx = uy * ax.z - uz * ax.y; cy = uz * ax.x - ux * ax.z; cz = ux * ax.y - uy * ax.x;
      miss = Math.hypot(cx, cy, cz);
    }
    const k = (best.R * 1.4) / miss;
    return { x: best.b.pos.x + cx * k, y: best.b.pos.y + cy * k, z: best.b.pos.z + cz * k };
  },

  // v83: 到着したら、姿勢をいきなり切り替えるのをやめ、到着後に姿勢スラスターで
  // ゆっくり向き直る（stepArrivalHold）。母港でドッキングポートが選ばれていれば、
  // そのまま自動操船（ドッキング）に引き継ぎ、いつもどおり軸に乗せて入港する。
  // （ワープの速度は到着点の手前で数十 m/s まで落としてあるので、ここで止めても
  // 急停止には見えない。角速度はそのまま残して、自然に回し続ける）
  _arrive(arrival) {
    const ship = State.ship;
    this.warp.active = false;
    this.warp.autopilot = false;
    this.warp.speed = 0;
    ship.velocity = { x: 0, y: 0, z: 0 };
    if (this.target && this.target.kind === 'home') {
      this.switchFrame(this._cloneFrame(this.homeFrame));
      if (State.dockingTarget) {
        this.arrivalHold = null;
        ship.autoDockingEnabled = true;
        if (typeof HUD !== 'undefined' && HUD._refreshDockingUi) HUD._refreshDockingUi();
        this.warp.status = '母港に到着しました。ドッキングポートへ自動で入港します';
      } else {
        // ポートが選ばれていなければ、ポートの方（原点）へゆっくり向き直る
        this.arrivalHold = { kind: 'home', label: '母港に到着しました' };
        this.warp.status = '母港に到着しました（姿勢を整えています）';
      }
    } else if (arrival.lagrange) {
      // v85: ラグランジュ点に止まる（その点と一緒に動くフレームに乗る）
      const L = arrival.lagrange;
      const f = this._makeFrame(L.secondary, { x: 0, y: 0, z: 0 }, [1, 0, 0, 0, 1, 0, 0, 0, 1], false);
      f.lagrange = L;
      this.switchFrame(f);
      ship.position = { x: 0, y: 0, z: 0 }; // その点ちょうどに合わせる（数km 以内の移動）
      ship.velocity = { x: 0, y: 0, z: 0 };
      const P = SolarSystem.byId[L.primary], S = SolarSystem.byId[L.secondary];
      const label = `${P.ja}と${S.ja}の L${L.n} に到着しました`;
      this.arrivalHold = { kind: 'body', bodyId: S.id, label };
      this.warp.status = `${label}（その点に止まっています）`;
    } else {
      const b = arrival.body;
      if (b) this._rebaseToBody(b); else this._rebaseToDominantBody(false);
      let orbitNote = '';
      if (b && this.gravityOn()) {
        // v85: 円軌道に乗せる。天体の赤道面に沿った順行の向きに、円軌道の速さで
        const u = this.shipUniverse();
        const rv = { x: u.x - b.pos.x, y: u.y - b.pos.y, z: u.z - b.pos.z };
        const r = Math.hypot(rv.x, rv.y, rv.z);
        const rh = { x: rv.x / r, y: rv.y / r, z: rv.z / r };
        const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, b.quat); // 自転軸（北）
        let t = { x: up.y * rh.z - up.z * rh.y, y: up.z * rh.x - up.x * rh.z, z: up.x * rh.y - up.y * rh.x };
        let tl = Math.hypot(t.x, t.y, t.z);
        if (tl < 1e-3) { t = { x: -rh.z, y: 0, z: rh.x }; tl = Math.hypot(t.x, t.z) || 1; }
        const vc = Math.sqrt((b.gm * 1e9) / r);
        const vu = { x: (t.x / tl) * vc, y: (t.y / tl) * vc, z: (t.z / tl) * vc };
        ship.velocity = Astro.mat3MulVec(this.frame.rotT, vu);
        orbitNote = `高度 ${Math.round((r - b.rM) / 1000).toLocaleString()} km の円軌道に乗りました（秒速 ${(vc / 1000).toFixed(2)} km）`;
      }
      const label = `${this.targetLabel()}に到着しました`;
      this.arrivalHold = b ? { kind: 'body', bodyId: b.id, label } : null;
      this.warp.status = b ? `${label}${orbitNote ? '。' + orbitNote : '（姿勢を整えています）'}` : label;
    }
  },

  // 到着後の姿勢合わせで向けたい姿勢（ローカル座標のクォータニオン）。対象が無ければ null
  _arrivalHoldAttitude(ship) {
    const h = this.arrivalHold;
    if (!h) return null;
    if (h.kind === 'home') {
      return this._lookQuat(ship, { x: 0, y: 0, z: 0 }, null);
    }
    const b = SolarSystem.byId[h.bodyId];
    if (!b) return null;
    const l = this.universeToLocal(b.pos);
    // 天体の北極が画面の上になるようにする（環や赤道の縞が水平に見える）
    const pole = b.poleThree || { x: 0, y: 1, z: 0 };
    const q = this._lookQuat(ship, l, Astro.mat3MulVec(this.frame.rotT, pole));
    if (!q) return null;
    // 追従カメラは艦の後ろ上方から見下ろすので、機首を少し上げて
    // 天体が画面の中央付近に見えるようにする
    const pitchUp = axisAngleQuat({ x: 1, y: 0, z: 0 }, (11 * Math.PI) / 180);
    return normalizeQuat(multiplyQuat(q, pitchUp));
  },

  // 到着後の姿勢合わせ（ShipController.update から毎フレーム呼ぶ）。
  // 操縦者が回転・移動の操作をしたら、そこで手を離す。
  // 戻り値: 物理に渡す入力（姿勢合わせ中は回転入力を書き換えたコピー）
  stepArrivalHold(ship, input) {
    const h = this.arrivalHold;
    if (!h || this.warp.active) return input;
    const userInput = Math.abs(input.rotatePitch) + Math.abs(input.rotateYaw) + Math.abs(input.rotateRoll)
      + Math.abs(input.thrustStrafeX) + Math.abs(input.thrustStrafeY) + Math.abs(input.thrustForward);
    if (userInput > 0.05 || ship.autoDockingEnabled) {
      this.arrivalHold = null;
      return input;
    }
    const qd = this._arrivalHoldAttitude(ship);
    if (!qd) { this.arrivalHold = null; return input; }
    // 今の姿勢から目標の姿勢への回転（艦のローカル軸での回転ベクトル）
    let qe = multiplyQuat(conjugateQuat(ship.quaternion), qd);
    if (qe.w < 0) qe = { x: -qe.x, y: -qe.y, z: -qe.z, w: -qe.w };
    const s = Math.hypot(qe.x, qe.y, qe.z);
    const angle = 2 * Math.atan2(s, qe.w);
    const w = ship.angularVelocity;
    const wMag = Math.hypot(w.x, w.y, w.z);
    // 0.6°以内に入ったら終わり（残った角速度は自動の姿勢制動で止まる）
    if (angle < 0.01) {
      this.arrivalHold = null;
      this.warp.status = h.label;
      return input;
    }
    // 目標の角速度: 誤差に比例し、止まり切れる速さ（√(2·角加速度·角度)）と
    // ゆっくり回す上限で抑える。回転入力は「最大角速度に対する割合」で渡す。
    const alpha = ThrusterSolver._estimateMaxAngularAccel(ship);
    const aMin = Math.max(1e-6, Math.min(alpha.x, alpha.y, alpha.z));
    const maxW = Math.max(1e-6, ship.maxAngularSpeed);
    let rate = Math.min(this.ARRIVAL_TURN_RATE, maxW * 0.8, angle * 0.6, Math.sqrt(2 * aMin * angle * 0.5));
    // 回転入力が小さすぎると「操作なし」（03-thruster-solver.js の ROTATION_INPUT_DEADZONE）と
    // みなされて回らなくなるので、最後まで少しは回す
    rate = Math.max(rate, maxW * 0.03);
    const k = s > 1e-9 ? rate / s : 0;
    return {
      ...input,
      rotatePitch: clamp((qe.x * k) / maxW, -1, 1),
      rotateYaw: clamp((qe.y * k) / maxW, -1, 1),
      rotateRoll: clamp((qe.z * k) / maxW, -1, 1),
    };
  },

  // 艦の機首（-Z）をローカル座標の点 p に向ける姿勢。upLocal を渡すとその向きが
  // 画面の上になるようロールをそろえる（省略時は今の上方向を保つ）
  _lookQuat(ship, p, upLocal) {
    const dx = p.x - ship.position.x, dy = p.y - ship.position.y, dz = p.z - ship.position.z;
    if (Math.hypot(dx, dy, dz) < 1e-6) return null;
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const up = upLocal || rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), dir, new THREE.Vector3(up.x, up.y, up.z));
    // lookAt は -Z を dir に向ける（カメラ用）ので、そのまま艦の向きとして使える
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  },

  // 自動航行の操舵: 目標点の方向へ機首を向けるピッチ・ヨー入力（-1..1）
  _steerToward(ship, pointU) {
    const l = this.universeToLocal(pointU);
    const dirLocal = { x: l.x - ship.position.x, y: l.y - ship.position.y, z: l.z - ship.position.z };
    const inv = conjugateQuat(ship.quaternion);
    const d = vecNormalize(rotateVecByQuat(dirLocal, inv)); // 艦固定座標での目標方向
    const alignCos = -d.z;
    // ピッチ: 上(+Y)にあれば機首上げ、ヨー: 左(-X)にあれば左旋回
    const angle = Math.acos(Math.max(-1, Math.min(1, alignCos)));
    const lateral = Math.hypot(d.x, d.y) || 1e-9;
    const gain = Math.min(1, angle / 0.35);
    // 現在の角速度で行き過ぎないよう、角速度に比例した制動を加える
    const w = ship.angularVelocity;
    const kd = 0.8;
    const pitch = Math.max(-1, Math.min(1, (d.y / lateral) * gain - w.x * kd));
    const yaw = Math.max(-1, Math.min(1, (-d.x / lateral) * gain - w.y * kd));
    return { pitch: angle < 0.002 ? -w.x * kd : pitch, yaw: angle < 0.002 ? -w.y * kd : yaw, alignCos };
  },

  // ワープのスロットル（タッチのレバーは保持値をそのまま、キーボードは押している間だけ増減）
  _warpThrottle(input, dt) {
    const keys = (typeof InputSystem !== 'undefined' && InputSystem._keys) || new Set();
    const lever = InputSystem && InputSystem._throttleLever ? InputSystem._throttleLever : null;
    if (keys.has('KeyW')) return Math.min(1, this.warp.throttle + dt * 0.35);
    if (keys.has('KeyS')) return Math.max(0, this.warp.throttle - dt * 0.6);
    if (lever && (lever.active || this._leverTouched)) {
      this._leverTouched = true;
      return Math.max(0, lever.ratio);
    }
    return this.warp.throttle;
  },

  // -----------------------------------------------------------
  // 地表への衝突防止
  // -----------------------------------------------------------
  minAltitude(b) {
    if (b.type === 'star') return b.rM * 2.0;
    if (b.atmo) return b.atmo.heightKm * 1000 + 20e3;
    return Math.max(300, Math.max(b.rM, b.rpM, b.rbM) * 0.03);
  },

  _guardSurface(warping) {
    const ship = State.ship;
    if (!ship) return;
    const u = this.shipUniverse();
    for (const b of SolarSystem.bodies) {
      const R = Math.max(b.rM, b.rpM, b.rbM);
      const dx = u.x - b.pos.x, dy = u.y - b.pos.y, dz = u.z - b.pos.z;
      const d = Math.hypot(dx, dy, dz);
      const limit = R + this.minAltitude(b);
      if (!Number.isFinite(d) || d >= limit || d === 0) continue;
      // 境界まで押し戻す
      const push = (limit - d);
      const nx = dx / d, ny = dy / d, nz = dz / d;
      const nL = Astro.mat3MulVec(this.frame.rotT, { x: nx, y: ny, z: nz });
      if (warping) {
        this.frame.offset.x += nx * push;
        this.frame.offset.y += ny * push;
        this.frame.offset.z += nz * push;
        this.warp.speed = Math.min(this.warp.speed, 1000);
      } else {
        ship.position.x += nL.x * push;
        ship.position.y += nL.y * push;
        ship.position.z += nL.z * push;
        // 天体へ向かう速度成分を打ち消す
        const vIn = ship.velocity.x * nL.x + ship.velocity.y * nL.y + ship.velocity.z * nL.z;
        if (vIn < 0) {
          ship.velocity.x -= nL.x * vIn;
          ship.velocity.y -= nL.y * vIn;
          ship.velocity.z -= nL.z * vIn;
        }
      }
      this.lastCollisionWarning = performance.now();
      this.collisionBody = b;
    }
  },

  // -----------------------------------------------------------
  // 毎フレーム（艦の物理更新の後）
  // -----------------------------------------------------------
  postUpdate() {
    const ship = State.ship;
    if (!ship) return;
    if (!this.warp.active) this._guardSurface(false);
    this._shipU = this.shipUniverse();
    // 母港以外のフレームでは、原点から離れすぎたら原点を艦に寄せ直す
    // （噴射粒子など float32 で保持される座標の精度を保つため）
    if (!this.frame.isHome && !this.warp.active) {
      const d = Math.hypot(ship.position.x, ship.position.y, ship.position.z);
      if (d > 20e3) {
        if (this.frame.lagrange) {
          // ラグランジュ点のフレームは、同じ点を基準にしたまま原点だけ艦へずらす
          const f = this._cloneFrame(this.frame);
          const r = Astro.mat3MulVec(f.rot, ship.position);
          f.offset = { x: f.offset.x + r.x, y: f.offset.y + r.y, z: f.offset.z + r.z };
          this.switchFrame(f, true);
        } else {
          // v85: 重力で動いている艦の速度を保ったまま付け替える（影響圏をまたぐときも）
          this._rebaseToDominantBody(false, true);
        }
      }
    }
  },

  // HUD 表示用: いまどこにいるか。
  //   影響圏の主天体（惑星など）を基準にし、衛星の表面のすぐ近く（半径の10倍以内）
  //   にいるときだけ衛星を基準にする。
  locationInfo() {
    const u = this._shipU || this.shipUniverse();
    if (!Number.isFinite(u.x)) return null;
    const dominant = SolarSystem.dominantBody(u);
    const near = SolarSystem.nearestBody(u);
    if (!near) return null;
    let body = dominant;
    if (near.body !== dominant && near.surfaceDist < Math.max(near.body.rM, 1) * 10) body = near.body;
    if (dominant.id === 'sun' && near.body.id !== 'sun') body = near.body;
    const altitude = SolarSystem.distance(u, body) - body.rM;
    return { body, altitude, dominant, nearest: near.body, nearestDist: near.surfaceDist };
  },
};
