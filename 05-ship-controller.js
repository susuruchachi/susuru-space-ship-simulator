// =============================================================
// 05-ship-controller.js
// Three.js側との橋渡し
//   - State.ship の数値状態 <-> THREE.Object3D (mesh) の同期
//   - FlightPhysics.step() の呼び出しをここで一本化
// =============================================================

const ShipController = {
  // classKey: 'rocket' | 'cruiser' | 'battleship'
  // mesh: THREE.Object3D（船体ルート、シーンに追加済みのもの）
  spawnPlayerShip(classKey, mesh, spawnPosition = { x: 0, y: 0, z: 0 }) {
    const ship = createShipState(classKey);
    ship.position.x = spawnPosition.x;
    ship.position.y = spawnPosition.y;
    ship.position.z = spawnPosition.z;
    ship.mesh = mesh; // Three.jsオブジェクトへの参照（物理状態には含めず付随データとして保持）

    mesh.position.set(spawnPosition.x, spawnPosition.y, spawnPosition.z);
    mesh.quaternion.set(0, 0, 0, 1);

    State.ship = ship;
    return ship;
  },

  // v77: 物理1ステップの最大時間[s]。宇宙の描画が加わって端末によっては
  // フレームレートが下がるため、1フレームの時間が長いときは分割して進める。
  // 自動ドッキングの停止判定（速度0.05未満）は刻みが粗い（20fps以下）と
  // 噴射1回ぶんの速度変化が閾値を超えて止まり切れず、brake300から先へ
  // 進めなくなるため（60fps・50fpsの端末では従来どおり1フレーム1ステップ）。
  MAX_PHYSICS_STEP: 1 / 50,

  // 毎フレーム呼び出し
  update(dt) {
    const ship = State.ship;
    if (!ship || State.paused) return;

    InputSystem.update();
    // v83: ワープで到着した直後は、姿勢スラスターでゆっくり天体（母港）のほうへ向き直る
    const input = typeof Navigation !== 'undefined' && Navigation.stepArrivalHold
      ? Navigation.stepArrivalHold(ship, State.input)
      : State.input;
    // v77: ワープ中は並進をワープ航法（16-navigation.js）が受け持ち、
    // 回転だけ通常の物理（RCSによる姿勢制御）で動かす。
    if (typeof Navigation !== 'undefined' && Navigation.isWarping()) {
      Navigation.stepWarp(ship, State.input, dt);
    } else {
      const steps = Math.max(1, Math.ceil(dt / this.MAX_PHYSICS_STEP - 1e-9));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        // v85: 重力場機関の艦は、操作していない軸を境界面の姿勢へ戻す（GravityDrive）
        const stepInput = ship.gravityDrive ? GravityDrive.adjustInput(ship, input) : input;
        FlightPhysics.step(ship, stepInput, h);
        // v85: 天体の重力（16-navigation.js gravityAccel）。ドッキングして固定中は加えない
        if (typeof Navigation !== 'undefined' && Navigation.gravityAccel && !(ship.autoDockingEnabled && ship._dockingPhase === 'docked')) {
          const g = Navigation.gravityAccel(ship);
          if (g) {
            ship.velocity.x += g.x * h;
            ship.velocity.y += g.y * h;
            ship.velocity.z += g.z * h;
            ship.gravityAccel = g;
          }
        }
        if (ship.gravityDrive) GravityDrive.step(ship, input, h);
        const prev = { x: ship.position.x, y: ship.position.y, z: ship.position.z };
        this._integratePose(ship, h);
        // v79: ドッキングポートとの当たり判定（めり込んだら押し戻す）
        if (typeof Collision !== 'undefined') Collision.resolve(ship, prev);
      }
    }
    this._syncMesh(ship);
  },

  // -----------------------------------------------------------
  // v85: 星図で時間を早送りしている間の艦の動き（simDt = 実時間 × 倍率 [s]）
  //   星図を開いている間は操縦しないので、推進・姿勢の制御はせず、重力だけで動かす
  //   （周回軌道ならそのまま軌道を回る）。ワープ・自動航行中は、ワープを早く進める。
  //   1フレームで進む時間が長いので、軌道の周期に合わせた細かな刻みで計算する。
  // -----------------------------------------------------------
  FAST_MAX_SUBSTEPS: 4000,
  WARP_MAX_SUBSTEPS: 400,

  updateTimeScaled(simDt) {
    const ship = State.ship;
    if (!ship || State.paused || !(simDt > 0)) return; // 一時停止（倍率0）なら艦も止める
    if (ship.autoDockingEnabled && ship._dockingPhase === 'docked') return;
    const nav = typeof Navigation !== 'undefined' ? Navigation : null;
    if (nav && nav.isWarping()) {
      const n = Math.min(this.WARP_MAX_SUBSTEPS, Math.ceil(simDt / 0.05));
      const h = simDt / n;
      for (let i = 0; i < n && nav.isWarping(); i++) nav.stepWarp(ship, State.input, h);
      this._syncMesh(ship);
      return;
    }
    // 母港の近く（母港のフレーム）では、ポートと一緒に軌道を回ったまま止めておく
    // （ポートに対するずれはごくわずかで、回るフレームでは大きな刻みの計算が不安定になるため）
    let remaining = nav && nav.frame && nav.frame.isHome ? 0 : simDt;
    let steps = 0;
    while (remaining > 1e-9 && steps < this.FAST_MAX_SUBSTEPS) {
      // 刻み: いちばん強い重力の天体を回る軌道の周期の約1/1000（遠いほど長く）
      let h = remaining;
      const g = nav ? nav.gravityAccel(ship) : null;
      if (g) {
        const a = Math.hypot(g.x, g.y, g.z);
        const v = Math.max(1, vecLength(ship.velocity));
        if (a > 1e-12) h = Math.min(h, Math.max(0.02, 0.006 * (v / a)));
      }
      const left = this.FAST_MAX_SUBSTEPS - steps;
      if (left <= 1) h = remaining;
      else h = Math.max(h, remaining / left);
      if (g) { ship.velocity.x += g.x * h; ship.velocity.y += g.y * h; ship.velocity.z += g.z * h; }
      ship.position.x += ship.velocity.x * h;
      ship.position.y += ship.velocity.y * h;
      ship.position.z += ship.velocity.z * h;
      remaining -= h;
      steps++;
    }
    // 姿勢: 周回姿勢を合わせているならその向きに、そうでなければ今の回転を続ける
    if (nav && nav.arrivalHold && nav.arrivalHold.kind === 'orbit') {
      const q = nav._orbitAttitude(ship, nav.arrivalHold.bodyId);
      if (q) ship.quaternion = q;
    } else {
      const w = ship.angularVelocity;
      const ang = Math.hypot(w.x, w.y, w.z) * simDt;
      if (ang > 0) {
        const k = Math.min(1, Math.PI / ang); // 1フレームで半回転より多くは回さない（見た目のため）
        this._integratePose(ship, simDt * k);
      }
    }
    ship.thrusterOutputRatios = {};
    ship.fxOutputRatios = null;
    this._syncMesh(ship);
  },

  // 速度・角速度から位置・姿勢を積分
  _integratePose(ship, dt) {
    ship.position.x += ship.velocity.x * dt;
    ship.position.y += ship.velocity.y * dt;
    ship.position.z += ship.velocity.z * dt;

    // 角速度（ローカル軸: pitch=x, yaw=y, roll=z）を
    // 微小回転クォータニオンとして合成
    const wx = ship.angularVelocity.x * dt;
    const wy = ship.angularVelocity.y * dt;
    const wz = ship.angularVelocity.z * dt;

    const deltaQ = eulerToQuatSmall(wx, wy, wz);
    ship.quaternion = multiplyQuat(ship.quaternion, deltaQ);
    ship.quaternion = normalizeQuat(ship.quaternion);
  },

  // 数値状態 -> Three.jsメッシュへ反映
  _syncMesh(ship) {
    if (!ship.mesh) return;
    ship.mesh.position.set(ship.position.x, ship.position.y, ship.position.z);
    ship.mesh.quaternion.set(
      ship.quaternion.x,
      ship.quaternion.y,
      ship.quaternion.z,
      ship.quaternion.w
    );
  },
};

