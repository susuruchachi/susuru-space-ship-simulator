// =============================================================
// 13-astro-core.js
// 天体暦の計算コア（Three.js非依存のプレーンな数値計算のみ）
//
// v77: 「リアルな宇宙にしてほしい」という要望で新設。太陽系の天体が
// 実際の日時にどこにあり、どちらを向いているかを計算する。
//   - 惑星: JPL "Keplerian Elements for Approximate Positions of the
//     Major Planets"（E.M. Standish）。1800〜2050年は Table 1、
//     それ以外は Table 2a/2b（紀元前3000年〜西暦3000年）
//   - 月: Meeus "Astronomical Algorithms" 第47章（ELP2000の主要項）
//   - 衛星: JPL Horizons の暦に当てはめた歳差する楕円軌道（tools/fit_satellites.py）
//   - 準惑星・小惑星・彗星: JPL Small-Body Database の接触軌道要素
//   - 自転: IAU WGCCRE（Archinal et al.）の自転軸・本初子午線モデル
//
// 座標系の約束（このファイル以降、宇宙関係のファイルすべて共通）:
//   ecl   : J2000.0 黄道座標（x=春分点方向, z=黄道の北極）右手系
//   eq    : ICRF（J2000.0 赤道座標）
//   gal   : 銀河座標（x=銀河中心方向, z=銀河北極）
//   three : Three.js のワールド座標。ecl を (x, z, -y) に並べ替えたもの
//           （Three.js は Y軸が上なので、黄道の北極を +Y にする）。
//           以後「宇宙座標」と呼ぶ。単位はメートル。
// 行列は 3x3 を長さ9の配列（行優先）で表す。
// =============================================================

