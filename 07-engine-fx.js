// =============================================================
// 07-engine-fx.js
// 噴射エフェクトシステム
//   - ship.thrusters（01-state-and-config.jsで艦種ごとに定義された
//     任意個数・任意配置のスラスター）を直接ループし、各スラスターの
//     kind（'main'/'rcs'）と出力比（04-flight-physics.js /
//     03-thruster-solver.jsが計算した ship.thrusterOutputRatios）に
//     応じてパーティクルを生成する。
//   - v01時点にあった「4方向RCS決め打ち」のノズルマッピングは廃止。
//     スラスターのposition/directionをそのまま使うため、艦種ごとの
//     スラスター配置を変えるだけで自動的にエフェクトも追従する。
//
// ship_simulatorのring-bufferプールパターンを踏襲:
//   固定容量のプールを確保し、CPU側で寿命管理、
//   GPU属性（position/size/opacity相当の色アルファ）を
//   毎フレーム一括転送する。
//
// v83: 粒子を「艦に固定した座標」（重心が原点、艦のローカル軸）で扱い、
// 粒子の描画オブジェクトを毎フレーム艦の位置・姿勢に合わせて置くようにした。
// 以前は宇宙空間の座標で扱い、艦の速度を足して動かしていたため、艦がその
// フレームで進んだあとにさらに1フレーム分先へ進んだ位置に出て、速く飛んで
// いるときや、旋回・横滑りで進む向きと艦首の向きが違うときに、噴射が
// ノズルからずれて見えた（「旋回したりするとノズルの位置がずれる」）。
// =============================================================

