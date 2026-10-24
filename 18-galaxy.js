// =============================================================
// 18-galaxy.js
// 銀河系（天の川銀河）と局所銀河群の3Dモデル（星図の大縮尺表示用）
//
// v77: 「銀河系も、可能なら現実通りに」という要望への対応。
// 銀河系は内側から見ることしかできないため、外から見た姿は観測データに
// 基づくモデル（推定図）になる。ここでは次の観測結果を使って星の分布を作る。
//   - 太陽と銀河中心の距離 R0 = 8.15 kpc、太陽の銀河面からの高さ 20.8 pc
//   - 渦巻腕: Reid et al. (2019, ApJ 885, 131) が大質量星形成領域の
//     年周視差から求めた対数らせんの当てはめ（腕ごとの屈曲点・ピッチ角・幅）。
//     観測されている方位角の範囲より外側は、同じピッチ角で延長して描く。
//   - 棒状構造: 長さ約5kpc、太陽-銀河中心の線から約27°傾いた棒
//   - 円盤: 動径方向のスケール長 2.6 kpc の指数関数円盤
// 座標: 銀河中心を原点、軸は太陽中心の銀河座標と同じ向き（x=太陽から銀河中心
// へ向かう方向, y=銀経90°, z=銀河北極）、単位kpc。
// =============================================================

const KPC_M = 3.0856775814913673e19;

