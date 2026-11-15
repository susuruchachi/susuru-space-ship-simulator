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
  MAX_RCS_PARTICLES: 1200,

  _mainPool: null, // { points, geometry, particles: [...] }
  _rcsPool: null,

  // v84: 粒子の大きさは m（実際の大きさ）で持つ。v83までは画面のピクセル基準の値
  // （画面の解像度で見た目の太さが変わっていた）だったので、ノズルの直径を持たない
  // 艦種プリセットはその値にこの係数を掛けて、iPad（横向き）で見ていた太さに近くする
  LEGACY_SIZE_TO_M: 0.25,
  _pxPerUnit: 700,

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

    // v85: 主エンジン・逆噴射の炎（27-engine-plumes.js。機関の種類ごとの形）
    this._plumeRoot = new THREE.Group();
    scene.add(this._plumeRoot);

    // v85: 重力場機関の艦が浮いている密度境界面
    // v89: 面全体を光らせるのをやめ（面のあるところ・ないところで濃さが違って見えていた）、
    //   水を進む船のような引き波だけを描く（_buildWake / _updateBoundary）
    this._buildWake(scene);
  },

  // v89: 艦の形の大きさ（艦の座標: 幅 x・高さ y・長さ z と中心）。メッシュが替わったら測り直す
  shipBox(ship) {
    const m = ship && ship.mesh;
    if (!m) return null;
    if (this._boxCache && this._boxCache.mesh === m && this._boxCache.n === m.children.length) return this._boxCache.box;
    const pos = m.position.clone(), quat = m.quaternion.clone();
    m.position.set(0, 0, 0); m.quaternion.identity(); m.updateMatrixWorld(true);
    const b = new THREE.Box3();
    m.traverse((o) => { if (o.isMesh && o.geometry && o.visible !== false && !o.userData.noBox) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); b.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    m.position.copy(pos); m.quaternion.copy(quat); m.updateMatrixWorld(true);
    const size = ship.size || 10;
    const box = b.isEmpty() ? { size: new THREE.Vector3(size * 0.15, size * 0.15, size), center: new THREE.Vector3() } : { size: b.getSize(new THREE.Vector3()), center: b.getCenter(new THREE.Vector3()) };
    this._boxCache = { mesh: m, n: m.children.length, box };
    return box;
  },

  // ---------------------------------------------------------
  // v89: 境界面の引き波
  //   艦が通った跡（艦からの相対位置で覚える。まわりの速さ = 速度の基準に対して止まっている）に沿って、盛り上がった波の帯を作る:
  //     先頭（進む向きの端）から左右へ開く波（外側の大きな波と、その内側の小さな波）、後ろの端から開く波、真後ろの泡の筋。
  //   波は、出たところから進んだ距離に比例して横へ広がる（ケルビンの角 19.5°）ので、速さによらず同じ V 字になる。
  //   跡は艦と一緒に回らない: 前進から後進へ切り替えると、前の波はその場に残って消えていき、新しい波が新しい先頭から出る。
  //   帯は本当に盛り上がった形（境界面の上向きへ持ち上げた頂点）で、光の当たる側が明るく、反対側が暗い。
  //   船体のまわりには、喫水線（境界面で切った船体の輪郭）に沿う白波。進む向きの側が高く盛り上がる
  // ---------------------------------------------------------
  WAKE_N: 64,          // 跡の点の数（帯1本あたり）
  WAKE_ACROSS: 5,      // 帯の幅方向の頂点の数
  WAKE_LEN: 4.5,       // 跡の長さ（船体の長さの何倍まで）
  WAKE_LIFE: 12,       // 跡が消えるまでの時間 [s]（止まったあと）
  WAKE_OUTLINE_N: 40,  // 喫水線の輪郭の点の数（片舷）
  _wake: null,
  _boundary: null,
  _buildWake(scene) {
    const N = this.WAKE_N + 1, A = this.WAKE_ACROSS;
    // 帯: [先頭の外の波 左・右, 先頭の内の波 左・右, 後ろの波 左・右, 真後ろの泡]
    const R = 7;
    const mk = (rows, across, strips) => {
      const nv = rows * across * strips;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
      geo.setAttribute('aI', new THREE.BufferAttribute(new Float32Array(nv), 1));
      geo.setAttribute('aU', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
      const idx = [];
      for (let r = 0; r < strips; r++) for (let i = 0; i < rows - 1; i++) for (let a = 0; a < across - 1; a++) {
        const v0 = (r * rows + i) * across + a, v1 = v0 + 1, v2 = v0 + across, v3 = v2 + 1;
        idx.push(v0, v2, v1, v1, v2, v3);
      }
      geo.setIndex(idx);
      return geo;
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute float aI; attribute vec3 aU; varying float vI; varying vec3 vU;
void main() { vI = aI; vU = aU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; varying float vI; varying vec3 vU;
void main() {
  // vU: x = 幅方向（-1 内側〜+1 外側）、y = 出たところからの距離（船体の長さ単位）、z = 種類（0 波の帯 / 1 真後ろ / 2 喫水線）
  float edge = 1.0 - smoothstep(0.5, 1.0, abs(vU.x));
  float a = vI * edge;
  float foam = 0.0;
  if (vU.z < 0.5) {
    // 波の帯: 腕に沿って、斜めの短い波の山が並ぶ（後ろへ流れる）
    float crest = 0.5 + 0.5 * sin((vU.y * 5.5 - vU.x * 0.9) * 6.2832 - uTime * 2.2);
    a *= 0.35 + 0.65 * crest * crest;
    foam = (1.0 - smoothstep(0.0, 0.35, abs(vU.x))) * crest * crest;
  } else if (vU.z < 1.5) {
    // 真後ろ: 進む向きに直角の弧の波と、中心線の泡の筋
    float arcs = 0.5 + 0.5 * sin((vU.y + vU.x * vU.x * 0.35) * 4.0 * 6.2832 - uTime * 2.2);
    float churn = (1.0 - smoothstep(0.0, 0.3, abs(vU.x))) * (0.6 + 0.4 * sin(vU.y * 90.0 + uTime * 9.0) * sin(vU.x * 40.0 - uTime * 6.0)) * exp(-vU.y * 1.2);
    a *= 0.25 + 0.75 * arcs * arcs * (1.0 - 0.5 * abs(vU.x)) + churn * 1.6;
    foam = churn;
  } else {
    foam = 0.6 + 0.4 * sin(vU.y * 9.0 + uTime * 6.0);
  }
  vec3 col = mix(vec3(0.30, 0.62, 0.95), vec3(0.80, 0.95, 1.0), clamp(vI * 1.4, 0.0, 1.0)) + vec3(0.3) * foam * vI;
  gl_FragColor = vec4(col * a, a);
}`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const g = new THREE.Group();
    const ribbons = new THREE.Mesh(mk(N, A, R), mat);
    const M = this.WAKE_OUTLINE_N * 2 + 1; // 輪郭を一周（閉じる）
    const line = new THREE.Mesh(mk(M, 3, 1), mat);
    for (const m of [ribbons, line]) { m.frustumCulled = false; m.renderOrder = 2; g.add(m); }
    g.visible = false;
    scene.add(g);
    this._boundary = g;
    this._wake = { ribbons, line, mat, samples: [], lastEmit: null, R, N, M };
  },

  // 喫水線（境界面の高さで切った船体の輪郭）: 艦の前後の位置ごとの、左・右の端（艦の座標）。メッシュ・高さが変わったら測り直す
  _waterline(ship) {
    const m = ship.mesh, yb = ship.boundaryHeight || 0;
    const c = this._wlCache;
    if (c && c.mesh === m && c.n === m.children.length && Math.abs(c.yb - yb) < 1e-6) return c.wl;
    const box = this.shipBox(ship);
    const K = this.WAKE_OUTLINE_N;
    const z0 = box.center.z - box.size.z / 2, z1 = box.center.z + box.size.z / 2, dz = (z1 - z0) / K || 1;
    const run = (cut) => {
      const L = new Float32Array(K + 1).fill(Infinity), Rr = new Float32Array(K + 1).fill(-Infinity);
      const put = (x, z) => { const k = Math.round((z - z0) / dz); if (k < 0 || k > K) return; if (x < L[k]) L[k] = x; if (x > Rr[k]) Rr[k] = x; };
      const seg = (ax, az, bx, bz) => { const n = Math.max(1, Math.ceil(Math.abs(bz - az) / dz * 2)); for (let i = 0; i <= n; i++) put(ax + (bx - ax) * i / n, az + (bz - az) * i / n); };
      const pos = m.position.clone(), quat = m.quaternion.clone();
      m.position.set(0, 0, 0); m.quaternion.identity(); m.updateMatrixWorld(true);
      const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
      m.traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || o.userData.noBox) return;
        const p = o.geometry.attributes.position, ix = o.geometry.index, M4 = o.matrixWorld;
        const nt = ix ? ix.count / 3 : p.count / 3;
        // 細かいモデルは間引く（輪郭には十分）
        const step = Math.max(1, Math.floor(nt / 250000));
        for (let t = 0; t < nt; t += step) {
          const i0 = ix ? ix.getX(t * 3) : t * 3, i1 = ix ? ix.getX(t * 3 + 1) : t * 3 + 1, i2 = ix ? ix.getX(t * 3 + 2) : t * 3 + 2;
          A.fromBufferAttribute(p, i0).applyMatrix4(M4); B.fromBufferAttribute(p, i1).applyMatrix4(M4); C.fromBufferAttribute(p, i2).applyMatrix4(M4);
          if (!cut) { put(A.x, A.z); put(B.x, B.z); put(C.x, C.z); continue; }
          const da = A.y - yb, db = B.y - yb, dc = C.y - yb;
          if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) continue;
          // 三角形と面の交わる線分
          const pts = [];
          const edge = (P, Q, dp, dq) => { if ((dp > 0) !== (dq > 0) && dp !== dq) { const k = dp / (dp - dq); pts.push(P.x + (Q.x - P.x) * k, P.z + (Q.z - P.z) * k); } };
          edge(A, B, da, db); edge(B, C, db, dc); edge(C, A, dc, da);
          if (pts.length >= 4) seg(pts[0], pts[1], pts[2], pts[3]);
        }
      });
      m.position.copy(pos); m.quaternion.copy(quat); m.updateMatrixWorld(true);
      return { L, R: Rr };
    };
    let o = run(true);
    let hit = 0;
    for (let k = 0; k <= K; k++) if (o.R[k] > o.L[k]) hit++;
    if (hit < K * 0.3) o = run(false); // 面が船体を切っていない（船体より上・下）: 上から見た輪郭を使う
    // 穴を埋め、なめらかにして、輪郭の点（右舷を後ろ→前、左舷を前→後ろ。艦の座標 x,z）にする
    const cx = box.center.x;
    const hw = (k) => (o.R[k] > o.L[k] ? [o.L[k], o.R[k]] : null);
    let first = -1, last = -1;
    for (let k = 0; k <= K; k++) if (hw(k)) { if (first < 0) first = k; last = k; }
    const pts = [];
    if (first < 0) { first = 0; last = K; }
    const span = Math.max(1, last - first);
    const at = (u) => { // u: 0（前の端 = z 最小）〜 1（後ろの端）
      const kf = first + u * span;
      let k0 = Math.floor(kf), k1 = Math.min(last, k0 + 1);
      while (k0 > first && !hw(k0)) k0--; while (k1 < last && !hw(k1)) k1++;
      const a = hw(k0) || [cx, cx], b = hw(k1) || a;
      const f = k1 > k0 ? (kf - k0) / (k1 - k0) : 0;
      return { l: a[0] + (b[0] - a[0]) * f, r: a[1] + (b[1] - a[1]) * f, z: z0 + kf * dz };
    };
    const K2 = this.WAKE_OUTLINE_N;
    const right = [], left = [];
    for (let i = 0; i < K2; i++) {
      // 端のほうを細かく（船首・船尾の丸み）
      const u = 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / K2);
      const q = at(u);
      // 両端は中心線へすぼめる（輪郭を閉じる）
      const e = Math.min(1, Math.min(u, 1 - u) * 30);
      const mid = (q.l + q.r) / 2;
      right.push({ x: mid + (q.r - mid) * e, z: q.z });
      left.push({ x: mid + (q.l - mid) * e, z: q.z });
    }
    for (let i = 0; i < K2; i++) pts.push(right[i]);
    for (let i = K2 - 1; i >= 0; i--) pts.push(left[i]);
    const wl = { pts, yb, beam: Math.max(...right.map((p, i) => p.x - left[i].x)) };
    this._wlCache = { mesh: m, n: m.children.length, yb, wl };
    return wl;
  },

  _updateBoundary(ship) {
    const g = this._boundary, W = this._wake;
    if (!g || !W) return;
    const warping = typeof Navigation !== 'undefined' && Navigation.isWarping && Navigation.isWarping();
    g.visible = !!ship.gravityDrive && !!ship.mesh && !warping;
    if (!g.visible) { W.samples.length = 0; W.lastEmit = null; return; }
    const dt = this._dtLast || 0.016;
    const q = ship.boundaryQuat || ship.quaternion;
    const qb = new THREE.Quaternion(q.x, q.y, q.z, q.w), qInv = qb.clone().invert();
    const off = rotateVecByQuat({ x: 0, y: ship.boundaryHeight || 0, z: 0 }, q);
    g.position.set(ship.position.x + off.x, ship.position.y + off.y, ship.position.z + off.z);
    g.quaternion.copy(qb);
    const box = this.shipBox(ship);
    const L = Math.max(2, box.size.z);
    const wl = this._waterline(ship);
    const shipQ = new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    // 喫水線の輪郭を、境界面の座標（x 右・z 後ろ・y 上）へ
    const tmp = new THREE.Vector3();
    const outline = wl.pts.map((p) => { tmp.set(p.x, wl.yb, p.z).applyQuaternion(shipQ).applyQuaternion(qInv); return { x: tmp.x, z: tmp.z }; });
    // 進む速さ・向き（速度の基準に対して。境界面に沿う成分）
    const rv = typeof ShipController !== 'undefined' && ShipController.relVelocity ? ShipController.relVelocity(ship) : ship.velocity;
    const v3 = new THREE.Vector3(rv.x, rv.y, rv.z);
    const vl = v3.clone().applyQuaternion(qInv);
    const vp = Math.hypot(vl.x, vl.z);
    const str = 1 - Math.exp(-vp / (0.15 * L));
    const dirL = vp > 1e-3 ? { x: vl.x / vp, z: vl.z / vp } : (W.dirL || { x: 0, z: -1 });
    W.dirL = dirL;
    const dirW = new THREE.Vector3(dirL.x, 0, dirL.z).applyQuaternion(qb); // フレームの座標
    // 輪郭の、進む向きの前の端・後ろの端までの長さ
    let extF = 0, extB = 0;
    for (const p of outline) { const d = p.x * dirL.x + p.z * dirL.z; if (d > extF) extF = d; if (-d > extB) extB = -d; }
    // --- 跡を進める（跡は、まわりに対して止まっている = 艦から見ると後ろへ流れる）---
    const ds = (L * this.WAKE_LEN) / this.WAKE_N;
    const move = v3.clone().multiplyScalar(-dt);
    const smax = L * this.WAKE_LEN;
    for (const sm of W.samples) { sm.rel.add(move); sm.s += vp * dt; sm.t += dt; }
    W.samples = W.samples.filter((sm) => sm.s < smax && sm.t < this.WAKE_LIFE);
    if (W.lastEmit) W.lastEmit.add(move);
    if (vp > 0.02 * L) {
      if (!W.lastEmit) W.lastEmit = new THREE.Vector3();
      let gap = W.lastEmit.length();
      if (gap >= ds) {
        const back = W.lastEmit.clone().normalize();
        let n = Math.floor(gap / ds);
        if (n > this.WAKE_N) { n = this.WAKE_N; gap = n * ds; } // とても速いとき: 後ろの決まった長さだけ並べる
        const add = [];
        for (let j = 1; j <= n; j++) {
          const d = gap - j * ds;
          add.push({ rel: back.clone().multiplyScalar(d), dir: dirW.clone(), s: d, t: 0, str, extF, extB });
        }
        add.reverse(); // 新しい順（艦に近い順）
        W.samples = add.concat(W.samples).slice(0, this.WAKE_N);
        W.lastEmit = W.samples[0].rel.clone();
      }
    } else if (!W.samples.length) W.lastEmit = null;
    // --- 帯を作る ---
    const N = W.N, A = this.WAKE_ACROSS;
    const pos = W.ribbons.geometry.attributes.position, aI = W.ribbons.geometry.attributes.aI, aU = W.ribbons.geometry.attributes.aU;
    // 光の向き（境界面の座標）。面の下から照らされていても、上からの光として扱う
    let lightL = new THREE.Vector3(0.4, 0.8, -0.4).normalize();
    if (typeof SolarSystem !== 'undefined' && typeof Navigation !== 'undefined' && Navigation.frame && SolarSystem.byId && SolarSystem.byId.sun) {
      const u = Navigation.shipUniverse(), star = SolarSystem.byId.sun;
      const d = Astro.mat3MulVec(Navigation.frame.rotT, { x: star.pos.x - u.x, y: star.pos.y - u.y, z: star.pos.z - u.z });
      const l = new THREE.Vector3(d.x, d.y, d.z).normalize().applyQuaternion(qInv);
      l.y = Math.max(0.35, Math.abs(l.y)); lightL = l.normalize();
    }
    // 跡の点（今の艦の位置を先頭に）を、境界面の座標へ
    const pts = [{ x: 0, z: 0, dx: dirL.x, dz: dirL.z, s: 0, f: str, extF, extB }];
    for (const sm of W.samples) {
      tmp.copy(sm.rel).applyQuaternion(qInv);
      const px = tmp.x, pz = tmp.z;
      tmp.copy(sm.dir).applyQuaternion(qInv);
      const dl = Math.hypot(tmp.x, tmp.z) || 1;
      const fade = sm.str * Math.pow(Math.max(0, 1 - sm.s / smax), 1.3) * Math.max(0, 1 - sm.t / this.WAKE_LIFE);
      pts.push({ x: px, z: pz, dx: tmp.x / dl, dz: tmp.z / dl, s: sm.s, f: fade, extF: sm.extF, extB: sm.extB });
    }
    // 向きが大きく変わったところ（前進 ⇄ 後進の切り替えなど）・間のあいたところでは、帯をつなげない（そこで消す）
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.dx * b.dx + a.dz * b.dz < 0.75 || Math.hypot(a.x - b.x, a.z - b.z) > ds * 3.5) { a.cut = true; b.cut = true; }
    }
    for (const p of pts) if (p.cut) p.f = 0;
    const prof = [0, 0.7, 1, 0.7, 0]; // 幅方向の高さ（真ん中が頂）
    const slope = [0.6, 1, 0, -1, -0.6]; // 内側（跡の中心線の側）から外側へ: 上り → 頂 → 下り
    const beam = Math.max(wl.beam, L * 0.04);
    // 帯の種類: side（±1 = 右・左、0 = 真ん中）、開き（進んだ距離に対する横の広がり）、どちらの端から出るか、高さ・明るさ
    const kinds = [
      { side: 1, k: 0.3536, end: 1, amp: 1.0, w0: 0.030, w1: 0.085 }, { side: -1, k: 0.3536, end: 1, amp: 1.0, w0: 0.030, w1: 0.085 },
      { side: 1, k: 0.19, end: 1, amp: 0.5, w0: 0.020, w1: 0.050 }, { side: -1, k: 0.19, end: 1, amp: 0.5, w0: 0.020, w1: 0.050 },
      { side: 1, k: 0.17, end: -1, amp: 0.6, w0: 0.024, w1: 0.055, lat0: 0.35 }, { side: -1, k: 0.17, end: -1, amp: 0.6, w0: 0.024, w1: 0.055, lat0: 0.35 },
      { side: 0, k: 0, end: -1, amp: 0.45, flat: true },
    ];
    const ampH = L * 0.03; // 波の高さ（いちばん大きな波）
    let vi = 0;
    for (let r = 0; r < kinds.length; r++) {
      const K = kinds[r];
      for (let i = 0; i < N; i++) {
        const p = pts[Math.min(i, pts.length - 1)];
        const dead = i >= pts.length;
        const nx = -p.dz, nz = p.dx; // 進む向きに直角（右）
        const ext = K.end > 0 ? p.extF : -p.extB;
        // 出たところ（先頭 or 後ろの端）から、横へ広がった位置
        const lat = K.side * (K.k * p.s + (K.lat0 || 0) * beam * 0.5);
        const cx = p.x + p.dx * ext + nx * lat, cz = p.z + p.dz * ext + nz * lat;
        const hw = K.flat ? beam * 0.45 + 0.28 * p.s : L * (K.w0 + K.w1 * p.s / L);
        // 先頭の波は、出てすぐは船体に沿って立ち上がる（出た直後は低い）
        const rise = K.flat ? Math.min(1, p.s / (L * 0.15)) : Math.min(1, 0.35 + p.s / (L * 0.12));
        const f = dead ? 0 : p.f * K.amp * rise;
        // 腕に沿って、波の山と谷（山のところが高い。後ろへ流れる）
        const hump = K.flat ? 1 : 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin((p.s / L) * 5.5 * 6.2832 - this._time * 2.2), 2);
        const h = ampH * f * hump;
        const tilt = Math.min(1.4, (h / Math.max(1e-6, hw)) * 2.2);
        for (let a = 0; a < A; a++) {
          const u = (a / (A - 1)) * 2 - 1; // -1 = 内側 / +1 = 外側
          const sgn = K.side === 0 ? 1 : K.side;
          const ox = nx * sgn * u * hw, oz = nz * sgn * u * hw;
          const y = K.flat ? h * 0.3 * prof[a] : h * prof[a];
          pos.setXYZ(vi, cx + ox, y, cz + oz);
          // 盛り上がりの向き（内側の斜面は内へ、外側の斜面は外へ傾く）から、光の当たり方
          const tl = K.flat ? 0 : slope[a] * tilt;
          const Nx = -nx * sgn * tl, Nz = -nz * sgn * tl;
          const nl = 1 / Math.hypot(Nx, 1, Nz);
          const lit = Math.max(0, (Nx * lightL.x + lightL.y + Nz * lightL.z) * nl);
          const base = K.flat ? 0.3 : 0.12 + 0.9 * lit * lit;
          aI.setX(vi, f * base * (a === 0 || a === A - 1 ? 0 : 1) * 1.8);
          aU.setXYZ(vi, u, p.s / L, K.flat ? 1 : 0);
          vi++;
        }
      }
    }
    pos.needsUpdate = true; aI.needsUpdate = true; aU.needsUpdate = true;
    // --- 喫水線に沿う白波 ---
    {
      const lp = W.line.geometry.attributes.position, li = W.line.geometry.attributes.aI, lu = W.line.geometry.attributes.aU;
      const M = W.M, n = outline.length;
      let cxm = 0, czm = 0;
      for (const p of outline) { cxm += p.x; czm += p.z; }
      cxm /= n; czm /= n;
      const w = L * 0.009;
      let k = 0;
      for (let i = 0; i < M; i++) {
        const p = outline[i % n], pa = outline[(i + n - 1) % n], pb = outline[(i + 1) % n];
        // 外向き（輪郭の接線に直角で、中心から離れる向き）
        let tx = pb.x - pa.x, tz = pb.z - pa.z;
        const tlen = Math.hypot(tx, tz) || 1; tx /= tlen; tz /= tlen;
        let ox = tz, oz = -tx;
        if (ox * (p.x - cxm) + oz * (p.z - czm) < 0) { ox = -ox; oz = -oz; }
        // 進む向きの側（波を押しのける側）ほど高く・明るい。後ろの側は低い
        const facing = ox * dirL.x + oz * dirL.z;
        const pile = 0.25 + str * (0.55 + 0.9 * Math.max(0, facing) - 0.3 * Math.max(0, -facing));
        const h = ampH * 0.9 * str * Math.max(0, 0.25 + facing);
        for (let a = 0; a < 3; a++) {
          const u = a - 1; // -1 = 船体の側 / +1 = 外
          lp.setXYZ(k, p.x + ox * w * (u + 0.6), a === 1 ? h : 0, p.z + oz * w * (u + 0.6));
          const lit = a === 1 ? 1 : 0;
          li.setX(k, pile * lit * 0.5);
          lu.setXYZ(k, u * 0.9, i * 0.37, 2);
          k++;
        }
      }
      lp.needsUpdate = true; li.needsUpdate = true; lu.needsUpdate = true;
    }
    W.mat.uniforms.uTime.value = this._time;
  },

  _plumeRoot: null,
  _plumes: new Map(),   // スラスターID → { plume, thruster }
  _plumeThrusters: null,
  _time: 0,

  // 艦のスラスター構成が変わったら炎を作り直す
  _syncPlumes(ship) {
    if (this._plumeThrusters === ship.thrusters) return;
    this._plumeThrusters = ship.thrusters;
    for (const { plume } of this._plumes.values()) {
      this._plumeRoot.remove(plume.object);
      plume.dispose();
    }
    this._plumes.clear();
    if (typeof EnginePlumes === 'undefined') return;
    const fx = ship.fxScale || 1;
    let mainCount = 0;
    for (const t of ship.thrusters) if (t.kind === 'main') mainCount++;
    // v89: 姿勢スラスター・逆噴射は、粒を飛ばす代わりに、少し赤みのある白の細い噴煙（EnginePlumes.createJet）で描く
    const sizeFx = Math.pow(fx, 0.85);
    const rcsW = (fx > 1 ? sizeFx * 0.7 : 1) * this.LEGACY_SIZE_TO_M * 1.1;
    for (const t of ship.thrusters) {
      if (t.kind === 'main' || t.kind === 'gyro' || t.kind === 'field' || !EnginePlumes.createJet) continue;
      const jet = EnginePlumes.createJet();
      const isRetro = String(t.id).startsWith('retro');
      const w = isRetro ? (t.nozzleDiameter > 0 ? t.nozzleDiameter * 0.55 : rcsW * 1.6) : rcsW;
      const len = (isRetro ? 4.5 : 2.6) * fx * (isRetro && t.plumeScale > 0 ? t.plumeScale : 1);
      const dir = vecNormalize(t.direction);
      jet.object.position.set(t.position.x, t.position.y, t.position.z);
      jet.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dir.x, dir.y, dir.z));
      jet.object.scale.set(w, w, len);
      this._plumeRoot.add(jet.object);
      this._plumes.set(t.id, { plume: jet, thruster: t });
    }
    for (const t of ship.thrusters) {
      if (t.kind !== 'main') continue; // v85: 逆噴射は姿勢スラスターと同じ噴射で描く
      const plume = EnginePlumes.create(t.engineType, { twist: t.twist });
      // ノズルの直径（艦種プリセットは自作の艦の自動の直径と同じ決め方）
      const dia = t.nozzleDiameter > 0 ? t.nozzleDiameter : 0.9 * Math.pow(fx, 0.85) / Math.sqrt(Math.max(1, mainCount));
      const dir = vecNormalize(t.direction);
      plume.object.position.set(t.position.x, t.position.y, t.position.z);
      plume.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dir.x, dir.y, dir.z));
      plume.object.scale.setScalar(dia);
      this._plumeRoot.add(plume.object);
      this._plumes.set(t.id, { plume, thruster: t });
    }
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
        // 距離1のところで1mが何ピクセルになるか（update() で画面に合わせる）
        uPxPerUnit: { value: this._pxPerUnit },
      },
      vertexShader: `
        uniform float uPxPerUnit;
        attribute float psize;
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * (uPxPerUnit / -mvPosition.z);
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
          gl_FragColor = vec4(uColor * 1.6, min(1.0, vAlpha * edge * 1.6)); // v85: 濃く明るく
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
  update(dt, camera, renderer) {
    const ship = State.ship;
    if (!ship) return;

    // v84: 粒子の大きさ（m）を画面のピクセルに直す係数 = 描画の高さ / (2 tan(視野角/2))
    if (camera && renderer && camera.isPerspectiveCamera) {
      const h = renderer.domElement.height || window.innerHeight;
      this._pxPerUnit = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
      this._mainPool.material.uniforms.uPxPerUnit.value = this._pxPerUnit;
      this._rcsPool.material.uniforms.uPxPerUnit.value = this._pxPerUnit;
    }

    // 粒子は艦のローカル座標なので、描画オブジェクトを艦の位置・姿勢に置く
    for (const pool of [this._mainPool, this._rcsPool]) {
      pool.points.position.set(ship.position.x, ship.position.y, ship.position.z);
      pool.points.quaternion.set(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    }

    this._time += dt;
    this._dtLast = dt;
    this._syncPlumes(ship);
    this._updateBoundary(ship);
    this._plumeRoot.position.set(ship.position.x, ship.position.y, ship.position.z);
    this._plumeRoot.quaternion.set(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    const ratios = ship.fxOutputRatios || ship.thrusterOutputRatios;
    for (const [id, { plume }] of this._plumes) plume.update(ratios[id] ?? 0, this._time);

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
    let mainCount = 0, retroCount = 0;
    for (const t of ship.thrusters) {
      if (t.kind === 'main') mainCount++;
      else if (t.nozzleDiameter > 0) retroCount++;
    }
    const mainDensity = Math.min(1, 3 / Math.max(1, mainCount));
    const retroDensity = Math.min(1, 3 / Math.max(1, retroCount));
    const L = this.LEGACY_SIZE_TO_M;
    // v83: 粒子の大きさ（噴射の太さ）。大きな艦では艦の大きさほどには太くせず、
    // 主エンジンが複数あるときは1基あたりを細くする（ロケット級1基は従来どおり）
    const sizeFx = Math.pow(fx, 0.85);
    const mainSizeFx = sizeFx / Math.sqrt(Math.max(1, mainCount));
    const rcsSizeFx = fx > 1 ? sizeFx * 0.7 : 1;
    for (const t of ship.thrusters) {
      // v85: soft-glow で速度が頭打ちのときは見た目だけの出力（04-flight-physics.js _softGlowFx）
      const ratio = (ship.fxOutputRatios || ship.thrusterOutputRatios)[t.id] ?? 0;
      if (ratio <= 0.01 || t.kind === 'gyro' || t.kind === 'field') continue; // v87: 境界面の並進（field）も噴射なし
      // v85: 炎の形（27-engine-plumes.js）で描くエンジンは粒子を出さない
      if (this._plumes.has(t.id)) continue;

      const isMain = t.kind === 'main';
      // v84: ノズルの直径を持つもの（自作の艦の主エンジン・逆噴射）は、エンジンの噴射
      // として描き、太さ・長さを直径から決める
      // v85: 逆噴射は姿勢スラスターと同じ見た目（ノズルの直径は使わない）
      const dia = isMain && t.nozzleDiameter > 0 ? t.nozzleDiameter : 0;
      const isEngine = isMain || dia > 0;
      const isRetroEngine = !isMain && dia > 0;
      const pool = isEngine ? this._mainPool : this._rcsPool;
      const lenFx = fx * (t.plumeScale > 0 ? t.plumeScale : 1);

      // v83: 艦のローカル座標（ノズルの位置・噴射の向きをそのまま使う）
      const nozzle = t.position;
      const dir = vecNormalize(t.direction);
      // v84: 噴射口の円の中に散らして出す（ノズルの直径ぶんの太さで出る）
      let u1 = null, u2 = null;
      if (dia > 0) {
        u1 = vecNormalize(Math.abs(dir.y) < 0.9 ? vecCross(dir, { x: 0, y: 1, z: 0 }) : vecCross(dir, { x: 1, y: 0, z: 0 }));
        u2 = vecCross(dir, u1);
      }

      // 出力比に応じてスポーン数を可変（多いほど濃い噴射に見える）
      // v85: 姿勢スラスターは、1フレームに進む距離が粒の大きさより長くても粒が
      // とぎれとぎれ（点の列）に見えないよう、間が空かない数だけ出す
      const rcsGapFill = Math.min(16, Math.ceil((8 * fx * dt) / Math.max(1e-3, 0.5 * rcsSizeFx * L)));
      const spawnCount = isMain
        ? Math.round(ratio * 14 * mainDensity)
        : isRetroEngine ? Math.round(ratio * 10 * retroDensity) : Math.max(Math.round(ratio * 6), Math.round(rcsGapFill * Math.min(1, ratio * 3)));

      for (let i = 0; i < spawnCount; i++) {
        const p = this._acquireParticle(pool);
        if (!p) break;

        const spread = isEngine ? 0.35 : 0.5;  // 速度に掛けるので大きさの倍率は不要
        const jitterX = (Math.random() - 0.5) * spread;
        const jitterY = (Math.random() - 0.5) * spread;
        const jitterZ = (Math.random() - 0.5) * spread;

        p.active = true;
        p.x = nozzle.x;
        p.y = nozzle.y;
        p.z = nozzle.z;
        if (dia > 0) {
          const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * dia * 0.3;
          const ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
          p.x += u1.x * ca + u2.x * sa;
          p.y += u1.y * ca + u2.y * sa;
          p.z += u1.z * ca + u2.z * sa;
        }

        const baseSpeed = isEngine
          ? (12 + Math.random() * 8 + ratio * 10) * (isRetroEngine ? 0.6 : 1) * (dia > 0 ? lenFx : fx)
          : (6 + Math.random() * 4) * fx;

        p.vx = dir.x * baseSpeed + jitterX * baseSpeed * 0.3;
        p.vy = dir.y * baseSpeed + jitterY * baseSpeed * 0.3;
        p.vz = dir.z * baseSpeed + jitterZ * baseSpeed * 0.3;

        p.maxLife = isEngine
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
        // v84: 大きさは m。ノズルの直径があれば、全開で直径の約1.3倍の太さ
        p.size = dia > 0
          ? dia * (0.8 + ratio * 0.5) * (0.7 + Math.random() * 0.6)
          : isMain
            ? (2.2 + ratio * 2.4) * (0.7 + Math.random() * 0.6) * mainSizeFx * L
            : (1.0 + Math.random() * 0.6) * rcsSizeFx * L;
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