// -----------------------------------------------------------
// クォータニオンユーティリティ（01-state-and-config.jsのvecユーティリティに続き、
// Three.js非依存で実装。THREE.Quaternionを直接使わない理由は
// 04-flight-physics.jsが完全に独立した物理コアであるため）
//
// v61: axisAngleQuat/multiplyQuat/normalizeQuatは01-state-and-config.js
// （両画面共通の基盤ファイル）へ移設したため、ここでの重複定義は削除。
// v62: eulerToQuatSmall/quatToEulerDegreesも同様の理由（port-builder.html
// でも必要になったため）で01-state-and-config.jsへ移設し、ここでの定義は削除。
// -----------------------------------------------------------

// =============================================================
// v85: 重力場機関（三段圧縮重力場機関・重力波共振機関）の艦の動き
//
// RMIS世界の設定: 艦は重力場の「密度境界面」に、水に浮かぶ船のように支えられている。
// 機関の中の機械が境界面の向きを変え、面を傾けることで、艦は面に沿って滑るように進む。
//   - 境界面の向き（boundaryQuat）が艦の「本来の姿勢」。ロールしたり、外から回されたりしても、
//     入力をやめると境界面からの復元力で本来の姿勢に戻る（姿勢スラスターとは別の、面が支える力）
//   - 転針（ピッチ・ヨーの操作）は、機械が境界面の向きを変えること。境界面は艦の新しい向きに
//     付いてくるが、面が向きを変えたぶん、それまでの速度は一気に落ちる
//   - 自動ドッキング中・ワープ中は、細かな姿勢合わせを妨げないよう、この動きはしない
// =============================================================
const GravityDrive = {
  RESTORE_RATE: 3.0,      // 本来の姿勢へ戻る速さ（ずれの角度 × この値 [rad/s]）（v85: 強めに）
  RESTORE_MAX: 1.0,       // 戻る角速度の上限（最大角速度に対する割合）
  RESTORE_GRIP: 6.0,      // 境界面が艦の回転を引き寄せる強さ [1/s]
  TURN_SPEED_LOSS: 2.5,   // 転針で速度が落ちる強さ（1 rad 向きを変えると速度は e^-2.5 ≈ 8% に）
  INPUT_DEADZONE: 0.05,
  // v85: 水上船のような横揺れ（ロールはばね。減衰を弱くして、起き上がりながら揺れる）
  ROLL_OMEGA: 3.2,        // 横揺れの固有角振動数 [rad/s]（v85: 復元力を強めに。周期 約2秒）
  ROLL_DAMPING: 0.45,     // 減衰比（1 で揺れずに戻る。小さいほど揺れが続く。0.45 で少し揺れてすぐ収まる）
  HEEL_GAIN: 0.004,       // 旋回中の傾き [rad] = この値 × 旋回の角速度 [rad/s] × 前進の速さ [m/s]
  HEEL_MAX: 0.45,         // 傾きの上限 [rad]（約26°）
  // v85: 浮力（境界面より沈む・浮くと、強い力で面の高さへ押し戻す）
  BUOY_OMEGA: 3.0,        // [rad/s]
  BUOY_DAMPING: 0.7,
  // v85: 船の向きと進む向きのずれ（横・上下の速度）を打ち消す時間 [s]（竜骨のように）
  KEEL_TIME: 1.5,

  _active(ship) {
    return ship.gravityDrive && !ship.autoDockingEnabled && !(typeof Navigation !== 'undefined' && Navigation.isWarping());
  },

  // 艦の姿勢 → 境界面の姿勢への回転（艦のローカル軸の回転ベクトル [rad]）
  _error(ship) {
    const qe = normalizeQuat(multiplyQuat(conjugateQuat(ship.quaternion), ship.boundaryQuat));
    const sgn = qe.w < 0 ? -1 : 1;
    const s = Math.sqrt(Math.max(0, 1 - qe.w * qe.w));
    const ang = 2 * Math.acos(Math.min(1, Math.abs(qe.w)));
    return s > 1e-9 ? { x: (qe.x * sgn / s) * ang, y: (qe.y * sgn / s) * ang, z: (qe.z * sgn / s) * ang } : { x: 0, y: 0, z: 0 };
  },

  // 操作していない軸の回転の目標を「本来の姿勢へ戻る角速度」にする（姿勢の自動制動が
  // 復元の回転を止めようとして逆らわないように）
  adjustInput(ship, input) {
    if (!this._active(ship)) {
      ship.boundaryQuat = null;
      ship.boundaryPoint = null;
      return input;
    }
    if (!ship.boundaryQuat) ship.boundaryQuat = { ...ship.quaternion };
    const dz = this.INPUT_DEADZONE;
    // v85: 周回中の姿勢合わせ（自動）は、境界面ごと向きを変える（転針扱いだが速度は落とさない）
    const hold = !!input.attitudeHold;
    const turning = hold || Math.abs(input.rotatePitch || 0) > dz || Math.abs(input.rotateYaw || 0) > dz;
    const rolling = hold || Math.abs(input.rotateRoll || 0) > dz;
    ship._gdHold = hold;
    const e = this._error(ship);
    const maxW = Math.max(1e-6, ship.maxAngularSpeed);
    const cmd = (v) => clamp((v * this.RESTORE_RATE) / maxW, -this.RESTORE_MAX, this.RESTORE_MAX);
    const out = { ...input };
    if (!turning) { out.rotatePitch = cmd(e.x); out.rotateYaw = cmd(e.y); }
    // ロールはばね（step）で戻すので、姿勢の制御は今の回転を止めようとしない（今の角速度を目標にする）
    if (!rolling) out.rotateRoll = clamp(ship.angularVelocity.z / maxW, -1, 1);
    ship._gdTurning = turning;
    ship._gdRolling = rolling;
    ship._gdTarget = { x: out.rotatePitch * maxW, y: out.rotateYaw * maxW, z: out.rotateRoll * maxW };
    return out;
  },

  step(ship, input, dt) {
    if (!this._active(ship) || !ship.boundaryQuat) return;
    const w = ship.angularVelocity;
    if (ship._gdTurning) {
      // 転針: 境界面の前方を艦の前方へ合わせる（面の「上」はできるだけ保つ）
      const fwd = rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion);
      const bUp = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.boundaryQuat);
      ship.boundaryQuat = this._quatFromForwardUp(fwd, bUp) || ship.boundaryQuat;
      // 面の向きを変えたぶん、それまでの速度が一気に落ちる（周回中の自動の姿勢合わせを除く）
      const turnRate = ship._gdHold ? 0 : Math.hypot(w.x, w.y);
      const k = Math.exp(-this.TURN_SPEED_LOSS * turnRate * dt);
      ship.velocity.x *= k; ship.velocity.y *= k; ship.velocity.z *= k;
    }
    // 境界面の復元力: 操作していない軸の回転を、本来の姿勢へ戻る角速度へ引き寄せる
    // （姿勢スラスターに頼らない、面が支える力）
    const t = ship._gdTarget;
    const g = 1 - Math.exp(-this.RESTORE_GRIP * dt);
    if (!ship._gdTurning) { w.x += (t.x - w.x) * g; w.y += (t.y - w.y) * g; }
    // 横揺れ: 境界面に対して起き上がろうとするばね。旋回中は外側へ傾く
    if (!ship._gdRolling) {
      const e = this._error(ship);
      const fwdSpeed = -rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion)).z;
      const heel = clamp(-this.HEEL_GAIN * w.y * fwdSpeed, -this.HEEL_MAX, this.HEEL_MAX);
      const Wn = this.ROLL_OMEGA;
      w.z += (Wn * Wn * (heel + e.z) - 2 * this.ROLL_DAMPING * Wn * w.z) * dt;
    }

    // 周回中の自動の姿勢合わせの間は、浮力・竜骨の働きで軌道の速度を変えない
    if (ship._gdHold) { ship.boundaryPoint = { ...ship.position }; return; }

    // 浮力: 境界面の高さからのずれ（面の法線の向き）を強く押し戻す
    const n = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.boundaryQuat);
    if (!ship.boundaryPoint || ship._gdTurning) ship.boundaryPoint = { ...ship.position };
    const bp = ship.boundaryPoint;
    const dn = (ship.position.x - bp.x) * n.x + (ship.position.y - bp.y) * n.y + (ship.position.z - bp.z) * n.z;
    const vn = vecDot(ship.velocity, n);
    const Wb = this.BUOY_OMEGA;
    const an = -Wb * Wb * dn - 2 * this.BUOY_DAMPING * Wb * vn;
    ship.velocity.x += n.x * an * dt; ship.velocity.y += n.y * an * dt; ship.velocity.z += n.z * an * dt;
    ship.boundaryDepth = dn;

    // 竜骨: 船の向き以外へ進む速度（横滑り・上下）を数秒で打ち消す
    const f = rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion);
    const vf = vecDot(ship.velocity, f);
    const kk = 1 - Math.exp(-dt / this.KEEL_TIME);
    ship.velocity.x -= (ship.velocity.x - f.x * vf) * kk;
    ship.velocity.y -= (ship.velocity.y - f.y * vf) * kk;
    ship.velocity.z -= (ship.velocity.z - f.z * vf) * kk;
  },
  _quatFromForwardUp(fwd, upHint) {
    const f = vecNormalize(fwd);
    let r = vecCross(f, upHint);
    if (vecLength(r) < 1e-6) return null;
    r = vecNormalize(r);
    const u = vecCross(r, f);
    // 列: X=右, Y=上, Z=後ろ（-前）
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(r.x, r.y, r.z), new THREE.Vector3(u.x, u.y, u.z), new THREE.Vector3(-f.x, -f.y, -f.z));
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  },
};
