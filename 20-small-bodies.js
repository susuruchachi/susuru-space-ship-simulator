// =============================================================
// 20-small-bodies.js
// 星図に表示する小天体の分布: 小惑星帯・ヒルダ群・トロヤ群・地球近傍小惑星・
// ケンタウルス族・太陽系外縁天体（約3万4千個。すべて実在の天体の実際の軌道）
//
// v77: 新設。データ（data/small-bodies.js、約0.7MB。JPL Small-Body Database
// から tools/build_small_bodies.py で生成）は星図を初めて開いたときに読み込む。
// 位置はケプラー方程式を頂点シェーダーで毎フレーム解いて求めるので、
// 星図で時間を早送りしても CPU の負担は増えない。
// 惑星の重力による摂動は無視している（数年〜数十年なら見た目には十分）。
// =============================================================

const SMALL_BODY_VERT = `
  uniform float uDays;        // 共通の元期からの経過日数
  uniform float uPixelRatio;
  uniform float uCamSun;      // カメラと太陽の距離 [m]
  attribute vec3 aQ;          // 軌道面内で近日点方向(position)に直交する単位ベクトル
  attribute vec4 aOrb;        // 軌道長半径[m], 離心率, 元期の平均近点角[rad], 平均運動[rad/日]
  attribute vec4 aLook;       // 色(rgb), 点の大きさ[CSS px]
  varying vec3 vColor;
  varying float vFade;
  void main() {
    float e = aOrb.y;
    float M = mod(aOrb.z + aOrb.w * uDays, 6.28318530718);
    // ケプラー方程式 E - e sinE = M（離心率の大きい軌道はE=πから始めると必ず収束する）
    float E = e < 0.8 ? M + e * sin(M) : 3.14159265359;
    for (int k = 0; k < 8; k++) {
      E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
    }
    vec3 p = aOrb.x * ((cos(E) - e) * position + sqrt(1.0 - e * e) * sin(E) * aQ);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aLook.w * uPixelRatio;
    vColor = aLook.rgb;
    // 遠くから見て群れ全体が小さく写るときは、点が重なって白飛びしないよう薄くする
    // （群れの見かけの大きさに比例。さらに小さく写るときは2乗で急に薄くする）
    float r = 2.2 * aOrb.x / max(uCamSun, 1.0);
    vFade = r >= 0.08 ? min(r, 1.0) : r * r / 0.08;
  }
`;

const SMALL_BODY_FRAG = `
  uniform float uAlpha;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r2 = dot(c, c) * 4.0;
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColor, uAlpha * vFade * (1.0 - 0.6 * r2 * r2));
  }
`;

