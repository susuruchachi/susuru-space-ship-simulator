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
// -----------------------------------------------------------

// 微小角速度(rad, 各軸)から近似クォータニオンを生成
function eulerToQuatSmall(wx, wy, wz) {
  const halfX = wx * 0.5;
  const halfY = wy * 0.5;
  const halfZ = wz * 0.5;

  // 小角近似ではなく正確に軸ごとの回転を合成（順序: pitch -> yaw -> roll）
  const qx = axisAngleQuat({ x: 1, y: 0, z: 0 }, wx);
  const qy = axisAngleQuat({ x: 0, y: 1, z: 0 }, wy);
  const qz = axisAngleQuat({ x: 0, y: 0, z: 1 }, wz);

  return multiplyQuat(multiplyQuat(qx, qy), qz);
}

function axisAngleQuat(axis, angle) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return {
    x: axis.x * s,
    y: axis.y * s,
    z: axis.z * s,
    w: Math.cos(half),
  };
}

function multiplyQuat(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function normalizeQuat(q) {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

// クォータニオン -> オイラー角（デバッグ表示用、06-hud.jsから使用）。
// 回転順序はeulerToQuatSmallと対になる pitch(X) -> yaw(Y) -> roll(Z)
// のTait-Bryan角として抽出する。ジンバルロック（pitchが±90度付近）
// 時はroll/yawが不定になるため、その場合はrollを0に固定してyaw側に
// 寄せる一般的な回避策を採る（表示用途のため厳密な連続性は求めない）。
function quatToEulerDegrees(q) {
  const { x, y, z, w } = q;

  // pitch (X軸回転)
  const sinPitch = 2 * (w * x - y * z);
  const pitch = Math.abs(sinPitch) >= 1
    ? Math.sign(sinPitch) * (Math.PI / 2)
    : Math.asin(sinPitch);

  let yaw, roll;
  if (Math.abs(sinPitch) >= 0.999999) {
    // ジンバルロック付近: rollを0に固定してyawへ寄せる
    yaw = Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z));
    roll = 0;
  } else {
    yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
    roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  }

  const toDeg = (rad) => rad * (180 / Math.PI);
  return { pitch: toDeg(pitch), yaw: toDeg(yaw), roll: toDeg(roll) };
}
