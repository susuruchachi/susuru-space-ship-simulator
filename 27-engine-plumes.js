// =============================================================
// 27-engine-plumes.js
// v85: 機関の種類ごとの噴射（炎）の形
//
// 主エンジン・逆噴射のノズル1つごとに、炎の3Dの形（光る半透明の面）を作る。
// ゲーム（07-engine-fx.js）と艦船建造の確認表示（22-ship-designer.js）の両方で使う。
//
//   rocket   化学ロケット: ノズルから後ろへ広がる炎。根元は白く、外へ・後ろへ行くほど
//            橙→赤に薄れる。根元の内側に明るい芯（ショックダイヤモンド）が並ぶ。
//   nuclear  原子力（熱核）ロケット: 形はロケットと同じで少し細く、色は淡い青白。
//   gravity3 三段圧縮重力場機関: 後ろへ閉じる円錐で、根元近くが少しくびれた炎。
//            その後ろに輪が3本。輪の間隔は後ろほど広く、出力が高いほど全体に広がる。
//            出力が高いと青白く、低いと黄色い。
//   gwave    重力波共振機関: 後ろへ閉じる完全な円錐で、とても長い。その周りを
//            3本の線が螺旋を描いて回りながら後ろへ流れる（スクリューの泡の筋のように）。
//            色は全部青白い。
//
// 形は「ノズルの直径 = 1、噴射の向き = +Z」の大きさで作り、ノズルの直径倍に拡大する。
// =============================================================

const ENGINE_TYPES = {
  rocket: { label: '化学ロケット', length: 7 },
  nuclear: { label: '原子力（熱核）ロケット', length: 8 },
  // v85: 重力場機関系は炎を長く
  gravity3: { label: '三段圧縮重力場機関', length: 14 },
  gwave: { label: '重力波共振機関', length: 32 },
};
const DEFAULT_ENGINE_TYPE = 'rocket';
function normalizeEngineType(t) {
  return ENGINE_TYPES[t] ? t : DEFAULT_ENGINE_TYPE;
}

