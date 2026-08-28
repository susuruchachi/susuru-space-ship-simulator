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
    // v18: 自動操船中、目的地までの距離が1未満かつ現在速度も1未満に
    // なったら「到着」とみなし、スラスターを一切使わず艦をシステム
    // 側で目的地の位置・姿勢へ完全固定する（速度・角速度もゼロに
    // 落とす）。_lockHeadingIfWithinTolerance（03-thruster-solver.js）
    // と同じ「オートパイロットの補助機能として状態へ直接介入する」
    // 考え方の延長で、位置についても最終的にはスラスター制御に
    // 頼らずロックする。これ以降は通常のソルバー/積分処理を
    // 一切通さないため、以後の手動入力・自動制御力は無視される
    // （自動操船をOFFにすれば通常の物理へ復帰する）。
    if (this._tryLockAtDockingArrival(ship)) return;

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
  // v18: 自動操船中の到着判定＋完全固定。
  //   条件: ship.autoDockingEnabled && State.dockingTarget があり、
  //         目的地までの距離 < DOCKING_ARRIVAL_DISTANCE (既定1) かつ
  //         現在速度 < DOCKING_ARRIVAL_SPEED (既定1)。
  //   固定内容: position/quaternionを目的地の値へ直接セットし、
  //   velocity/angularVelocityをゼロにする。スラスター出力比
  //   （ship.thrusterOutputRatios、HUD/エンジンFXが参照）も全て0に
  //   落とし、「スラスターを使わず止まっている」ことが見た目にも
  //   一致するようにする。
  //   一度固定に入ったら、艦がその場から動く要因（外力等）は
  //   このゲーム内には存在しないため、自動操船がONかつ目的地が
  //   変わらない限りロックされ続ける。
  //
  //   v34: 距離・速度だけを見て固定していたため、ヨー反転などで
  //   最終進入(inFinalApproach)に一度も入れないまま姿勢が揃わず
  //   入港（固定）してしまう不具合があった。対応として、固定条件に
  //   以下の2つを追加する。
  //     (1) 直前フレームが最終進入フェーズだったこと
  //         （ship._dockingWasInFinalApproach、03-thruster-solver.js
  //         の_buildDesiredForAutoDockingが毎フレーム更新する。この
  //         関数はFlightPhysics.stepの中で本メソッドの後に呼ばれる
  //         ため、ここで参照できるのは常に「直前フレーム時点」の値。
  //         これにより「最終進入から切り替わる場合」以外での固定を
  //         防ぐ）。
  //     (2) 船の姿勢が実際に目的地の保存済み姿勢と揃っていること
  //         （heading・rollの両方をDOCKING_FINAL_APPROACH_HEADING_
  //         READY_ANGLE / DOCKING_ARRIVAL_ROLL_READY_ANGLE以内で判定）。
  // -----------------------------------------------------------
  DOCKING_ARRIVAL_DISTANCE: 1.0,
  DOCKING_ARRIVAL_SPEED: 1.0,
  // roll角の到着許容角度(rad)。heading側はThrusterSolver.
  // DOCKING_FINAL_APPROACH_HEADING_READY_ANGLE（最終進入フェーズに
  // 入るための基準）をそのまま流用し、rollだけこちらで別途定義する
  // （最終進入フェーズはheadingのみを条件にしておりrollまでは
  // 見ていないため）。
  DOCKING_ARRIVAL_ROLL_READY_ANGLE: 0.14,

  // 船の姿勢が目的地の保存済み姿勢とheading・rollの両方で揃っているか。
  _isAttitudeReadyForArrival(ship, target) {
    const approachAxisWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    const approachAxisLocal = rotateVecByQuat(approachAxisWorld, conjugateQuat(ship.quaternion));
    const headingErrorFromAxis = Math.acos(clamp(-approachAxisLocal.z, -1, 1));
    if (headingErrorFromAxis > ThrusterSolver.DOCKING_FINAL_APPROACH_HEADING_READY_ANGLE) {
      return false;
    }

    const rollError = ThrusterSolver._computeRollErrorAngle(ship, target);
    return Math.abs(rollError.angle) <= this.DOCKING_ARRIVAL_ROLL_READY_ANGLE;
  },

  _tryLockAtDockingArrival(ship) {
    if (!ship || !ship.autoDockingEnabled || !State.dockingTarget) return false;

    const target = State.dockingTarget;
    const dx = target.position.x - ship.position.x;
    const dy = target.position.y - ship.position.y;
    const dz = target.position.z - ship.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const speed = vecLength(ship.velocity);

    if (distance >= this.DOCKING_ARRIVAL_DISTANCE || speed >= this.DOCKING_ARRIVAL_SPEED) {
      return false;
    }

    // v34: 最終進入から切り替わる場合のみ固定を許可する。
    if (!ship._dockingWasInFinalApproach) {
      return false;
    }

    // v34: 姿勢（heading・roll）が実際に揃っていることも固定条件にする。
    if (!this._isAttitudeReadyForArrival(ship, target)) {
      return false;
    }

    ship.position.x = target.position.x;
    ship.position.y = target.position.y;
    ship.position.z = target.position.z;

    ship.quaternion.x = target.quaternion.x;
    ship.quaternion.y = target.quaternion.y;
    ship.quaternion.z = target.quaternion.z;
    ship.quaternion.w = target.quaternion.w;

    ship.velocity.x = 0;
    ship.velocity.y = 0;
    ship.velocity.z = 0;

    ship.angularVelocity.x = 0;
    ship.angularVelocity.y = 0;
    ship.angularVelocity.z = 0;

    // スラスター側の表示・演出もゼロに揃える
    for (const t of ship.thrusters) {
      ship.thrusterOutputRatios[t.id] = 0;
    }
    ship.isAtMaxSpeed = false;

    return true;
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
