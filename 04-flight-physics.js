// =============================================================
// 04-flight-physics.js
// 慣性飛行システム（コア物理）
//
// 前提: 抵抗ゼロの宇宙空間。噴射した分だけ加速し続け、
// 減速するには逆噴射が必要。船特有の減衰項は一切入れない。
//
// v02: スラスター定義（01-state-and-config.jsのship.thrusters）
// ベースに全面書き換え。旧バージョンのmainThrust/rcsThrust決め打ち
// 4軸RCSは廃止し、任意個数・任意配置のスラスターから
// 03-thruster-solver.jsが出力比を自動配分する構成になった。
//
// このファイルはThree.jsに依存しないプレーンな数値計算のみ。
// Vector3/Quaternionへの変換は05-ship-controller.js側で行う。
// =============================================================

const FlightPhysics = {
  // -----------------------------------------------------------
  // 1フレーム分の物理更新
  //   ship: 01-state-and-config.js の createShipState() で作った艦
  //   input: State.input と同形状のオブジェクト
  //   dt: デルタタイム(秒)
  // -----------------------------------------------------------
  step(ship, input, dt) {
    // v46: 自動操船の入港判定・固定はThrusterSolver側のステート
    // マシン（ship._dockingPhase、_meetsArrivalCriteria/
    // _lockShipAtTarget）に一本化した。'docked'フェーズになった
    // 時点で位置・姿勢・速度は既に目的地へ固定済みのため、ここでは
    // 通常のソルバー/積分処理そのものを丸ごとスキップするだけで
    // よい（以後の手動入力・自動制御力は無視される。自動操船を
    // OFFにすれば通常の物理へ復帰する）。
    if (ship.autoDockingEnabled && State.dockingTarget && ship._dockingPhase === 'docked') {
      return;
    }

    const { desiredForce, desiredTorque } = ThrusterSolver.buildDesiredFromInput(input, ship, dt);

    // 最高速到達中は「最高速方向への加速」だけを遮断する。
    // 以前はワールド空間の合力に対して行っていたが、スラスター
    // ベースになった今はソルバーに渡す前のローカル欲求力の段階で
    // 減算する方が自然（ソルバーが「後方に投げたい力」を正しく
    // 解釈でき、該当スラスターだけ自動的に弱まる）。
    const adjustedForce = this._clampDesiredForceAtMaxSpeed(ship, desiredForce);

    // スラスター出力比を解いて艦の状態に保存（06-hud.js / 07-engine-fx.js が参照）
    const ratios = ThrusterSolver.solve(ship, adjustedForce, desiredTorque);
    ship.thrusterOutputRatios = ratios;

    this._applyThrusters(ship, ratios, dt);
    this._applySpeedCap(ship, dt);
  },

  // -----------------------------------------------------------
  // 最高速到達中、ローカル欲求力のうち「現在の進行方向へさらに
  // 加速する」成分を除去する。減速方向（進行方向と逆）の成分は
  // そのまま残すため、最高速到達後も逆噴射でちゃんと減速できる。
  // -----------------------------------------------------------
  _clampDesiredForceAtMaxSpeed(ship, desiredForce) {
    if (!ship.isAtMaxSpeed) return desiredForce;

    const speed = vecLength(ship.velocity);
    if (speed <= 0) return desiredForce;

    // 艦の現在速度方向を、艦のローカル座標系に変換
    // （desiredForceがローカル座標系のため、比較対象も揃える）
    const worldDir = vecNormalize(ship.velocity);
    const localDir = rotateVecByQuat(worldDir, conjugateQuat(ship.quaternion));

    const alongSpeed = vecDot(desiredForce, localDir);
    if (alongSpeed <= 0) return desiredForce; // 既に減速方向、そのまま許可

    const proj = vecScale(localDir, alongSpeed);
    return {
      x: desiredForce.x - proj.x,
      y: desiredForce.y - proj.y,
      z: desiredForce.z - proj.z,
    };
  },

  // -----------------------------------------------------------
  // 各スラスターの出力比（0..1）から、実際の並進加速度・
  // 角加速度を計算して積分する。
  // -----------------------------------------------------------
  _applyThrusters(ship, ratios, dt) {
    let totalForceLocal = { x: 0, y: 0, z: 0 };
    let totalTorqueLocal = { x: 0, y: 0, z: 0 };

    for (const t of ship.thrusters) {
      const ratio = ratios[t.id] ?? 0;
      if (ratio <= 0) continue;

      const dirNorm = vecNormalize(t.direction);
      const reaction = vecScale(dirNorm, -1); // 反作用方向
      const forceLocal = vecScale(reaction, getEffectiveMaxThrust(ship, t) * ratio);

      totalForceLocal = vecAdd(totalForceLocal, forceLocal);

      // トルク = position × force（モーメントアーム）
      const torqueLocal = vecCross(t.position, forceLocal);
      totalTorqueLocal = vecAdd(totalTorqueLocal, torqueLocal);
    }

    // 並進: ローカル合力→ワールド変換→加速度→速度積分
    const worldForce = rotateVecByQuat(totalForceLocal, ship.quaternion);
    const ax = worldForce.x / ship.mass;
    const ay = worldForce.y / ship.mass;
    const az = worldForce.z / ship.mass;
    ship.velocity.x += ax * dt;
    ship.velocity.y += ay * dt;
    ship.velocity.z += az * dt;

    // 回転: ローカル合トルク→角加速度→角速度積分（慣性モーメントは
    // スカラー簡略化のため、トルクはローカル軸のまま角加速度に変換）
    const angAccelX = totalTorqueLocal.x / ship.inertia;
    const angAccelY = totalTorqueLocal.y / ship.inertia;
    const angAccelZ = totalTorqueLocal.z / ship.inertia;

    ship.angularVelocity.x += angAccelX * dt;
    ship.angularVelocity.y += angAccelY * dt;
    ship.angularVelocity.z += angAccelZ * dt;

    const maxW = ship.maxAngularSpeed;
    ship.angularVelocity.x = clamp(ship.angularVelocity.x, -maxW, maxW);
    ship.angularVelocity.y = clamp(ship.angularVelocity.y, -maxW, maxW);
    ship.angularVelocity.z = clamp(ship.angularVelocity.z, -maxW, maxW);
  },

  // -----------------------------------------------------------
  // 速度キャップ判定 + hard-capの場合はここで直接速度を丸める
  // -----------------------------------------------------------
  _applySpeedCap(ship, dt) {
    const speed = vecLength(ship.velocity);
    ship.isAtMaxSpeed = speed >= ship.maxSpeed;

    if (!ship.isAtMaxSpeed) return;

    const speedCapMode = getEffectiveSpeedCapMode(ship);
    if (speedCapMode === SpeedCapMode.HARD_CAP && speed > ship.maxSpeed) {
      // 超過分をハードに丸める（_clampDesiredForceAtMaxSpeedで既に
      // 加速方向は遮断済みだが、boost切り替え等の急変への保険として
      // 明示クランプ）
      const dir = vecNormalize(ship.velocity);
      ship.velocity.x = dir.x * ship.maxSpeed;
      ship.velocity.y = dir.y * ship.maxSpeed;
      ship.velocity.z = dir.z * ship.maxSpeed;
    }
    // soft-glowは速度を丸めない（_clampDesiredForceAtMaxSpeed側で
    // 「最高速方向への加速だけ遮断」しているため、理論上は
    // maxSpeedにほぼ張り付くが、僅かなオーバーシュートは許容し
    // 演出上の「頭打ち感」として自然に収束させる）
  },
};