const GalaxyModel = {
  R0_KPC: 8.15,
  Z_SUN_KPC: 0.0208,
  BAR_ANGLE_DEG: 27,

  // Reid et al. 2019 Table 2: [名前, β最小, β最大, β屈曲, R屈曲(kpc), ψ<(deg), ψ>(deg), 幅(kpc), 重み]
  ARMS: [
    ['3kpc', '3kpc腕', 15, 18, 15, 3.52, -4.2, -4.2, 0.18, 0.15],
    ['norma', 'じょうぎ座-外縁腕', 5, 54, 18, 4.46, -1.0, 19.5, 0.14, 0.7],
    ['scutum', 'たて座-ケンタウルス座腕', 0, 104, 23, 4.91, 14.1, 12.1, 0.23, 1.0],
    ['sagittarius', 'いて座-りゅうこつ座腕', 2, 97, 24, 6.04, 17.1, 1.0, 0.27, 0.8],
    ['local', 'オリオン腕（局所腕）', -8, 27, 9, 8.26, 11.4, 11.4, 0.31, 0.45],
    ['perseus', 'ペルセウス腕', -23, 115, 40, 8.87, 10.3, 8.7, 0.35, 1.0],
    ['outer', '外縁腕', -16, 71, 18, 12.24, 3.0, 9.4, 0.65, 0.5],
  ],

  group: null,
  _points: null,
  _glow: null,
  _localGroup: null,
  labels: [],

  // 腕の上の点（銀河中心からの位置, kpc）
  armRadius(arm, beta) {
    const [, , , , bk, Rk, psiLt, psiGt] = arm;
    const psi = (beta < bk ? psiLt : psiGt) * Math.PI / 180;
    return Rk * Math.exp(-((beta - bk) * Math.PI / 180) * Math.tan(psi));
  },

  armPoint(R, betaDeg) {
    const b = betaDeg * Math.PI / 180;
    return { x: -R * Math.cos(b), y: R * Math.sin(b) };
  },

  // 決定的な乱数（毎回同じ銀河の形にする）
  _rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  build(scene, pointCount) {
    const N = pointCount || 90000;
    const rand = this._rng(20260101);
    const gauss = () => {
      const u = Math.max(1e-9, rand()), v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const size = new Float32Array(N);
    let n = 0;
    const put = (x, y, z, c, s) => {
      if (n >= N) return;
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
      col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2];
      size[n] = s;
      n++;
    };
    const jitterColor = (c, k) => [c[0] * (1 + (rand() - 0.5) * k), c[1] * (1 + (rand() - 0.5) * k), c[2] * (1 + (rand() - 0.5) * k)];

    // 1) 古い星の円盤（指数関数円盤、スケール長2.6kpc、厚み約0.3kpc）
    const nDisk = Math.floor(N * 0.30);
    for (let i = 0; i < nDisk; i++) {
      const R = Math.min(17, -2.6 * Math.log(Math.max(1e-9, rand() * rand())));
      if (R < 1.0) { i--; continue; }
      const a = rand() * Math.PI * 2;
      const z = gauss() * 0.22 * (0.6 + R / 12);
      put(R * Math.cos(a), R * Math.sin(a), z, jitterColor([1.0, 0.86, 0.68], 0.25), 0.09 + rand() * 0.08);
    }

    // 2) 棒状構造とバルジ（黄色〜橙の古い星）
    const nBar = Math.floor(N * 0.15);
    const ba = this.BAR_ANGLE_DEG * Math.PI / 180;
    const ux = -Math.cos(ba), uy = Math.sin(ba); // 棒の長軸（太陽に近い側の端の向き）
    for (let i = 0; i < nBar; i++) {
      const bulge = rand() < 0.35;
      const a = gauss() * (bulge ? 0.7 : 1.7);
      const b = gauss() * (bulge ? 0.6 : 0.55);
      const c = gauss() * (bulge ? 0.45 : 0.28);
      put(a * ux - b * uy, a * uy + b * ux, c, jitterColor([1.0, 0.78, 0.5], 0.2), 0.12 + rand() * 0.1);
    }

    // 3) 渦巻腕（若い青白い星と、赤い電離水素領域）
    const armsTotal = this.ARMS.reduce((s, a) => s + a[9], 0);
    const nArm = N - n - Math.floor(N * 0.04);
    for (const arm of this.ARMS) {
      const count = Math.floor((nArm * arm[9]) / armsTotal);
      const [, , bMin, bMax, , , , , width] = arm;
      const extNeg = arm[0] === '3kpc' ? 15 : 70;
      const extPos = arm[0] === '3kpc' ? 15 : 110;
      for (let i = 0; i < count; i++) {
        const beta = bMin - extNeg + rand() * (bMax - bMin + extNeg + extPos);
        // 観測範囲の外は少しずつ薄く
        const outside = beta < bMin ? (bMin - beta) / extNeg : beta > bMax ? (beta - bMax) / extPos : 0;
        if (rand() < outside * 0.6) { i--; continue; }
        const R = this.armRadius(arm, beta);
        if (R < 2.2 || R > 19) continue;
        const p = this.armPoint(R, beta);
        const w = width * (1.6 + R * 0.08);
        const ox = gauss() * w, oy = gauss() * w;
        const z = gauss() * 0.07;
        const young = rand() < 0.75;
        const c = young ? jitterColor([1.0, 1.15, 1.45], 0.25) : jitterColor([1.0, 0.92, 0.82], 0.2);
        put(p.x + ox, p.y + oy, z, c, young ? 0.07 + rand() * 0.07 : 0.08);
      }
    }
    // 電離水素領域（腕の上のピンクの光の塊）
    while (n < N) {
      const arm = this.ARMS[1 + Math.floor(rand() * (this.ARMS.length - 1))];
      const beta = arm[2] - 40 + rand() * (arm[3] - arm[2] + 120);
      const R = this.armRadius(arm, beta);
      if (R < 2.5 || R > 17) continue;
      const p = this.armPoint(R, beta);
      put(p.x + gauss() * arm[8], p.y + gauss() * arm[8], gauss() * 0.04, jitterColor([1.7, 0.7, 1.0], 0.2), 0.12 + rand() * 0.16);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPxPerRad: { value: 600 },
        uUnitM: { value: KPC_M },
        uOpacity: { value: 1 },
        // 点の数が少ないとき（スマホ向け設定など）は1点あたりを明るくして全体の明るさを保つ
        uPointGain: { value: 0.07 * Math.pow(90000 / N, 0.85) },
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uPxPerRad;
        uniform float uUnitM;
        uniform float uOpacity;
        uniform float uPointGain;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(-mv.z, 1.0);
          float px = aSize * uUnitM / dist * uPxPerRad;
          float s = clamp(px, 1.5, 48.0);
          // 小さすぎる点は面積比で暗く（全体の明るさを保つ）
          // 数万個の点を加算合成で重ねるので、1点あたりはごく淡くする
          vAlpha = uOpacity * min(1.0, (px * px) / (s * s)) * uPointGain;
          vColor = aColor;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = mv.z < 0.0 ? s : 0.0;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float g = exp(-dot(d, d) * 18.0);
          gl_FragColor = vec4(vColor * g * vAlpha, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;

    // 銀河中心のぼんやりした光（バルジ）
    const glowMat = new THREE.SpriteMaterial({
      map: this._makeGlowTexture(),
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.set(9, 9, 1);

    const group = new THREE.Group();
    group.add(pts);
    group.add(glow);
    // 銀河座標（three並び: x, z, -y）へ
    const m = Astro.threeFromGalMatrix();
    const q = Astro.quatFromMat3(m);
    group.quaternion.set(q.x, q.y, q.z, q.w);
    group.scale.setScalar(KPC_M);
    group.visible = false;
    scene.add(group);
    this.group = group;
    this._points = pts;
    this._glow = glow;

    // 銀河中心の宇宙座標（太陽中心, m）
    const gc = Astro.mat3MulVec(m, { x: this.R0_KPC, y: 0, z: -this.Z_SUN_KPC });
    this.centerU = { x: gc.x * KPC_M, y: gc.y * KPC_M, z: gc.z * KPC_M };

    this._buildLabels();
    this._buildLocalGroup(scene);
  },

  _makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.2, 'rgba(255,255,255,0.55)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.15)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  },

  // 星図に出すラベル（銀河中心を原点とした kpc 座標）
  _buildLabels() {
    const L = [];
    L.push({ id: 'gc', ja: '銀河中心（いて座A*）', p: { x: 0, y: 0, z: 0 } });
    L.push({ id: 'sun', ja: '太陽系', p: { x: -this.R0_KPC, y: 0, z: this.Z_SUN_KPC }, isSun: true });
    const labelBeta = { scutum: 60, sagittarius: 60, local: -2, perseus: 75, norma: 45, outer: 40 };
    for (const arm of this.ARMS) {
      const b = labelBeta[arm[0]];
      if (b === undefined) continue;
      const R = this.armRadius(arm, b);
      const p = this.armPoint(R, b);
      L.push({ id: arm[0], ja: arm[1], p: { x: p.x, y: p.y, z: 0 }, isArm: true });
    }
    this.labels = L;
  },

  // -----------------------------------------------------------
  // 局所銀河群（大小マゼラン雲・アンドロメダ銀河・さんかく座銀河）
  //   [ID, 名前, 銀経, 銀緯, 距離kpc, 半径kpc, 種類, 傾き, 位置角]
  // -----------------------------------------------------------
  LOCAL_GROUP: [
    ['lmc', '大マゼラン雲', 280.47, -32.89, 49.97, 4.5, 'irr', 0, 0],
    ['smc', '小マゼラン雲', 302.80, -44.30, 62.1, 2.8, 'irr', 0, 0],
    ['m31', 'アンドロメダ銀河（M31）', 121.17, -21.57, 765, 30, 'spiral', 77, 38],
    ['m33', 'さんかく座銀河（M33）', 133.61, -31.33, 840, 9, 'spiral', 55, 23],
  ],

  _buildLocalGroup(scene) {
    const rand = this._rng(7);
    const gauss = () => {
      const u = Math.max(1e-9, rand()), v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    this.localGroup = [];
    const m = Astro.threeFromGalMatrix();
    for (const [id, ja, l, b, dKpc, rKpc, kind, incl, pa] of this.LOCAL_GROUP) {
      const N = kind === 'spiral' ? 9000 : 3500;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const size = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let x, y, z, c;
        if (kind === 'spiral') {
          // 2本腕の渦巻銀河（円盤面内）
          const r = Math.min(1.3, -0.3 * Math.log(Math.max(1e-6, rand() * rand())));
          const arm = rand() < 0.5 ? 0 : Math.PI;
          const theta = arm + Math.log(Math.max(r, 0.02)) / Math.tan(0.25) + gauss() * 0.35;
          x = r * Math.cos(theta); y = r * Math.sin(theta); z = gauss() * 0.02;
          c = r < 0.18 ? [1.0, 0.82, 0.55] : (rand() < 0.6 ? [0.75, 0.83, 1.0] : [1.0, 0.9, 0.78]);
        } else {
          x = gauss() * 0.45; y = gauss() * 0.3; z = gauss() * 0.3;
          c = rand() < 0.7 ? [0.8, 0.85, 1.0] : [1.0, 0.6, 0.75];
        }
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
        size[i] = 0.015 + rand() * 0.02;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mat = this._points.material.clone();
      mat.uniforms.uUnitM = { value: rKpc * KPC_M };
      mat.uniforms.uPointGain = { value: kind === 'spiral' ? 0.12 : 0.18 };
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      const group = new THREE.Group();
      group.add(pts);
      // 向き: 渦巻銀河は視線方向に対して傾き(incl)・位置角(pa)で回す（見た目の近似）
      const dir = Astro.galToThree(l, b);
      const center = { x: dir.x * dKpc * KPC_M, y: dir.y * dKpc * KPC_M, z: dir.z * KPC_M * dKpc };
      const look = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-dir.x, -dir.y, -dir.z), new THREE.Vector3(0, 1, 0));
      const qLook = new THREE.Quaternion().setFromRotationMatrix(look);
      const qTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler((incl * Math.PI) / 180, 0, (pa * Math.PI) / 180, 'ZXY'));
      group.quaternion.copy(qLook.multiply(qTilt));
      group.scale.setScalar(rKpc * KPC_M);
      group.visible = false;
      scene.add(group);
      this.localGroup.push({ id, ja, group, center, radiusM: rKpc * KPC_M, distM: dKpc * KPC_M });
    }
  },

  // -----------------------------------------------------------
  // 毎フレーム: カメラの宇宙座標 camU（太陽中心, m）から見た位置に置く
  // -----------------------------------------------------------
  update(camU, pxPerRad, visibility) {
    if (!this.group) return;
    const vis = visibility > 0.001;
    this.group.visible = vis;
    // 初めて表示するときは数フレームかけて点を増やす（1フレームに全点を
    // まとめて描くと、端末によってはGPUがタイムアウトすることがあるため）
    const geo = this._points.geometry;
    if (!vis) this._revealed = 0;
    else if ((this._revealed || 0) < geo.attributes.position.count) {
      this._revealed = Math.min(geo.attributes.position.count, (this._revealed || 0) + 12000);
      geo.setDrawRange(0, this._revealed);
    }
    if (vis) {
      this.group.position.set(this.centerU.x - camU.x, this.centerU.y - camU.y, this.centerU.z - camU.z);
      const u = this._points.material.uniforms;
      u.uPxPerRad.value = pxPerRad;
      u.uOpacity.value = visibility;
      this._glow.material.opacity = 0.5 * visibility;
    }
    for (const g of this.localGroup) {
      g.group.visible = vis;
      if (!vis) continue;
      g.group.position.set(g.center.x - camU.x, g.center.y - camU.y, g.center.z - camU.z);
      const u = g.group.children[0].material.uniforms;
      u.uPxPerRad.value = pxPerRad;
      u.uOpacity.value = visibility;
    }
  },

  // ラベルの宇宙座標（太陽中心, m）
  labelUniverse(label) {
    const m = Astro.threeFromGalMatrix();
    const p = Astro.mat3MulVec(m, { x: label.p.x + this.R0_KPC, y: label.p.y, z: label.p.z - this.Z_SUN_KPC });
    return { x: p.x * KPC_M, y: p.y * KPC_M, z: p.z * KPC_M };
  },
};