const SmallBodies = {
  // 分類ごとの表示（data/small-bodies.js の groups と同じキー）
  GROUPS: {
    main: { ja: '小惑星帯', color: [0.85, 0.76, 0.62], alpha: 0.8 },
    hilda: { ja: 'ヒルダ群', color: [1.0, 0.6, 0.32], alpha: 0.95 },
    trojan: { ja: 'トロヤ群', color: [0.58, 0.9, 0.5], alpha: 0.85 },
    neo: { ja: '地球近傍小惑星', color: [1.0, 0.42, 0.42], alpha: 1.0 },
    centaur: { ja: 'ケンタウルス族', color: [0.5, 0.9, 0.88], alpha: 0.9 },
    tno: { ja: '太陽系外縁天体', color: [0.58, 0.72, 1.0], alpha: 0.9 },
  },

  // 星図に出す群の名前。位置は基準の惑星（ref）から黄経を dLon 度ずらした、
  // 太陽から rAU 天文単位の点（rAU省略時は惑星と同じ距離）
  REGIONS: [
    {
      id: 'mainbelt', ja: '小惑星帯', group: 'main', ref: 'jupiter', dLon: -120, rAU: 2.75, minAU: 1.2, maxAU: 40, focusAU: 7,
      desc: '火星と木星の間、太陽から約2.1〜3.3天文単位に広がる小天体の集まり。木星の重力との共鳴で、特定の公転周期の軌道はほとんど空いている（カークウッドの空隙）。表示しているのは直径およそ5km以上の番号付き小惑星。',
    },
    {
      id: 'trojanL4', ja: 'トロヤ群 (L4)', group: 'trojan', ref: 'jupiter', dLon: 60, minAU: 1.5, maxAU: 40, focusAU: 4,
      desc: '木星と同じ軌道上の、木星の60°前方にあるラグランジュ点L4のまわりに集まった小惑星。後方のL5にも同じような群れがある。',
    },
    {
      id: 'trojanL5', ja: 'トロヤ群 (L5)', group: 'trojan', ref: 'jupiter', dLon: -60, minAU: 1.5, maxAU: 40, focusAU: 4,
      desc: '木星と同じ軌道上の、木星の60°後方にあるラグランジュ点L5のまわりに集まった小惑星。前方のL4にも同じような群れがある。',
    },
    {
      id: 'hilda', ja: 'ヒルダ群', group: 'hilda', ref: 'jupiter', dLon: 180, rAU: 4.4, minAU: 2.5, maxAU: 40, focusAU: 9,
      desc: '木星が2周する間に3周する（3:2の軌道共鳴）小惑星群。木星の公転に合わせて、木星の前方・後方・反対側を頂点とする三角形の隊列を保ち続ける。',
    },
    {
      id: 'kuiper', ja: 'エッジワース・カイパーベルト', group: 'tno', ref: 'neptune', dLon: 90, rAU: 44, minAU: 25, maxAU: 2500, focusAU: 150,
      desc: '海王星の外側、太陽から約30〜50天文単位に広がる氷の小天体の集まり。冥王星もその一員。表示しているのは発見済みの太陽系外縁天体で、観測しやすい方向（天の川と重ならない方向など）に偏っている。',
    },
  ],

  counts: {},
  _state: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  _points: null,
  _epoch: 0,
  _rel: {},

  isReady() {
    return this._state === 'ready';
  },

  // データを読み込む（星図を開いたときに呼ぶ。2回目以降は何もしない）
  load() {
    if (this._state !== 'idle') return;
    if (typeof SMALL_BODY_DATA !== 'undefined') { this._build(); return; }
    this._state = 'loading';
    const s = document.createElement('script');
    s.src = 'data/small-bodies.js';
    s.onload = () => {
      try {
        this._build();
      } catch (err) {
        console.warn('小天体データの展開に失敗しました', err);
        this._state = 'error';
      }
    };
    s.onerror = () => { this._state = 'error'; };
    document.head.appendChild(s);
  },

  _build() {
    const D = SMALL_BODY_DATA;
    const N = D.count;
    const bin = atob(D.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    const P = new Float32Array(N * 3);
    const Q = new Float32Array(N * 3);
    const orb = new Float32Array(N * 4);
    const look = new Float32Array(N * 4);
    const K = 0.01720209895; // ガウス引力定数 [rad/日]（平均運動 n = K / a^1.5）
    const TWO_PI = Math.PI * 2;
    const counts = {};
    for (let k = 0; k < N; k++) {
      const o = k * 16;
      const a = dv.getFloat32(o, true);
      const e = dv.getUint16(o + 4, true) / 65535;
      const inc = (dv.getUint16(o + 6, true) / 65535) * Math.PI;
      const node = (dv.getUint16(o + 8, true) / 65536) * TWO_PI;
      const peri = (dv.getUint16(o + 10, true) / 65536) * TWO_PI;
      const M0 = (dv.getUint16(o + 12, true) / 65536) * TWO_PI;
      const H = dv.getUint8(o + 14) / 10;
      const gKey = D.groups[dv.getUint8(o + 15)];
      const g = this.GROUPS[gKey] || this.GROUPS.main;
      counts[gKey] = (counts[gKey] || 0) + 1;
      // 近日点方向 P と、軌道面内でそれに直交する Q（黄道座標）を宇宙座標 (x, z, -y) に
      const cO = Math.cos(node), sO = Math.sin(node);
      const cw = Math.cos(peri), sw = Math.sin(peri);
      const ci = Math.cos(inc), si = Math.sin(inc);
      const px = cw * cO - sw * sO * ci, py = cw * sO + sw * cO * ci, pz = sw * si;
      const qx = -sw * cO - cw * sO * ci, qy = -sw * sO + cw * cO * ci, qz = cw * si;
      P[k * 3] = px; P[k * 3 + 1] = pz; P[k * 3 + 2] = -py;
      Q[k * 3] = qx; Q[k * 3 + 1] = qz; Q[k * 3 + 2] = -qy;
      orb[k * 4] = a * Astro.AU;
      orb[k * 4 + 1] = e;
      orb[k * 4 + 2] = M0;
      orb[k * 4 + 3] = K / Math.pow(a, 1.5);
      // 大きい（絶対等級Hが小さい）天体ほど大きな点に。外縁天体は遠いぶん基準を変える。
      // ヒルダ群は数が少なく三角形の隊列が見えにくいので少し大きく
      const hRef = gKey === 'tno' || gKey === 'centaur' ? 9.5 : gKey === 'hilda' ? 16 : 14;
      look[k * 4] = g.color[0] * g.alpha;
      look[k * 4 + 1] = g.color[1] * g.alpha;
      look[k * 4 + 2] = g.color[2] * g.alpha;
      look[k * 4 + 3] = Math.max(1.0, Math.min(3.2, 1.0 + (hRef - H) * 0.22));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('aQ', new THREE.BufferAttribute(Q, 3));
    geo.setAttribute('aOrb', new THREE.BufferAttribute(orb, 4));
    geo.setAttribute('aLook', new THREE.BufferAttribute(look, 4));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uDays: { value: 0 },
        uPixelRatio: { value: 1 },
        uCamSun: { value: Astro.AU },
        uAlpha: { value: 1 },
      },
      vertexShader: SMALL_BODY_VERT,
      fragmentShader: SMALL_BODY_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; // 頂点位置はシェーダーで決まるので、境界球による判定はできない
    pts.renderOrder = 4;
    pts.visible = false;
    Universe.scene.add(pts);
    this._points = pts;
    this._epoch = D.epoch;
    this.counts = counts;
    this._state = 'ready';
  },

  // 星図から毎フレーム呼ぶ（Universe.setView の後）。alpha: 全体の濃さ（0で非表示）
  update(alpha) {
    if (!this._points) return;
    const show = alpha > 0.003;
    this._points.visible = show;
    if (!show) return;
    const rel = Universe.relPos(SolarSystem.byId.sun, this._rel);
    this._points.position.set(rel.x, rel.y, rel.z);
    const u = this._points.material.uniforms;
    u.uDays.value = SolarSystem.jd - this._epoch;
    u.uAlpha.value = alpha;
    u.uCamSun.value = Math.hypot(rel.x, rel.y, rel.z);
    u.uPixelRatio.value = Universe._renderer ? Universe._renderer.getPixelRatio() : 1;
  },

  hide() {
    if (this._points) this._points.visible = false;
  },

  // 群の名前を出す位置（宇宙座標）
  regionUniverse(r) {
    const b = SolarSystem.byId[r.ref];
    const th = (r.dLon * Math.PI) / 180;
    const c = Math.cos(th), s = Math.sin(th);
    // 黄道の北極（宇宙座標の+Y）まわりに黄経を dLon 度進める
    const x = b.pos.x * c + b.pos.z * s;
    const z = -b.pos.x * s + b.pos.z * c;
    const len = Math.hypot(x, z) || 1;
    const R = r.rAU ? r.rAU * Astro.AU : len;
    return { x: (x / len) * R, y: 0, z: (z / len) * R };
  },
};
