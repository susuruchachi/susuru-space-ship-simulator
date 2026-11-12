// =============================================================
// 30-planetfall.js
// v89: 大気圏への突入と、着陸・着水
//
// 岩石の天体（水星・金星・地球・月・火星）と、系外のハビタブルゾーンの惑星は、
// これまでの「これ以上は降下できません」の高さより下へ降りられる。
//
//   - 大気: 高さとともに指数で薄くなる空気。空気に対する速さの2乗に比例する抵抗がかかる
//     （空気は地表と一緒に自転している）。空は大気の色になり、昼は星が見えなくなる。遠くは霞む。
//   - 地表: 艦の真下に、その天体の半径の丸みを持った地面・海面を描く（天体の画像のその場所の色）。
//     画像のその場所が海の色なら海（着水）、そうでなければ陸（着陸）。
//   - 接地: 地表の高さより下へは行かない。地表は自転しているので、止まると地表と一緒に動く。
//     陸ではすぐ止まり、海では滑りながら止まって浮く。接地中は艦がゆっくり水平になる。
//
// 座標: 艦の位置・速度はこれまでどおり天体と一緒に動く（自転しない）フレームの座標。
// 地表の速度（自転）をそのフレームで求めて、それに対する速さで抵抗・接地を計算する。
// =============================================================

