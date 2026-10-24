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
    return { ...f, offset: { ...f.offset }, rot: f.rot.slice(), rotT: f.rotT.slice(), quat: f.quat.clone() };
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
    const offset = scale(u, earth.rM + this.HOME_ALTITUDE_KM * 1000);
    return this._makeFrame('earth', offset, rot, true);
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
    return {
      anchorId: f.bodyId,
      offset: { x: f.offset.x + r.x, y: f.offset.y + r.y, z: f.offset.z + r.z },
      quat: f.quat.clone().multiply(camera.quaternion),
      fov: camera.fov,
      aspect: camera.aspect,
    };
  },

  // -----------------------------------------------------------
  // フレームの切り替え（艦の宇宙座標・向きは変えずに、基準だけ付け替える）
  // -----------------------------------------------------------
  switchFrame(newFrame) {
    const ship = State.ship;
    const old = this.frame;
    if (ship) {
      const u = this.localToUniverse(ship.position, old);
      const qU = old.quat.clone().multiply(new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w));
      const p = this.universeToLocal(u, newFrame);
      const qL = newFrame.quat.clone().invert().multiply(qU).normalize();
      // 速度・角速度はローカル（艦固定/フレーム）基準なので、向きの変化分だけ回す
      const v = Astro.mat3MulVec(newFrame.rotT, Astro.mat3MulVec(old.rot, ship.velocity));
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
  _rebaseToDominantBody(keepRotation) {
    const u = this.shipUniverse();
    const body = SolarSystem.dominantBody(u);
    const rot = keepRotation ? this.frame.rot : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const offset = { x: u.x - body.pos.x, y: u.y - body.pos.y, z: u.z - body.pos.z };
    this.switchFrame(this._makeFrame(body.id, offset, rot, false));
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
      const p = this.localToUniverse({ x: 0, y: 150, z: 2500 }, this.homeFrame);
      const c = this.frameOrigin(this.homeFrame);
      return { point: p, center: c, arrivalDist: 0, body: SolarSystem.byId.earth };
    }
    const b = SolarSystem.byId[tg.id];
    if (!b) return null;
    const shipU = this._shipU;
    const sun = SolarSystem.byId.sun;
    const arrivalDist = this.arrivalDistance(b);
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
    // 母港フレームから出る（ポートの座標系を壊さないため、艦の位置に新しい原点を置く）
    this._rebaseToDominantBody(false);
    ship.velocity = { x: 0, y: 0, z: 0 };
    this.warp.status = autopilot ? '自動航行' : 'ワープ';
    return true;
  },

  disengageWarp(reason) {
    const ship = State.ship;
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
        const steer = this._steerToward(ship, arrival.point);
        rotInput.rotatePitch = steer.pitch;
        rotInput.rotateYaw = steer.yaw;
        alignCos = steer.alignCos;
      }
    }
    ship.velocity = { x: 0, y: 0, z: 0 };
    FlightPhysics.step(ship, rotInput, dt);
    ship.velocity = { x: 0, y: 0, z: 0 };
    ShipController._integratePose(ship, dt);

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
      vTarget = Math.max(this.WARP_MIN_SPEED * 0.2, vTarget * alignFactor * alignFactor);
      // 到着
      if (distA < Math.max(500, arrival.arrivalDist * 0.06) || (distA < w.speed * dt * 1.5 && alignCos > 0.95)) {
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

  _arrive(arrival) {
    const ship = State.ship;
    this.warp.active = false;
    this.warp.autopilot = false;
    this.warp.speed = 0;
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.angularVelocity = { x: 0, y: 0, z: 0 };
    if (this.target && this.target.kind === 'home') {
      this.switchFrame(this._cloneFrame(this.homeFrame));
      // 母港ではポートの方（原点）を向く
      this._faceLocalPoint(ship, { x: 0, y: 0, z: 0 });
      this.warp.status = '母港に到着しました';
    } else {
      this._rebaseToDominantBody(false);
      const b = arrival.body;
      if (b) {
        const l = this.universeToLocal(b.pos);
        // 天体の北極が画面の上になるようにする（環や赤道の縞が水平に見える）
        const pole = b.poleThree || { x: 0, y: 1, z: 0 };
        this._faceLocalPoint(ship, l, Astro.mat3MulVec(this.frame.rotT, pole));
        // 追従カメラは艦の後ろ上方から見下ろすので、機首を少し上げて
        // 天体が画面の中央付近に見えるようにする
        const pitchUp = axisAngleQuat({ x: 1, y: 0, z: 0 }, (11 * Math.PI) / 180);
        ship.quaternion = normalizeQuat(multiplyQuat(ship.quaternion, pitchUp));
      }
      this.warp.status = `${this.targetLabel()}に到着しました`;
    }
  },

  // 艦の機首（-Z）を、ローカル座標の点 p の方向へ向ける。
  // upLocal を渡すとその向きが画面の上になるようロールをそろえる（省略時は今の上方向を保つ）
  _faceLocalPoint(ship, p, upLocal) {
    const dx = p.x - ship.position.x, dy = p.y - ship.position.y, dz = p.z - ship.position.z;
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const up = upLocal || rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), dir, new THREE.Vector3(up.x, up.y, up.z));
    // lookAt は -Z を dir に向ける（カメラ用）ので、そのまま艦の向きとして使える
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    ship.quaternion = { x: q.x, y: q.y, z: q.z, w: q.w };
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
      if (d > 20e3) this._rebaseToDominantBody(false);
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