const Astro = {
  AU: 149597870700,          // 天文単位 [m]
  C: 299792458,              // 光速 [m/s]
  LY: 9.4607304725808e15,    // 光年 [m]
  PC: 3.0856775814913673e16, // パーセク [m]
  KM: 1000,
  J2000: 2451545.0,
  // TT - UTC [秒]（うるう秒37秒 + 32.184秒。2017年以降この値）
  DELTA_T_SEC: 69.184,
  OBLIQUITY_J2000_DEG: 23.4392911,
  DEG: Math.PI / 180,

  // -----------------------------------------------------------
  // 時刻
  // -----------------------------------------------------------
  // UNIX時刻[ms]（UTC）→ ユリウス日（TT）
  jdTTFromUnixMs(ms) {
    return ms / 86400000 + 2440587.5 + this.DELTA_T_SEC / 86400;
  },
  unixMsFromJdTT(jd) {
    return (jd - 2440587.5 - this.DELTA_T_SEC / 86400) * 86400000;
  },

  // -----------------------------------------------------------
  // 3x3 行列（行優先、長さ9の配列）とベクトル {x,y,z}
  // -----------------------------------------------------------
  mat3MulVec(m, v) {
    return {
      x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
      y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
      z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
    };
  },
  mat3Mul(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
      }
    }
    return r;
  },
  mat3Transpose(m) {
    return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  },
  // ベクトルをx軸まわりにa[rad]回転させる行列（能動回転）
  mat3RotX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, c, -s, 0, s, c];
  },
  mat3RotZ(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  },
  // 列ベクトルが基底になる行列（col0=X軸, col1=Y軸, col2=Z軸）
  mat3FromColumns(cx, cy, cz) {
    return [cx.x, cy.x, cz.x, cx.y, cy.y, cz.y, cx.z, cy.z, cz.z];
  },
  // 回転行列 → クォータニオン {x,y,z,w}（Three.jsのsetFromRotationMatrixと同じ手順）
  quatFromMat3(m) {
    const m11 = m[0], m12 = m[1], m13 = m[2];
    const m21 = m[3], m22 = m[4], m23 = m[5];
    const m31 = m[6], m32 = m[7], m33 = m[8];
    const trace = m11 + m22 + m33;
    let x, y, z, w;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      w = 0.25 / s;
      x = (m32 - m23) * s;
      y = (m13 - m31) * s;
      z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      w = (m32 - m23) / s;
      x = 0.25 * s;
      y = (m12 + m21) / s;
      z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      w = (m13 - m31) / s;
      x = (m12 + m21) / s;
      y = 0.25 * s;
      z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      w = (m21 - m12) / s;
      x = (m13 + m31) / s;
      y = (m23 + m32) / s;
      z = 0.25 * s;
    }
    return { x, y, z, w };
  },

  // -----------------------------------------------------------
  // 座標系の変換行列
  // -----------------------------------------------------------
  // eq → ecl: 黄道傾斜角だけx軸まわりに回す
  ECL_FROM_EQ: null,
  // gal → eq（ヒッパルコス星表 第1巻 1.5.3 の行列の転置）
  EQ_FROM_GAL: [
    -0.0548755604, 0.4941094279, -0.8676661490,
    -0.8734370902, -0.4448296300, -0.1980763734,
    -0.4838350155, 0.7469822445, 0.4559837762,
  ],
  // ecl → three: (x, y, z) → (x, z, -y)
  THREE_FROM_ECL: [1, 0, 0, 0, 0, 1, 0, -1, 0],
  ECL_FROM_THREE: [1, 0, 0, 0, 0, -1, 0, 1, 0],

  eclToThree(v) {
    return { x: v.x, y: v.z, z: -v.y };
  },
  threeToEcl(v) {
    return { x: v.x, y: -v.z, z: v.y };
  },
  eqToEcl(v) {
    return this.mat3MulVec(this.ECL_FROM_EQ, v);
  },
  // 赤経・赤緯[度] → 単位ベクトル（eq）
  radecToVec(raDeg, decDeg) {
    const ra = raDeg * this.DEG, de = decDeg * this.DEG;
    const c = Math.cos(de);
    return { x: c * Math.cos(ra), y: c * Math.sin(ra), z: Math.sin(de) };
  },
  // 赤経・赤緯[度] → 宇宙座標(three)の単位ベクトル
  radecToThree(raDeg, decDeg) {
    return this.eclToThree(this.eqToEcl(this.radecToVec(raDeg, decDeg)));
  },
  // 銀河座標[度] → 宇宙座標(three)の単位ベクトル
  galToThree(lDeg, bDeg) {
    const l = lDeg * this.DEG, b = bDeg * this.DEG;
    const g = { x: Math.cos(b) * Math.cos(l), y: Math.cos(b) * Math.sin(l), z: Math.sin(b) };
    return this.eclToThree(this.eqToEcl(this.mat3MulVec(this.EQ_FROM_GAL, g)));
  },
  // 銀河座標系の各軸を宇宙座標(three)で表した行列（列=銀河x,y,z）
  threeFromGalMatrix() {
    const m = this.mat3Mul(this.THREE_FROM_ECL, this.mat3Mul(this.ECL_FROM_EQ, this.EQ_FROM_GAL));
    return m;
  },

  // -----------------------------------------------------------
  // ケプラー方程式 M = E - e sinE（rad）
  // -----------------------------------------------------------
  solveKepler(M, e) {
    M = ((M + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI * Math.sign(M || 1);
    for (let i = 0; i < 30; i++) {
      const f = E - e * Math.sin(E) - M;
      const d = f / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-14) break;
    }
    return E;
  },

  // 軌道要素（a, e, i, Ω, ω, M。角度はrad）から軌道面座標→基準面座標の位置
  // 戻り値は基準面座標系（x=基準方向, z=基準面の北）での位置（aと同じ単位）
  keplerPosition(a, e, inc, node, argPeri, M) {
    const E = this.solveKepler(M, e);
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(argPeri), sw = Math.sin(argPeri);
    const cn = Math.cos(node), sn = Math.sin(node);
    const ci = Math.cos(inc), si = Math.sin(inc);
    return {
      x: (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
      y: (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
      z: (sw * si) * xp + (cw * si) * yp,
    };
  },

  // -----------------------------------------------------------
  // 惑星（JPL Table 2a / 2b、J2000黄道・春分点基準）
  //   [a(au), e, I(deg), L(deg), 近日点黄経ϖ(deg), 昇交点黄経Ω(deg)] と各1世紀あたりの変化率
  //   Table 2b: Mの補正項 b, c, s, f
  //   冥王星はJPLの旧版Table 1（1800-2050年）の値
  // -----------------------------------------------------------
  PLANET_ELEMENTS: {
    mercury: { el: [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819],
      rate: [0.00000000, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182] },
    venus: { el: [0.72332102, 0.00676399, 3.39777545, 181.97970850, 131.76755713, 76.67261496],
      rate: [-0.00000026, -0.00005107, 0.00043494, 58517.81560260, 0.05679648, -0.27274174] },
    emb: { el: [1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389],
      rate: [-0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.31795260, -0.24123856] },
    mars: { el: [1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984],
      rate: [0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431] },
    jupiter: { el: [5.20248019, 0.04853590, 1.29861416, 34.33479152, 14.27495244, 100.29282654],
      rate: [-0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619],
      extra: [-0.00012452, 0.06064060, -0.35635438, 38.35125000] },
    saturn: { el: [9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702],
      rate: [-0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002],
      extra: [0.00025899, -0.13434469, 0.87320147, 38.35125000] },
    uranus: { el: [19.18797948, 0.04685740, 0.77298127, 314.20276625, 172.43404441, 73.96250215],
      rate: [-0.00020455, -0.00001550, -0.00180155, 428.49512595, 0.09266985, 0.05739699],
      extra: [0.00058331, -0.97731848, 0.17689245, 7.67025000] },
    neptune: { el: [30.06952752, 0.00895439, 1.77005520, 304.22289287, 46.68158724, 131.78635853],
      rate: [0.00006447, 0.00000818, 0.00022400, 218.46515314, 0.01009938, -0.00606302],
      extra: [-0.00041348, 0.68346318, -0.10162547, 7.67025000] },
    pluto: { el: [39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
      rate: [-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482] },
  },

  // JPL Table 1（1800〜2050年用）。現代付近ではTable 2aより精度が良い
  // （Horizonsとの比較で火星70"→17"、天王星281"→1"、海王星129"→32"）。
  PLANET_ELEMENTS_T1: {
    mercury: { el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
      rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
    venus: { el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
      rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
    emb: { el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
      rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0] },
    mars: { el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
      rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
    jupiter: { el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
      rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
    saturn: { el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
      rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
    uranus: { el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
      rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
    neptune: { el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
      rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
  },

  // 惑星（または冥王星系・地球月系の重心）の日心黄道座標 [au]
  //   1800〜2050年はTable 1、それ以外はTable 2a+2b。境界の前後10年は
  //   2つの結果を線形に混ぜ、時間加速で年をまたいでも位置が跳ばないようにする。
  planetHelioEcl(key, jd) {
    const t1 = this.PLANET_ELEMENTS_T1[key];
    if (!t1) return this._planetFromElements(this.PLANET_ELEMENTS[key], jd);
    const year = 2000 + (jd - this.J2000) / 365.25;
    let w1; // Table 1 の重み
    if (year >= 1810 && year <= 2040) w1 = 1;
    else if (year <= 1800 || year >= 2050) w1 = 0;
    else if (year < 1810) w1 = (year - 1800) / 10;
    else w1 = (2050 - year) / 10;
    if (w1 >= 1) return this._planetFromElements(t1, jd);
    const p2 = this._planetFromElements(this.PLANET_ELEMENTS[key], jd);
    if (w1 <= 0) return p2;
    const p1 = this._planetFromElements(t1, jd);
    return {
      x: p1.x * w1 + p2.x * (1 - w1),
      y: p1.y * w1 + p2.y * (1 - w1),
      z: p1.z * w1 + p2.z * (1 - w1),
    };
  },

  // 軌道線を描くための、時刻jdにおける惑星の軌道要素（角度はrad）
  planetOrbitElements(key, jd) {
    const year = 2000 + (jd - this.J2000) / 365.25;
    const p = (this.PLANET_ELEMENTS_T1[key] && year > 1800 && year < 2050) ? this.PLANET_ELEMENTS_T1[key] : this.PLANET_ELEMENTS[key];
    const T = (jd - this.J2000) / 36525;
    const el = p.el, r = p.rate;
    const node = el[5] + r[5] * T;
    const varpi = el[4] + r[4] * T;
    return {
      a: el[0] + r[0] * T,
      e: el[1] + r[1] * T,
      i: (el[2] + r[2] * T) * this.DEG,
      node: node * this.DEG,
      argPeri: (varpi - node) * this.DEG,
    };
  },

  // 軌道要素から楕円軌道上の点を n 個（離心近点角で等間隔＝近日点付近も滑らか）
  orbitPoints(el, n) {
    const pts = [];
    for (let k = 0; k < n; k++) {
      const E = (2 * Math.PI * k) / n;
      const M = E - el.e * Math.sin(E);
      pts.push(this.keplerPosition(el.a, el.e, el.i, el.node, el.argPeri, M));
    }
    return pts;
  },

  _planetFromElements(p, jd) {
    const T = (jd - this.J2000) / 36525;
    const el = p.el, r = p.rate;
    const a = el[0] + r[0] * T;
    const e = el[1] + r[1] * T;
    const I = (el[2] + r[2] * T) * this.DEG;
    const L = el[3] + r[3] * T;
    const varpi = el[4] + r[4] * T;
    const node = el[5] + r[5] * T;
    let M = L - varpi;
    if (p.extra) {
      const [b, c, s, f] = p.extra;
      M += b * T * T + c * Math.cos(f * T * this.DEG) + s * Math.sin(f * T * this.DEG);
    }
    return this.keplerPosition(a, e, I, node * this.DEG, (varpi - node) * this.DEG, M * this.DEG);
  },

  // -----------------------------------------------------------
  // 月の地心位置（Meeus 第47章、ELP2000の主要項）
  // 戻り値: J2000黄道座標 [km]
  // -----------------------------------------------------------
  // [D, M, M', F, Σl係数, Σr係数]
  MOON_LR: [
    [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111],
    [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
    [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
    [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
    [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586],
    [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
    [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321],
    [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
    [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
    [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
    [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379],
    [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
    [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650],
    [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
    [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
    [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
    [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0],
    [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
    [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958],
    [0, 0, 2, 2, -1110, 0], [3, 0, -1, 0, -892, 3258],
    [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
    [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
    [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0],
    [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
    [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739],
    [2, 1, 0, -2, -399, 0], [0, 0, 2, -2, -381, -4421],
    [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
    [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0],
    [0, 2, 1, 0, -323, 1165], [1, 1, -1, 0, 299, 0],
    [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
  ],
  // [D, M, M', F, Σb係数]
  MOON_B: [
    [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693],
    [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271],
    [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266],
    [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
    [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463],
    [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870],
    [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794], [0, 0, 0, 3, -1749],
    [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
    [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335],
    [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
    [0, 0, 1, -3, 777], [4, 0, -2, 1, 671], [2, 0, 0, -3, 607],
    [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
    [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421],
    [2, 1, -1, 1, -366], [2, 1, 0, 1, -351], [4, 0, 0, 1, 331],
    [2, -1, 1, 1, 315], [2, -2, 0, -1, 302], [0, 0, 1, 3, -283],
    [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
    [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185],
    [2, -1, -2, -1, 181], [0, 1, 2, 1, -177], [4, 0, -2, -1, 176],
    [4, -1, -1, -1, 166], [1, 0, 1, -1, -164], [4, 0, 1, -1, 132],
    [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
  ],

  moonGeoEclKm(jd) {
    const T = (jd - this.J2000) / 36525;
    const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    const d2r = this.DEG;
    const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;
    const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000;
    const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000;
    const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000;
    const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000;
    const A1 = 119.75 + 131.849 * T;
    const A2 = 53.09 + 479264.290 * T;
    const A3 = 313.45 + 481266.484 * T;
    const E = 1 - 0.002516 * T - 0.0000074 * T2;

    let sl = 0, sr = 0, sb = 0;
    for (const [cd, cm, cmp, cf, kl, kr] of this.MOON_LR) {
      const arg = (cd * D + cm * M + cmp * Mp + cf * F) * d2r;
      const ef = cm === 0 ? 1 : (Math.abs(cm) === 1 ? E : E * E);
      sl += kl * ef * Math.sin(arg);
      sr += kr * ef * Math.cos(arg);
    }
    for (const [cd, cm, cmp, cf, kb] of this.MOON_B) {
      const arg = (cd * D + cm * M + cmp * Mp + cf * F) * d2r;
      const ef = cm === 0 ? 1 : (Math.abs(cm) === 1 ? E : E * E);
      sb += kb * ef * Math.sin(arg);
    }
    sl += 3958 * Math.sin(A1 * d2r) + 1962 * Math.sin((Lp - F) * d2r) + 318 * Math.sin(A2 * d2r);
    sb += -2235 * Math.sin(Lp * d2r) + 382 * Math.sin(A3 * d2r) + 175 * Math.sin((A1 - F) * d2r)
      + 175 * Math.sin((A1 + F) * d2r) + 127 * Math.sin((Lp - Mp) * d2r) - 115 * Math.sin((Lp + Mp) * d2r);

    // 黄経は「その日の平均春分点」基準なので、一般歳差（≒5029.1"/世紀）を引いてJ2000基準にする
    const precession = (5028.796195 * T + 1.1054348 * T2) / 3600;
    const lambda = (Lp + sl / 1e6 - precession) * d2r;
    const beta = (sb / 1e6) * d2r;
    const dist = 385000.56 + sr / 1000;
    const cb = Math.cos(beta);
    return { x: dist * cb * Math.cos(lambda), y: dist * cb * Math.sin(lambda), z: dist * Math.sin(beta) };
  },

  // -----------------------------------------------------------
  // IAU 自転モデル: 自転軸の赤経α0・赤緯δ0、本初子午線の角度W（いずれも度）
  //   d = J2000からの日数, T = J2000からのユリウス世紀
  // -----------------------------------------------------------
  ROTATION: {
    sun: (d, T) => [286.13, 63.87, 84.176 + 14.1844000 * d],
    mercury: (d, T) => [281.0103 - 0.0328 * T, 61.4155 - 0.0049 * T, 329.5988 + 6.1385108 * d],
    venus: (d, T) => [272.76, 67.16, 160.20 - 1.4813688 * d],
    earth: (d, T) => [0.00 - 0.641 * T, 90.00 - 0.557 * T, 190.147 + 360.9856235 * d],
    mars: (d, T) => [317.68143 - 0.1061 * T, 52.88650 - 0.0609 * T, 176.630 + 350.89198226 * d],
    jupiter: (d, T) => [268.056595 - 0.006499 * T, 64.495303 + 0.002413 * T, 284.95 + 870.5360000 * d],
    saturn: (d, T) => [40.589 - 0.036 * T, 83.537 - 0.004 * T, 38.90 + 810.7939024 * d],
    uranus: (d, T) => [257.311, -15.175, 203.81 - 501.1600928 * d],
    neptune: (d, T) => {
      const N = (357.85 + 52.316 * T) * Math.PI / 180;
      return [299.36 + 0.70 * Math.sin(N), 43.46 - 0.51 * Math.cos(N), 249.978 + 541.1397757 * d - 0.48 * Math.sin(N)];
    },
    pluto: (d, T) => [132.993, -6.163, 302.695 + 56.3625225 * d],
    charon: (d, T) => [132.993, -6.163, 122.695 + 56.3625225 * d],
    // 準惑星・小惑星（自転周期のみ既知のものは軸を黄道北極付近に置く簡易値）
    ceres: (d, T) => [291.418, 66.764, 170.650 + 952.1532 * d],
    vesta: (d, T) => [309.031, 42.235, 285.39 + 1617.3329428 * d],
  },

  rotationAngles(key, jd) {
    const fn = this.ROTATION[key];
    if (!fn) return null;
    const d = jd - this.J2000;
    const T = d / 36525;
    return fn(d, T);
  },

  // 自転軸(α0, δ0)と本初子午線W[度]から「天体固定座標 → J2000黄道座標」の回転行列を作る
  //   天体固定座標: x=経度0°の赤道方向, z=北極, y=東経90°
  bodyToEclMatrix(ra0, dec0, W) {
    const d2r = this.DEG;
    const R = this.mat3Mul(
      this.mat3RotZ((ra0 + 90) * d2r),
      this.mat3Mul(this.mat3RotX((90 - dec0) * d2r), this.mat3RotZ(W * d2r))
    );
    return this.mat3Mul(this.ECL_FROM_EQ, R);
  },

  // 自転軸の向き（赤経・赤緯[度]）を J2000黄道座標の単位ベクトルで返す
  poleEcl(ra0, dec0) {
    return this.eqToEcl(this.radecToVec(ra0, dec0));
  },

  // 基準面（極の赤経・赤緯[度]）の座標系 → J2000黄道座標 の回転行列。
  // 基準面のx軸は「基準面がICRF赤道と交わる昇交点」（JPL衛星平均要素の約束）。
  referencePlaneToEclMatrix(poleRa, poleDec) {
    const d2r = this.DEG;
    const R = this.mat3Mul(this.mat3RotZ((poleRa + 90) * d2r), this.mat3RotX((90 - poleDec) * d2r));
    return this.mat3Mul(this.ECL_FROM_EQ, R);
  },

  // 衛星の平均軌道要素から、親天体に対する位置（J2000黄道座標, km）を求める。
  // 要素は tools/fit_satellites.py で JPL Horizons の暦（1990〜2060年）に
  // 当てはめたもの（14-solar-system.js の fit）。基準面の極 pole=[RA, Dec] の
  // 座標系（x軸=基準面とICRF赤道の昇交点）で、
  //   昇交点 Ω = node0 + nodeRate·t,  平均の緯度引数 u = u0 + n·t (+ 共鳴の秤動),
  //   近点引数 ω = w0 + wRate·t,  平均近点角 M = u − ω   （t: J2000からの日数）
  fittedSatelliteEclKm(fit, jd) {
    const t = jd - this.J2000;
    const node = fit.node0 + fit.nodeRate * t;
    let u = fit.u0 + fit.n * t;
    if (fit.lib) {
      const w = (2 * Math.PI * t) / fit.lib[0];
      u += fit.lib[1] * Math.sin(w) + fit.lib[2] * Math.cos(w);
    }
    const argPeri = fit.w0 + fit.wRate * t;
    const local = this.keplerPosition(fit.a, fit.e, fit.i * this.DEG, node * this.DEG,
      argPeri * this.DEG, (u - argPeri) * this.DEG);
    if (!fit._frame) fit._frame = this.referencePlaneToEclMatrix(fit.pole[0], fit.pole[1]);
    return this.mat3MulVec(fit._frame, local);
  },

  // -----------------------------------------------------------
  // 二体問題（小惑星・準惑星の接触軌道要素から位置を求める）
  //   el: { a(au), e, i, node, w, M(deg, epochJdにおける), n(deg/日), epochJd }
  //   戻り値: 日心J2000黄道座標 [au]
  // -----------------------------------------------------------
  osculatingHelioEcl(el, jd) {
    const M = el.M + el.n * (jd - el.epochJd);
    return this.keplerPosition(el.a, el.e, el.i * this.DEG, el.node * this.DEG, el.w * this.DEG, M * this.DEG);
  },

  // -----------------------------------------------------------
  // 見かけの等級（ランベルト球近似）。半径R[m]・幾何アルベドp・太陽距離rSun[m]・
  // 観測者距離dist[m]・位相角alpha[rad]から。点として描く遠方の惑星・衛星に使う。
  // -----------------------------------------------------------
  SUN_V_AT_1AU: -26.74,
  apparentMagnitude(R, p, rSun, dist, alpha) {
    const phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
    const flux = p * phase * (R / dist) * (R / dist) * (this.AU / rSun) * (this.AU / rSun);
    if (flux <= 0) return 99;
    return this.SUN_V_AT_1AU - 2.5 * Math.log10(flux);
  },
};

Astro.ECL_FROM_EQ = Astro.mat3RotX(-Astro.OBLIQUITY_J2000_DEG * Astro.DEG);

// =============================================================
// シミュレーション時計
//   実時間に連動して進む「宇宙の時刻」（ユリウス日TT）。星図の時間加速で
//   速めたり、現在時刻に戻したりできる。艦の物理（04-flight-physics.js）は
//   常に実時間のdtで動き、この時計の加速の影響は受けない。
// =============================================================
const SimClock = {
  jd: Astro.jdTTFromUnixMs(Date.now()),
  timeScale: 1, // 1=実時間。星図から変更する

  update(dtReal) {
    this.jd += (dtReal * this.timeScale) / 86400;
  },

  resetToNow() {
    this.jd = Astro.jdTTFromUnixMs(Date.now());
    this.timeScale = 1;
  },

  // 表示用のDate（UTC）
  toDate() {
    return new Date(Astro.unixMsFromJdTT(this.jd));
  },
};