const Planetfall = {
  LANDABLE_IDS: ['mercury', 'venus', 'earth', 'moon', 'mars'],
  // 地表の空気の濃さ [kg/m³] と、濃さが 1/e になる高さ [m]
  AIR: {
    venus: { rho0: 65, H: 15900 },
    earth: { rho0: 1.2, H: 8500 },
    mars: { rho0: 0.02, H: 11100 },
    _exo: { rho0: 1.2, H: 8500 },
  },
  active: null, // { body, alt, up, vVert, vHoriz, state, sea, rho }
  _scene: null,

  isLandable(b) {
    if (!b || b.type === 'star' || b.type === 'station') return false;
    return this.LANDABLE_IDS.includes(b.id) || !!(b.hz && b.exoKind !== 'mini') || !!(b.earthLike && b.earthLike.proc);
  },
  _air(b) {
    if (!b.atmo) return null;
    return this.AIR[b.id] || (this.isLandable(b) ? this.AIR._exo : null);
  },
  // 大気の上の端（これより上は空気なし）
  atmoTop(b) { const a = this._air(b); return a ? a.H * 14 : 0; },

  init(scene) {
    this._scene = scene;
    const el = document.createElement('div');
    el.className = 'planetfall-hud';
    el.style.display = 'none';
    document.body.appendChild(el);
    this._hud = el;
  },

  // ---------------------------------------------------------
  // 天体の自転の角速度（宇宙座標 [rad/s]）。向きの行列の変化から求める
  // ---------------------------------------------------------
  _omega(b) {
    const jd = SimClock.jd;
    const st = b._pfRot;
    if (st && Math.abs(jd - st.jd) < 0.02) return st.w; // 30分ほどは同じ値を使う
    // 1分後の向きとの差から求める（向きの行列を一時的に1分後にして、すぐ戻す）
    const w = { x: 0, y: 0, z: 0 };
    try {
      const A0 = b.rotMat.slice();
      const dtS = 60;
      SolarSystem._updateOrientation(b, jd + dtS / 86400);
      const A = b.rotMat.slice();
      SolarSystem._updateOrientation(b, jd);
      // R_後 · R_今^T の反対称の成分 = 回した角度（小さい角度）
      const M = (i, j) => A[i * 3] * A0[j * 3] + A[i * 3 + 1] * A0[j * 3 + 1] + A[i * 3 + 2] * A0[j * 3 + 2];
      w.x = (M(2, 1) - M(1, 2)) / 2 / dtS; w.y = (M(0, 2) - M(2, 0)) / 2 / dtS; w.z = (M(1, 0) - M(0, 1)) / 2 / dtS;
    } catch (e) { /* 向きが求められない天体は、自転なしとして扱う */ }
    b._pfRot = { jd, w };
    return w;
  },

  // 海か陸か: 天体の画像の、艦の真下の色で決める（青が勝っていれば海）。画像が無ければ陸
  _surfaceAt(b, dirU) {
    const info = { sea: false, color: [b.color[0], b.color[1], b.color[2]] };
    const view = typeof Universe !== 'undefined' && Universe._views ? Universe._views[b.id] : null;
    const tex = view && view.mat && view.mat.uniforms && view.mat.uniforms.uMap ? view.mat.uniforms.uMap.value : null;
    const img = tex && tex.image;
    if (!img || !(img.width > 0)) return info;
    try {
      if (!b._pfImg || b._pfImg.src !== img) {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 256;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, c.width, c.height);
        b._pfImg = { src: img, data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
      }
      // 天体に固定した向き（three並び: +Y が北極）
      const R = b.rotMat;
      const x = R[0] * dirU.x + R[3] * dirU.y + R[6] * dirU.z;
      const y = R[1] * dirU.x + R[4] * dirU.y + R[7] * dirU.z;
      const z = R[2] * dirU.x + R[5] * dirU.y + R[8] * dirU.z;
      let u = Math.atan2(z, -x) / (Math.PI * 2);
      if (u < 0) u += 1;
      const v = Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI; // 0 = 北極
      const I = b._pfImg;
      const px = Math.min(I.w - 1, Math.floor(u * I.w)), py = Math.min(I.h - 1, Math.floor(v * I.h));
      const k = (py * I.w + px) * 4;
      const r = I.data[k] / 255, gg = I.data[k + 1] / 255, bl = I.data[k + 2] / 255;
      info.color = [r, gg, bl];
      info.sea = !!b.earthLike && bl > r * 1.25 && bl > gg * 1.02 && r < 0.45;
    } catch (e) { /* 画像が読めない（別のサイトの画像など）ときは陸として扱う */ }
    return info;
  },

  // ---------------------------------------------------------
  // 毎フレーム（艦の物理の更新のあと、Navigation.postUpdate の前）
  // ---------------------------------------------------------
  update(dt) {
    const ship = State.ship;
    this.active = null;
    if (!ship || typeof Navigation === 'undefined' || !Navigation.frame || Navigation.isWarping()) { this._setVisuals(null); return; }
    const u = Navigation.shipUniverse();
    // いちばん近い、降りられる天体
    let body = null, bd = Infinity;
    for (const b of SolarSystem.bodies) {
      if (!this.isLandable(b)) continue;
      const d = Math.hypot(u.x - b.pos.x, u.y - b.pos.y, u.z - b.pos.z) - b.meanRadiusM;
      if (d < bd) { bd = d; body = b; }
    }
    if (!body) { this._setVisuals(null); return; }
    const top = Math.max(this.atmoTop(body), 60e3);
    if (bd > top * 2.5) { this._setVisuals(null); return; }

    const R = body.meanRadiusM;
    const rx = u.x - body.pos.x, ry = u.y - body.pos.y, rz = u.z - body.pos.z;
    const r = Math.hypot(rx, ry, rz) || 1;
    const upU = { x: rx / r, y: ry / r, z: rz / r };
    const F = Navigation.frame;
    const up = Astro.mat3MulVec(F.rotT, upU); // フレームの座標での「上」
    // 地表（と空気）の速度: 自転（フレームの座標）。フレームは天体と一緒に動くので、自転の分だけ
    const w = this._omega(body);
    const vsU = { x: w.y * rz - w.z * ry, y: w.z * rx - w.x * rz, z: w.x * ry - w.y * rx };
    let vs = Astro.mat3MulVec(F.rotT, vsU);
    // フレームがその天体のものでないとき（太陽のフレームなど）は、天体の速度も足す
    if (F.bodyId !== body.id && Navigation.bodyVelocity) {
      const bv = Navigation.bodyVelocity(body.id), fv = Navigation.bodyVelocity(F.bodyId);
      const d = Astro.mat3MulVec(F.rotT, { x: bv.x - fv.x, y: bv.y - fv.y, z: bv.z - fv.z });
      vs = { x: vs.x + d.x, y: vs.y + d.y, z: vs.z + d.z };
    }
    const v = ship.velocity;
    let rel = { x: v.x - vs.x, y: v.y - vs.y, z: v.z - vs.z };
    const size = (typeof CameraSystem !== 'undefined' ? (CameraSystem._shipScale || 1) : 1) * 8;
    const h0 = Math.max(1, size * 0.08); // 艦の重心から底までのおよその高さ
    let alt = r - R;

    // --- 大気の抵抗 ---
    const air = this._air(body);
    let rho = 0;
    if (air && alt < air.H * 14) {
      rho = air.rho0 * Math.exp(-Math.max(0, alt) / air.H);
      const sp = Math.hypot(rel.x, rel.y, rel.z);
      if (sp > 0.01) {
        // 抵抗の強さ: 0.5·ρ·v²·Cd·A / m。A は艦の大きさから（細長い艦として）
        const A = size * size * 0.06, Cd = 0.9;
        const k = (0.5 * rho * Cd * A) / Math.max(1, ship.mass || 1e5); // [1/m]
        const f = 1 / (1 + k * sp * dt); // 速さ v' = v / (1 + k v dt)（行き過ぎない形）
        rel = { x: rel.x * f, y: rel.y * f, z: rel.z * f };
        ship.velocity = { x: vs.x + rel.x, y: vs.y + rel.y, z: vs.z + rel.z };
      }
    }

    // --- 接地 ---
    const surf = this._surfaceAt(body, upU);
    let state = alt < top ? (rho > 1e-6 ? '大気圏内' : '低高度') : '接近中';
    const vVert = rel.x * up.x + rel.y * up.y + rel.z * up.z;
    let contact = false;
    if (alt <= h0) {
      contact = true;
      // 地表より下へは行かない
      const push = h0 - alt;
      ship.position.x += up.x * push; ship.position.y += up.y * push; ship.position.z += up.z * push;
      alt = h0;
      let vn = vVert;
      const hard = vn < -40;
      if (vn < 0) { rel.x -= up.x * vn; rel.y -= up.y * vn; rel.z -= up.z * vn; vn = 0; }
      // 地面の摩擦（陸はすぐ止まる・海は滑りながら止まる）
      const tau = surf.sea ? 3.5 : 0.8;
      const f = Math.exp(-dt / tau);
      const hx = rel.x - up.x * vn, hy = rel.y - up.y * vn, hz = rel.z - up.z * vn;
      rel = { x: hx * f + up.x * vn, y: hy * f + up.y * vn, z: hz * f + up.z * vn };
      ship.velocity = { x: vs.x + rel.x, y: vs.y + rel.y, z: vs.z + rel.z };
      const sp = Math.hypot(rel.x, rel.y, rel.z);
      state = sp < 1.5 ? (surf.sea ? '着水（浮いています）' : '着陸') : (surf.sea ? '水面を滑走中' : '地面を滑走中');
      if (hard && performance.now() - (this._hardT || 0) > 3000) {
        this._hardT = performance.now();
        this._flash = `${surf.sea ? '水面' : '地面'}に激しくぶつかりました（降下 ${Math.round(-vVert)} m/s）`;
      } else if (!this._wasContact) this._flash = surf.sea ? `${body.ja}に着水しました` : `${body.ja}に着陸しました`;
      // 艦を水平に: 艦の上を地表の上へゆっくり合わせ、回転を止める
      this._level(ship, up, dt, surf.sea ? 1.6 : 0.7);
      if (ship.boundaryPoint) ship.boundaryPoint = { ...ship.position };
    }
    this._wasContact = contact;
    const vH = Math.hypot(rel.x - up.x * vVert, rel.y - up.y * vVert, rel.z - up.z * vVert);
    this.active = { body, alt, up, upU, vVert: contact ? 0 : vVert, vHoriz: vH, state, sea: surf.sea, color: surf.color, rho, air, contact, top, h0 };
    this._setVisuals(this.active);
  },

  // 艦の上（+Y）を up へ合わせる（tau 秒で）。角速度も弱める
  _level(ship, up, dt, tau) {
    const q = new THREE.Quaternion(ship.quaternion.x, ship.quaternion.y, ship.quaternion.z, ship.quaternion.w);
    const cur = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const tgt = new THREE.Vector3(up.x, up.y, up.z);
    const dq = new THREE.Quaternion().setFromUnitVectors(cur, tgt);
    const k = 1 - Math.exp(-dt / tau);
    const step = new THREE.Quaternion().slerp(dq, k);
    q.premultiply(step).normalize();
    ship.quaternion = { x: q.x, y: q.y, z: q.z, w: q.w };
    if (ship.boundaryQuat) ship.boundaryQuat = { ...ship.quaternion };
    const f = Math.exp(-dt / 0.6);
    if (ship.angularVelocity) { ship.angularVelocity.x *= f; ship.angularVelocity.z *= f; ship.angularVelocity.y *= Math.exp(-dt / 2); }
  },

  // ---------------------------------------------------------
  // 見た目: 空・霞・地面／海面
  // ---------------------------------------------------------
  _ensureVisuals() {
    if (this._sky || !this._scene) return;
    // 空: カメラを囲む大きな球（内側）。大気の色で、濃さに応じて星を隠す
    this._sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uUp: { value: new THREE.Vector3(0, 1, 0) }, uOpacity: { value: 0 }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunAng: { value: 0.0047 }, uPix: { value: 0.001 }, uSunCol: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 uColor; uniform vec3 uHorizon; uniform vec3 uUp; uniform vec3 uSun; uniform float uOpacity; uniform float uSunAng; uniform float uPix; uniform vec3 uSunCol; varying vec3 vDir;
void main() { vec3 d = normalize(vDir); float h = dot(d, uUp);
  vec3 c = mix(uHorizon, uColor, smoothstep(-0.05, 0.55, h));
  float cs = dot(d, uSun);
  float s = max(0.0, cs); c += uSunCol * vec3(1.0, 0.9, 0.7) * pow(s, 48.0) * 0.35;
  // 地平線より下も同じ色で埋める（地面の向こうの霞）
  float a = uOpacity * (0.75 + 0.25 * smoothstep(0.6, -0.1, h));
  // v89: 恒星そのもの（円盤）と、まわりのにじみ。空が宇宙側の恒星を覆って灰色の円盤に見えてしまうので、空の側で明るく描く
  float ang = acos(clamp(cs, -1.0, 1.0));
  float k = smoothstep(0.02, 0.25, uOpacity);
  float e = max(uPix * 0.75, uSunAng * 0.06);
  float disc = (1.0 - smoothstep(uSunAng - e, uSunAng + e, ang)) * k;
  float halo = (exp(-ang / (uSunAng * 2.5)) * 0.9 + exp(-ang / (uSunAng * 9.0)) * 0.35) * k;
  c += uSunCol * halo;
  c = mix(c, mix(uSunCol, vec3(1.0), 0.6) * 1.15, disc);
  a = max(a, max(disc, min(1.0, halo * 0.9)));
  gl_FragColor = vec4(c, a); }`,
      // 艦・地面より先に描く（不透明の組に入れて、合成だけ自分で指定する。透明の組に入れると艦の上に重なってしまう）
      side: THREE.BackSide, transparent: false, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this._sky.frustumCulled = false;
    this._sky.renderOrder = -10;
    this._sky.visible = false;
    this._scene.add(this._sky);
    // 地面・海面: 艦の真下を中心にした、天体の丸みを持つ円盤（地平線まで。遠くは霞の色へ）
    const geo = new THREE.RingGeometry(0.0001, 1, 64, 28);
    geo.rotateX(-Math.PI / 2);
    this._ground = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: {
        uD: { value: 1000 }, uR: { value: 6e6 }, uColor: { value: new THREE.Color() }, uFog: { value: new THREE.Color() }, uFogK: { value: 0 },
        uSea: { value: 0 }, uTime: { value: 0 }, uOff: { value: new THREE.Vector2() }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uLight: { value: 1 }, uCam: { value: new THREE.Vector3() },
      },
      vertexShader: `uniform float uD; uniform float uR; varying vec3 vP; varying vec3 vW;
void main() { float rr = position.x * position.x + position.z * position.z; // 外ほど細かさを落とす（中心が細かい）
  float s = sqrt(rr); vec2 xz = position.xz * s * uD; float d2 = dot(xz, xz);
  vec3 p = vec3(xz.x, -d2 / (2.0 * uR), xz.y); vP = p; vec4 wp = modelMatrix * vec4(p, 1.0); vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform vec3 uColor; uniform vec3 uFog; uniform float uFogK; uniform float uSea; uniform float uTime; uniform vec2 uOff; uniform vec3 uSun; uniform float uLight; uniform vec3 uCam; uniform float uD;
varying vec3 vP; varying vec3 vW;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
void main() {
  vec2 g = vP.xz + uOff; // 地表に固定した座標 [m]
  float dist = length(vW - uCam);
  vec3 c;
  if (uSea > 0.5) {
    // 海: 波の濃淡と、太陽の照り返し
    float w = noise(g * 0.02 + uTime * 0.25) * 0.5 + noise(g * 0.11 - uTime * 0.6) * 0.3 + noise(g * 0.0018) * 0.4;
    float near = exp(-dist / 900.0);
    c = uColor * (0.62 + 0.3 * w * (0.4 + 0.6 * near)) + vec3(0.02, 0.04, 0.06);
    vec3 n = normalize(vec3((noise(g * 0.05 + uTime * 0.4) - 0.5) * 0.5, 1.0, (noise(g * 0.05 - uTime * 0.3 + 7.0) - 0.5) * 0.5));
    vec3 v = normalize(uCam - vW); vec3 hh = normalize(v + uSun);
    c += vec3(1.0, 0.95, 0.85) * pow(max(0.0, dot(n, hh)), 90.0) * 0.8 * uLight;
  } else {
    // 陸: 大きな模様と細かなざらつき
    float a = noise(g * 0.0006) * 0.55 + noise(g * 0.004) * 0.3 + noise(g * 0.03) * 0.15;
    float b = noise(g * 0.25) * exp(-dist / 400.0);
    c = uColor * (0.62 + 0.55 * a) * (0.92 + 0.16 * b);
  }
  c *= 0.12 + 0.88 * uLight;
  float fog = 1.0 - exp(-dist * uFogK);
  // 地平線の近く（円盤の端）は霞の色へ
  float edge = smoothstep(0.75, 1.0, length(vP.xz) / uD);
  gl_FragColor = vec4(mix(c, uFog, max(fog, edge * step(0.000001, uFogK))), 1.0); }`,
    }));
    this._ground.frustumCulled = false;
    this._ground.renderOrder = -5;
    this._ground.visible = false;
    this._scene.add(this._ground);
  },

  _setVisuals(a) {
    if (!a) {
      if (this._sky) this._sky.visible = false;
      if (this._ground) this._ground.visible = false;
      if (this._hud) this._hud.style.display = 'none';
      this._vis = null;
      return;
    }
    this._ensureVisuals();
    this._vis = a;
  },

  // 描く直前（カメラが決まったあと）
  preRender(cam, dt) {
    const a = this._vis;
    const ship = State.ship;
    if (!a || !ship || !this._sky) return;
    const b = a.body;
    const up = new THREE.Vector3(a.up.x, a.up.y, a.up.z);
    // 太陽（その天体を照らす恒星）の向き（フレームの座標）と、昼の明るさ
    const star = SolarSystem.lightOf ? SolarSystem.lightOf(b) : SolarSystem.byId.sun;
    const u = Navigation.shipUniverse();
    const sd = Astro.mat3MulVec(Navigation.frame.rotT, { x: star.pos.x - u.x, y: star.pos.y - u.y, z: star.pos.z - u.z });
    const sun = new THREE.Vector3(sd.x, sd.y, sd.z).normalize();
    const sunH = sun.dot(up);
    const day = Math.max(0, Math.min(1, (sunH + 0.12) / 0.3)); // 日の出・日の入りでなめらかに
    // 空の濃さ: 頭の上の空気の量（地表で1）
    const thick = a.air ? Math.min(1, a.rho / a.air.rho0) : 0;
    const ac = b.atmo ? b.atmo.color : [0, 0, 0];
    const skyCol = new THREE.Color(ac[0], ac[1], ac[2]).multiplyScalar(0.25 + 0.75 * day);
    const horizon = new THREE.Color(ac[0], ac[1], ac[2]).lerp(new THREE.Color(1, 1, 1), 0.45).multiplyScalar(0.12 + 0.88 * day);
    // 夕焼け: 太陽が低いとき、地平線を赤く
    const dusk = Math.max(0, 1 - Math.abs(sunH) / 0.25) * day;
    horizon.lerp(new THREE.Color(1.0, 0.5, 0.25), dusk * 0.5);
    const skyOpacity = Math.min(0.98, Math.pow(thick, 0.35) * (0.25 + 0.75 * day) + Math.pow(thick, 0.6) * 0.1);
    const su = this._sky.material.uniforms;
    this._sky.visible = skyOpacity > 0.004;
    this._sky.position.copy(cam.position);
    this._sky.scale.setScalar(Math.min(cam.far * 0.9, 80000));
    su.uColor.value.copy(skyCol); su.uHorizon.value.copy(horizon); su.uUp.value.copy(up); su.uOpacity.value = skyOpacity; su.uSun.value.copy(sun);
    // 恒星の見かけの半径・色（低いほど赤く）、画面の1ピクセルの角度（円盤のふちをなめらかに）
    su.uSunAng.value = Math.max(1e-4, Math.atan((star.meanRadiusM || 6.957e8) / Math.max(1, Math.hypot(sd.x, sd.y, sd.z))));
    su.uPix.value = (((cam.fov || 60) * Math.PI) / 180) / Math.max(1, (typeof renderer !== 'undefined' && renderer ? renderer.domElement.clientHeight : window.innerHeight));
    {
      const sc = star.id === 'sun' || !star.color ? [1, 0.97, 0.9] : star.color;
      const cm = Math.max(sc[0], sc[1], sc[2]) || 1;
      const low = Math.max(0, 1 - Math.max(0, sunH) / 0.3);
      su.uSunCol.value.setRGB(sc[0] / cm, sc[1] / cm, sc[2] / cm).lerp(new THREE.Color(1.0, 0.45, 0.18), low * 0.75);
    }

    // 地面・海面: 高さ 150 km より下で出す。大きさは地平線まで（カメラの見える距離まで）
    const g = this._ground;
    const showGround = a.alt < 150e3;
    g.visible = showGround;
    if (showGround) {
      const R = b.meanRadiusM;
      const camAlt = Math.max(2, a.alt + new THREE.Vector3(cam.position.x - ship.position.x, cam.position.y - ship.position.y, cam.position.z - ship.position.z).dot(up));
      const D = Math.min(Math.sqrt(2 * R * camAlt) * 1.05 + 200, cam.far * 0.92);
      // 円盤の中心: 艦の真下の地表の点
      const base = new THREE.Vector3(ship.position.x, ship.position.y, ship.position.z).addScaledVector(up, -(a.alt));
      g.position.copy(base);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      const gu = g.material.uniforms;
      gu.uD.value = D; gu.uR.value = R;
      const c = a.color;
      const col = a.sea ? new THREE.Color(Math.min(c[0], 0.2) * 0.6, Math.min(c[1], 0.45) * 0.75, Math.max(c[2], 0.35) * 0.85) : new THREE.Color(c[0], c[1], c[2]);
      gu.uColor.value.copy(col);
      gu.uSea.value = a.sea ? 1 : 0;
      gu.uTime.value = (gu.uTime.value + (dt || 0.016)) % 10000;
      gu.uSun.value.copy(sun);
      gu.uLight.value = b.atmo ? day : Math.max(0, Math.min(1, sunH * 3 + 0.1));
      gu.uCam.value.copy(cam.position);
      gu.uFog.value.copy(horizon);
      // 霞: 空気が濃いほど近くから霞む（地球の地表で見通し約 60 km）
      gu.uFogK.value = a.air ? (thick * (a.air.rho0 / 1.2)) / 22000 : 0;
      // 地表に固定した模様: 艦が動いた分だけずらす（地表に対する水平の動き）
      const st = this._off || (this._off = { x: 0, z: 0, body: b.id });
      if (st.body !== b.id) { st.x = 0; st.z = 0; st.body = b.id; }
      const q = g.quaternion.clone().invert();
      if (this._lastRel) {
        // 地表に対して動いた量（フレームの座標）→ 円盤の座標
        const d = new THREE.Vector3(this._lastRel.x, this._lastRel.y, this._lastRel.z).applyQuaternion(q);
        st.x += d.x; st.z += d.z;
      }
      gu.uOff.value.set(st.x % 100000, st.z % 100000);
    }
    this._lastRel = null;

    // 表示
    const fmt = (m) => (Math.abs(m) >= 10000 ? `${(m / 1000).toFixed(1)} km` : Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
    const h = this._hud;
    h.style.display = '';
    const altShown = Math.max(0, a.alt - a.h0);
    let t = `${b.ja}・高度 ${fmt(altShown)}・${a.vVert < -0.5 ? `降下 ${fmt(-a.vVert)}/s` : a.vVert > 0.5 ? `上昇 ${fmt(a.vVert)}/s` : '上下 0'}・対地 ${fmt(a.vHoriz)}/s・${a.state}`;
    if (!a.contact && a.alt < 30e3) t += `（下は${a.sea ? '海' : '陸'}）`;
    if (this._flash) { this._flashText = this._flash; this._flashUntil = performance.now() + 3500; this._flash = null; }
    if (this._flashText && performance.now() < this._flashUntil) t = `${this._flashText}　${t}`;
    if (h.textContent !== t) h.textContent = t;
    h.classList.toggle('contact', !!a.contact);
  },

  // 地表に対して動いた量を覚える（模様を地表に固定するため。update のあとに呼ぶ）
  noteMotion(dt) {
    const a = this.active;
    const ship = State.ship;
    if (!a || !ship) { this._lastRel = null; return; }
    // update で求めた「地表に対する速度」は保存していないので、ここで求め直す（水平の成分だけ使う）
    const b = a.body;
    const u = Navigation.shipUniverse();
    const rx = u.x - b.pos.x, ry = u.y - b.pos.y, rz = u.z - b.pos.z;
    const w = this._omega(b);
    const vs = Astro.mat3MulVec(Navigation.frame.rotT, { x: w.y * rz - w.z * ry, y: w.z * rx - w.x * rz, z: w.x * ry - w.y * rx });
    const v = ship.velocity;
    this._lastRel = { x: (v.x - vs.x) * dt, y: (v.y - vs.y) * dt, z: (v.z - vs.z) * dt };
  },
};