const EnginePlumes = {
  BRIGHTNESS: 2.0, // v85: 炎全体の明るさ・濃さの倍率
  _geoCache: {},

  // 炎の面のシェーダー。uv.y = 根元0 → 先端1 に沿った位置。
  //   uColorA（根元・芯）→ uColorB（中ほど）→ uColorC（先端）の順に色が変わり、
  //   先へ行くほど・縁（面を斜めに見るところ）ほど薄くなる。
  _material(opts) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: new THREE.Color(opts.a) },
        uColorB: { value: new THREE.Color(opts.b) },
        uColorC: { value: new THREE.Color(opts.c) },
        uIntensity: { value: 1 },
        uTime: { value: 0 },
        uFade: { value: opts.fade ?? 1.6 },     // 先端へ向かって薄くなる速さ
        uEdge: { value: opts.edge ?? 1.2 },     // 縁が薄くなる強さ
        uFlicker: { value: opts.flicker ?? 0.15 },
        uDash: { value: opts.dash ?? 0 },       // 線の筋（螺旋の泡）の数（0 なら筋なし）
        uFlow: { value: opts.flow ?? 0 },       // 筋が後ろへ流れる速さ
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vFacing;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vFacing = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uColorA, uColorB, uColorC;
        uniform float uIntensity, uTime, uFade, uEdge, uFlicker, uDash, uFlow;
        varying vec2 vUv;
        varying float vFacing;
        void main() {
          float t = clamp(vUv.y, 0.0, 1.0);
          vec3 col = t < 0.35 ? mix(uColorA, uColorB, t / 0.35) : mix(uColorB, uColorC, (t - 0.35) / 0.65);
          float along = pow(1.0 - t, uFade);
          float edge = pow(vFacing, uEdge);
          float flick = 1.0 - uFlicker + uFlicker * (0.5 + 0.5 * sin(uTime * 37.0 + t * 23.0) * sin(uTime * 23.0 + vUv.x * 40.0));
          // v85: 全体に濃く明るく（BRIGHTNESS）、根元から先まで薄れにくく
          float a = along * edge * flick * uIntensity * ${EnginePlumes.BRIGHTNESS.toFixed(2)};
          if (uDash > 0.0) {
            // 泡の筋: 後ろへ流れる点の並び
            float d = fract(t * uDash - uTime * uFlow);
            a *= 0.35 + 0.65 * smoothstep(0.0, 0.5, d) * smoothstep(1.0, 0.5, d);
          }
          gl_FragColor = vec4(col * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  },

  // 根元（z=0）から先端（z=1）までの半径 r(z) の回転体。uv.y = z
  _lathe(key, radiusAt, segments) {
    if (this._geoCache[key]) return this._geoCache[key];
    const n = segments || 48;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const z = i / n;
      pts.push(new THREE.Vector2(Math.max(1e-4, radiusAt(z)), z));
    }
    // LatheGeometry は Y 軸まわり。Y→Z に回して、噴射の向き（+Z）に合わせる
    const geo = new THREE.LatheGeometry(pts, 40);
    geo.rotateX(Math.PI / 2);
    this._geoCache[key] = geo;
    return geo;
  },

  _ring(key, radius, tube) {
    if (this._geoCache[key]) return this._geoCache[key];
    const geo = new THREE.TorusGeometry(radius, tube, 10, 48);
    // 輪の uv.y を「根元側」にしておく（シェーダーで薄くなりすぎないように）
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 0.15);
    this._geoCache[key] = geo;
    return geo;
  },

  // 3本の螺旋（円錐の表面に沿って、後ろへ行くほど半径が小さくなる）
  _helix(key, turns, phase) {
    if (this._geoCache[key]) return this._geoCache[key];
    class Helix extends THREE.Curve {
      getPoint(u, target) {
        const r = 0.62 * (1 - u) + 0.04;
        const a = phase + u * turns * Math.PI * 2;
        return (target || new THREE.Vector3()).set(Math.cos(a) * r, Math.sin(a) * r, u);
      }
    }
    const geo = new THREE.TubeGeometry(new Helix(), 360, 0.05, 8, false);
    // TubeGeometry の uv.x が曲線に沿った位置。シェーダーは uv.y を使うので入れ替える
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const x = uv.getX(i); uv.setX(i, uv.getY(i)); uv.setY(i, x); }
    this._geoCache[key] = geo;
    return geo;
  },

  // 1つのノズルの炎を作る。返す物: { object, update(ratio, time) }
  //   object は「ノズルの位置・噴射の向き +Z・ノズルの直径 1」の大きさなので、
  //   呼び出し側で位置・向き・拡大率（直径）を決める。
  create(type) {
    type = normalizeEngineType(type);
    const group = new THREE.Group();
    group.frustumCulled = false;
    const parts = [];
    const add = (geo, mat, extra) => {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 5;
      group.add(m);
      const p = { mesh: m, mat, ...extra };
      parts.push(p);
      return p;
    };
    const L0 = ENGINE_TYPES[type].length;
    let update;

    if (type === 'rocket' || type === 'nuclear') {
      const nuclear = type === 'nuclear';
      // 外側の炎: 真空中では後ろへ大きく広がる
      const outer = add(this._lathe(nuclear ? 'nucOuter' : 'rocOuter', (z) => 0.5 * (1 + (nuclear ? 1.3 : 2.2) * Math.pow(z, 0.75))),
        this._material(nuclear
          ? { a: 0xe6f0ff, b: 0x9fc4ff, c: 0x5a78ff, fade: 0.77, edge: 0.7, flicker: 0.08 }
          : { a: 0xfff2cc, b: 0xffa040, c: 0xff3a10, fade: 0.84, edge: 0.6, flicker: 0.18 }));
      // 芯: 根元の明るい部分（後ろへ細くなる）
      const core = add(this._lathe('core', (z) => 0.42 * Math.pow(1 - z, 0.6)),
        this._material(nuclear
          ? { a: 0xffffff, b: 0xd0e4ff, c: 0x90b0ff, fade: 0.7, edge: 0.6, flicker: 0.05 }
          : { a: 0xffffff, b: 0xfff0b0, c: 0xffb050, fade: 0.7, edge: 0.6, flicker: 0.1 }));
      // ショックダイヤモンド（芯の中に並ぶ明るい節）
      const diamonds = [];
      for (let i = 0; i < 3; i++) {
        diamonds.push(add(this._lathe('diamond', (z) => 0.22 * Math.sin(Math.PI * z)),
          this._material(nuclear
            ? { a: 0xffffff, b: 0xe0ecff, c: 0xc0d4ff, fade: 0.28, edge: 0.5, flicker: 0.05 }
            : { a: 0xffffff, b: 0xffffe0, c: 0xfff0a0, fade: 0.28, edge: 0.5, flicker: 0.1 })));
      }
      update = (ratio, time) => {
        const L = L0 * (0.35 + 0.65 * ratio);
        outer.mesh.scale.set(1, 1, L);
        outer.mat.uniforms.uIntensity.value = (nuclear ? 0.9 : 1.1) * (0.3 + 0.7 * ratio);
        const Lc = L * 0.32;
        core.mesh.scale.set(1, 1, Lc);
        core.mat.uniforms.uIntensity.value = 1.6 * (0.4 + 0.6 * ratio);
        diamonds.forEach((d, i) => {
          const len = Lc * 0.22;
          d.mesh.position.z = Lc * (0.12 + i * 0.27);
          d.mesh.scale.set(1 - i * 0.18, 1 - i * 0.18, len);
          d.mat.uniforms.uIntensity.value = (1.6 - i * 0.4) * ratio;
        });
        for (const p of parts) p.mat.uniforms.uTime.value = time;
      };
    } else if (type === 'gravity3') {
      // 後ろへ閉じる円錐で、根元から少し後ろが細くくびれる
      const cone = add(this._lathe('g3cone', (z) => 0.5 * Math.pow(1 - z, 0.85) * (1 - 0.28 * Math.exp(-Math.pow((z - 0.22) / 0.1, 2)))),
        this._material({ a: 0xffffff, b: 0xb8d8ff, c: 0x7fb0ff, fade: 0.63, edge: 1.0, flicker: 0.06 }));
      const rings = [];
      for (let i = 0; i < 3; i++) {
        rings.push(add(this._ring('g3ring', 0.5, 0.045),
          this._material({ a: 0xffffff, b: 0xc8e0ff, c: 0xc8e0ff, fade: 0.7, edge: 0.4, flicker: 0.05 })));
      }
      const low = new THREE.Color(0xffd860), lowB = new THREE.Color(0xffb030);
      const high = new THREE.Color(0xd8ecff), highB = new THREE.Color(0x8fbcff);
      update = (ratio, time) => {
        const L = L0 * (0.45 + 0.55 * ratio);
        cone.mesh.scale.set(1, 1, L);
        cone.mat.uniforms.uIntensity.value = 1.1 * (0.35 + 0.65 * ratio);
        // 色: 出力が低いと黄色、高いと青白
        const k = clamp((ratio - 0.15) / 0.7, 0, 1);
        const cA = low.clone().lerp(high, k), cB = lowB.clone().lerp(highB, k);
        for (const p of [cone, ...rings]) {
          p.mat.uniforms.uColorA.value.copy(cA);
          p.mat.uniforms.uColorB.value.copy(cB);
          p.mat.uniforms.uColorC.value.copy(cB);
        }
        // 輪の位置: 間隔は後ろほど広く（1 : 1.6 : 2.4）、出力が高いほど広がる
        const s = L * (0.07 + 0.09 * ratio);
        const gaps = [1, 1.6, 2.4];
        let z = L * 0.35;
        rings.forEach((r, i) => {
          z += s * gaps[i] * (i === 0 ? 0.5 : 1);
          r.mesh.position.z = z;
          const rad = 0.95 - i * 0.12;
          r.mesh.scale.set(rad, rad, rad);
          r.mat.uniforms.uIntensity.value = (1.5 - i * 0.35) * (0.3 + 0.7 * ratio);
        });
        for (const p of parts) p.mat.uniforms.uTime.value = time;
      };
    } else {
      // 重力波共振機関: 完全な円錐で、とても長い
      const cone = add(this._lathe('gwcone', (z) => 0.5 * (1 - z)),
        this._material({ a: 0xffffff, b: 0xbfdcff, c: 0x80aaff, fade: 0.56, edge: 1.1, flicker: 0.04 }));
      const helixGroup = new THREE.Group();
      group.add(helixGroup);
      const lines = [];
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(this._helix(`gwhelix${i}`, 4, (i * Math.PI * 2) / 3),
          this._material({ a: 0xffffff, b: 0xd8ecff, c: 0x9cc4ff, fade: 0.49, edge: 0.0, flicker: 0, dash: 14, flow: 2.2 }));
        m.frustumCulled = false;
        m.renderOrder = 6;
        helixGroup.add(m);
        const p = { mesh: m, mat: m.material };
        parts.push(p);
        lines.push(p);
      }
      update = (ratio, time) => {
        const L = L0 * (0.4 + 0.6 * ratio);
        cone.mesh.scale.set(1, 1, L);
        cone.mat.uniforms.uIntensity.value = 0.45 * (0.3 + 0.7 * ratio);
        helixGroup.scale.set(1, 1, L);
        // 螺旋が回りながら後ろへ流れる（出力が高いほど速い）
        helixGroup.rotation.z = -time * (1.5 + 3 * ratio);
        for (const p of lines) {
          p.mat.uniforms.uIntensity.value = 1.1 * (0.3 + 0.7 * ratio);
          p.mat.uniforms.uFlow.value = 1 + 2.5 * ratio;
        }
        for (const p of parts) p.mat.uniforms.uTime.value = time;
      };
    }

    return {
      type,
      object: group,
      update(ratio, time) {
        group.visible = ratio > 0.01;
        if (group.visible) update(Math.min(1, ratio), time);
      },
      dispose() {
        for (const p of parts) p.mat.dispose();
      },
    };
  },
};