const EngineFx = {
  // v81: 主エンジンを複数持てる自作の艦のため、主エンジン用は多めに確保
  // （1基あたりの量は _spawnThrustFx で基数に応じて減らす）
  MAX_MAIN_PARTICLES: 1800,
  MAX_RCS_PARTICLES: 400,

  _mainPool: null, // { points, geometry, particles: [...] }
  _rcsPool: null,

  // -----------------------------------------------------------
  // 初期化: シーンにパーティクルシステムを追加
  // -----------------------------------------------------------
  init(scene) {
    this._mainPool = this._createPool(this.MAX_MAIN_PARTICLES, {
      color: 0x6db8ff,
      baseSize: 3.2,
    });
    this._rcsPool = this._createPool(this.MAX_RCS_PARTICLES, {
      color: 0xffe6a8,
      baseSize: 1.4,
    });

    scene.add(this._mainPool.points);
    scene.add(this._rcsPool.points);
  },

  _createPool(maxCount, { color, baseSize }) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(maxCount * 3);
    const sizes = new Float32Array(maxCount);
    const alphas = new Float32Array(maxCount);

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('psize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

    // per-particleサイズ・アルファをGLSLで反映するシェーダーマテリアル
    // （ship_simulator v98のpsize属性パターンを踏襲）
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uBaseSize: { value: baseSize },
      },
      vertexShader: `
        attribute float psize;
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float d = length(uv);
          if (d > 0.5) discard;
          float edge = smoothstep(0.5, 0.15, d);
          gl_FragColor = vec4(uColor, vAlpha * edge);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false; // 艦から離れた噴射粒子が消えないように

    // CPU側の寿命管理用配列（ring-buffer）
    const particles = new Array(maxCount);
    for (let i = 0; i < maxCount; i++) {
      particles[i] = {
        active: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 0,
        size: baseSize,
      };
    }

    return {
      points,
      geometry,
      material,
      particles,
      cursor: 0, // 次に上書きするインデックス（ring-buffer）
      maxCount,
    };
  },

  // -----------------------------------------------------------
  // 毎フレーム呼び出し
  // -----------------------------------------------------------
  update(dt) {
    const ship = State.ship;
    if (!ship) return;

    // 粒子は艦のローカル座標なので、描画オブジェクトを艦の位置・姿勢に置く
    for (const pool of [this._mainPool, this._rcsPool]) {
      pool.points.position.set(ship.position.x, ship.position.y, ship.position.z);
      pool.points.quaternion.set(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    }

    this._spawnThrustFx(ship, dt);

    this._stepPool(this._mainPool, dt);
    this._stepPool(this._rcsPool, dt);

    this._uploadPool(this._mainPool);
    this._uploadPool(this._rcsPool);
  },

  // -----------------------------------------------------------
  // ship.thrusters を直接ループしてパーティクルを生成する。
  // 各スラスターのposition/directionをそのままワールド変換して
  // 使うため、艦種プリセット側のスラスター配置を変えれば
  // このファイルを一切触らずにエフェクトも追従する。
  // -----------------------------------------------------------
  _spawnThrustFx(ship, dt) {
    // v78: 自作の艦は大きさに応じて噴射の長さ・太さを拡大する（ロケット級は1）
    const fx = ship.fxScale || 1;
    // v81: 主エンジンが4基以上あるときは1基あたりの粒子を減らし、全基の噴射が
    // 粒子の容量（MAX_MAIN_PARTICLES）に収まるようにする（減らさないと
    // 古い粒子から上書きされ、どの噴射も短く途切れて見える）
    let mainCount = 0;
    for (const t of ship.thrusters) if (t.kind === 'main') mainCount++;
    const mainDensity = Math.min(1, 3 / Math.max(1, mainCount));
    // v83: 粒子の大きさ（噴射の太さ）。大きな艦では艦の大きさほどには太くせず、
    // 主エンジンが複数あるときは1基あたりを細くする（ロケット級1基は従来どおり）
    const sizeFx = Math.pow(fx, 0.85);
    const mainSizeFx = sizeFx / Math.sqrt(Math.max(1, mainCount));
    const rcsSizeFx = fx > 1 ? sizeFx * 0.7 : 1;
    for (const t of ship.thrusters) {
      const ratio = ship.thrusterOutputRatios[t.id] ?? 0;
      if (ratio <= 0.01) continue;

      const isMain = t.kind === 'main';
      const pool = isMain ? this._mainPool : this._rcsPool;

      // v83: 艦のローカル座標（ノズルの位置・噴射の向きをそのまま使う）
      const nozzle = t.position;
      const dir = vecNormalize(t.direction);

      // 出力比に応じてスポーン数を可変（多いほど濃い噴射に見える）
      const spawnCount = isMain
        ? Math.round(ratio * 14 * mainDensity)
        : Math.round(ratio * 6);

      for (let i = 0; i < spawnCount; i++) {
        const p = this._acquireParticle(pool);
        if (!p) break;

        const spread = isMain ? 0.35 : 0.5;  // 速度に掛けるので大きさの倍率は不要
        const jitterX = (Math.random() - 0.5) * spread;
        const jitterY = (Math.random() - 0.5) * spread;
        const jitterZ = (Math.random() - 0.5) * spread;

        p.active = true;
        p.x = nozzle.x;
        p.y = nozzle.y;
        p.z = nozzle.z;

        const baseSpeed = (isMain
          ? 12 + Math.random() * 8 + ratio * 10
          : 6 + Math.random() * 4) * fx;

        p.vx = dir.x * baseSpeed + jitterX * baseSpeed * 0.3;
        p.vy = dir.y * baseSpeed + jitterY * baseSpeed * 0.3;
        p.vz = dir.z * baseSpeed + jitterZ * baseSpeed * 0.3;

        p.maxLife = isMain
          ? 0.5 + Math.random() * 0.4
          : 0.2 + Math.random() * 0.15;
        p.life = p.maxLife;
        // v83: このフレームの間（0〜dt）に均等に出たことにする。直後の _stepPool で
        // dt 進むので、ノズルから「出てからの時間 × 速度」の位置に並び、
        // フレームレートが低いときや大きな艦（噴射が速い）でも粒のかたまりに分かれない
        const back = dt * (1 - Math.random());
        p.x -= p.vx * back;
        p.y -= p.vy * back;
        p.z -= p.vz * back;
        p.size = isMain
          ? (2.2 + ratio * 2.4) * (0.7 + Math.random() * 0.6) * mainSizeFx
          : (1.0 + Math.random() * 0.6) * rcsSizeFx;
      }
    }
  },

  // -----------------------------------------------------------
  // ring-bufferから次のスロットを取得（既存粒子は寿命を問わず上書き。
  // ship_simulatorのMAX_WAKE_PARTICLESパターンと同様、容量超過時は
  // 古い粒子から強制的に再利用される）
  // -----------------------------------------------------------
  _acquireParticle(pool) {
    const idx = pool.cursor;
    pool.cursor = (pool.cursor + 1) % pool.maxCount;
    return pool.particles[idx];
  },

  // -----------------------------------------------------------
  // CPU側の寿命・位置更新
  // -----------------------------------------------------------
  _stepPool(pool, dt) {
    for (let i = 0; i < pool.maxCount; i++) {
      const p = pool.particles[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // 減速（噴射ガスの拡散による見た目の減衰、抵抗ゼロの艦体physicsとは無関係）
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.vz *= 0.96;
    }
  },

  // -----------------------------------------------------------
  // GPU属性へ一括転送
  // -----------------------------------------------------------
  _uploadPool(pool) {
    const posAttr = pool.geometry.getAttribute('position');
    const sizeAttr = pool.geometry.getAttribute('psize');
    const alphaAttr = pool.geometry.getAttribute('alpha');

    for (let i = 0; i < pool.maxCount; i++) {
      const p = pool.particles[i];
      if (!p.active) {
        alphaAttr.array[i] = 0;
        continue;
      }

      posAttr.array[i * 3 + 0] = p.x;
      posAttr.array[i * 3 + 1] = p.y;
      posAttr.array[i * 3 + 2] = p.z;
      sizeAttr.array[i] = p.size;

      const lifeRatio = p.life / p.maxLife;
      alphaAttr.array[i] = lifeRatio; // フェードアウト
    }

    posAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  },
};
