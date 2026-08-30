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

  // 毎フレーム呼び出し
  update(dt) {
    const ship = State.ship;
    if (!ship || State.paused) return;

    InputSystem.update();
    FlightPhysics.step(ship, State.input, dt);
    this._integratePose(ship, dt);
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
