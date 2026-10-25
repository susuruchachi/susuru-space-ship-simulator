// =============================================================
// 28-deep-space.js
// v88: 恒星間・銀河間の目的地
//
// 要望: 「恒星間、銀河間航行をできるようにしたくて、ハビタブルゾーンを持つ星系をいくつか
// 登録してほしくて、トラピスト-1星系と、グリーゼ星系は確定で入れて欲しくて、ハビタブル
// ゾーンの星は何かしら街明かりがあるようにしてほしい。銀河系はアンドロメダ銀河：NGC 206周辺に
// アンドロメダI宇宙ステーション、小マゼラン雲：NGC 346周辺にも宇宙ステーション、
// 大マゼラン雲：タランチュラ港をほしい」
//
//   - 系外の星系（EXO_SYSTEMS）: 実在の恒星と惑星。位置は赤経・赤緯・距離（J2000）、
//     惑星は公転の半径・周期・半径・質量（観測値。決まっていない値は推定）。軌道は円で近似する。
//     地球から見て惑星が恒星の前を通る（トランジットで見つかった）星系は、軌道面が太陽の方向を含む
//     ように置く。ハビタブルゾーンの惑星（hz）は、海と陸と雲、夜側の街明かりのある姿で描く
//     （表面の模様は架空。ExoTextures で作る）。
//   - 銀河のステーション（GALAXY_STATIONS）: 大マゼラン雲・小マゼラン雲・アンドロメダ銀河の
//     星形成領域のそばに、明るい恒星を回る宇宙ステーション（架空）を置く。まわりの星団・星雲も描く
//     （DeepSpaceFx）。
//   - これらは SolarSystem の天体として登録する（SOLAR_BODIES に足す）ので、目的地の選択・
//     ワープ・内空航行・重力・軌道投入・星図は太陽系の天体と同じように使える。
//   - 宇宙座標の原点は、艦のいる星系に付け替える（SolarSystem.origin）。太陽が原点のままだと、
//     アンドロメダ銀河（約2.4×10^22 m）では倍精度でも数kmの誤差になり、近くの天体がガタつくため。
//
// 出典（主なもの）: NASA Exoplanet Archive、Agol et al. 2021（TRAPPIST-1）、
// Anglada-Escudé et al. 2016（Proxima b）、Faria et al. 2022（Proxima d）、
// Bonfils et al. 2018（Ross 128 b）、Zechmeister et al. 2019（Teegarden's Star）、
// Cadieux et al. 2024（LHS 1140）、Kuchner/Gilbert et al. 2023（TOI-700）、
// Quintana et al. 2014（Kepler-186）、Torres et al. 2015（Kepler-442）、
// Kuzuhara et al. 2024 / Shukla et al. 2024（Gliese 12）、Brands et al. 2022（R136a1）
// =============================================================

// -------------------------------------------------------------
// 系外の星系
//   star: 恒星（質量[太陽]・半径[太陽]・有効温度[K]・光度[太陽]・地球から見た等級V）
//   planets: [記号, 公転の半径[au], 周期[日], 半径[地球], 質量[地球], 種類, ハビタブルゾーン]
//     種類: 'rock'（岩石）| 'hot'（灼熱の岩石）| 'ice'（氷）| 'ocean'（海と陸）| 'mini'（小型ガス）
//   transit: 地球から見てトランジットする（軌道面が太陽の方向を含む）
// -------------------------------------------------------------
const EXO_SYSTEMS = [
  {
    id: 'proxima', ja: 'プロキシマ・ケンタウリ', ra: 217.42896, dec: -62.67947, distPc: 1.3020,
    star: { massSun: 0.122, rSun: 0.154, teff: 3042, lSun: 0.00155, vMag: 11.13 },
    planets: [
      ['d', 0.02886, 5.122, 0.81, 0.26, 'hot', false],
      ['b', 0.04856, 11.1868, 1.07, 1.07, 'ocean', true],
    ],
    desc: '太陽に最も近い恒星（4.2光年）。赤色矮星で、ハビタブルゾーンに地球ほどの大きさの惑星 b がある。',
  },
  {
    id: 'trappist1', ja: 'トラピスト-1', ra: 346.62223, dec: -5.04139, distPc: 12.467, transit: true,
    star: { massSun: 0.0898, rSun: 0.1192, teff: 2566, lSun: 0.000553, vMag: 18.80 },
    planets: [
      ['b', 0.01154, 1.510826, 1.116, 1.374, 'hot', false],
      ['c', 0.01580, 2.421937, 1.097, 1.308, 'hot', false],
      ['d', 0.02227, 4.049219, 0.788, 0.388, 'rock', false],
      ['e', 0.02925, 6.101013, 0.920, 0.692, 'ocean', true],
      ['f', 0.03849, 9.207540, 1.045, 1.039, 'ocean', true],
      ['g', 0.04683, 12.352446, 1.129, 1.321, 'ocean', true],
      ['h', 0.06189, 18.772866, 0.755, 0.326, 'ice', false],
    ],
    desc: '約40光年先の超低温の赤色矮星。地球ほどの大きさの7つの惑星が小さな軌道を回り、e・f・g がハビタブルゾーンにある。',
  },
  {
    id: 'gj581', ja: 'グリーゼ581', ra: 229.86179, dec: -7.72228, distPc: 6.298,
    star: { massSun: 0.311, rSun: 0.299, teff: 3480, lSun: 0.0122, vMag: 10.57 },
    planets: [
      ['e', 0.02815, 3.1490, 1.10, 1.66, 'hot', false],
      ['b', 0.0406, 5.3687, 4.0, 15.8, 'mini', false],
      ['c', 0.0721, 12.9191, 1.6, 5.5, 'ocean', true],
    ],
    desc: '約20光年先の赤色矮星。スーパーアース c はハビタブルゾーンの内側の縁にある（楽観的な見積もり）。',
  },
  {
    id: 'gj667c', ja: 'グリーゼ667C', ra: 259.73817, dec: -34.98975, distPc: 7.244,
    star: { massSun: 0.33, rSun: 0.42, teff: 3350, lSun: 0.0137, vMag: 10.22 },
    planets: [
      ['b', 0.0505, 7.2004, 1.7, 5.6, 'hot', false],
      ['c', 0.125, 28.140, 1.5, 3.8, 'ocean', true],
      ['f', 0.156, 39.026, 1.4, 2.7, 'ocean', true],
    ],
    desc: '約24光年先、3つの恒星からなる星系の赤色矮星C。スーパーアース c・f がハビタブルゾーンにある。',
  },
  {
    id: 'gj12', ja: 'グリーゼ12', ra: 3.95517, dec: 13.55619, distPc: 12.162, transit: true,
    star: { massSun: 0.241, rSun: 0.262, teff: 3296, lSun: 0.0073, vMag: 12.6 },
    planets: [
      ['b', 0.0668, 12.7614, 0.96, 3.87, 'ocean', true],
    ],
    desc: '約40光年先の赤色矮星。地球ほどの大きさの温暖な惑星 b を回す（2024年に発見）。',
  },
  {
    id: 'teegarden', ja: 'ティーガーデン星', ra: 43.25371, dec: 16.88139, distPc: 3.832,
    star: { massSun: 0.097, rSun: 0.107, teff: 2904, lSun: 0.00073, vMag: 15.13 },
    planets: [
      ['b', 0.0259, 4.9100, 1.02, 1.05, 'ocean', true],
      ['c', 0.0455, 11.416, 1.04, 1.11, 'ocean', true],
    ],
    desc: '約12.5光年先の赤色矮星。地球ほどの質量の b と c がハビタブルゾーンにある。',
  },
  {
    id: 'ross128', ja: 'ロス128', ra: 176.93500, dec: 0.80456, distPc: 3.375,
    star: { massSun: 0.168, rSun: 0.197, teff: 3192, lSun: 0.00362, vMag: 11.13 },
    planets: [
      ['b', 0.0496, 9.8658, 1.1, 1.40, 'ocean', true],
    ],
    desc: '約11光年先の静かな赤色矮星。温暖な地球型惑星 b がある。',
  },
  {
    id: 'lhs1140', ja: 'LHS 1140', ra: 11.24721, dec: -15.27153, distPc: 14.993, transit: true,
    star: { massSun: 0.184, rSun: 0.215, teff: 3096, lSun: 0.0038, vMag: 14.18 },
    planets: [
      ['c', 0.0270, 3.7779, 1.27, 1.91, 'hot', false],
      ['b', 0.0946, 24.737, 1.73, 5.6, 'ocean', true],
    ],
    desc: '約49光年先の赤色矮星。ハビタブルゾーンのスーパーアース b は、海に覆われた惑星の候補。',
  },
  {
    id: 'toi700', ja: 'TOI-700', ra: 97.09571, dec: -65.57861, distPc: 31.127, transit: true,
    star: { massSun: 0.415, rSun: 0.420, teff: 3480, lSun: 0.0233, vMag: 13.1 },
    planets: [
      ['b', 0.0637, 9.9772, 0.914, 0.8, 'hot', false],
      ['c', 0.0925, 16.051, 2.63, 7.5, 'mini', false],
      ['e', 0.134, 27.810, 0.95, 0.8, 'ocean', true],
      ['d', 0.163, 37.426, 1.073, 1.25, 'ocean', true],
    ],
    desc: '約100光年先の赤色矮星。TESS衛星が見つけた地球ほどの大きさの e と d がハビタブルゾーンにある。',
  },
  {
    id: 'kepler186', ja: 'ケプラー186', ra: 298.65271, dec: 43.95500, distPc: 177.5, transit: true,
    star: { massSun: 0.544, rSun: 0.523, teff: 3755, lSun: 0.055, vMag: 15.29 },
    planets: [
      ['b', 0.0378, 3.8867, 1.07, 1.2, 'hot', false],
      ['c', 0.0574, 7.2673, 1.25, 2.1, 'hot', false],
      ['d', 0.0861, 13.3431, 1.40, 2.5, 'hot', false],
      ['e', 0.1216, 22.4078, 1.27, 2.2, 'rock', false],
      ['f', 0.432, 129.9459, 1.17, 1.7, 'ocean', true],
    ],
    desc: '約580光年先の赤色矮星。f はハビタブルゾーンで初めて見つかった地球ほどの大きさの惑星。',
  },
  {
    id: 'kepler442', ja: 'ケプラー442', ra: 285.36658, dec: 39.28008, distPc: 370, transit: true,
    star: { massSun: 0.61, rSun: 0.60, teff: 4402, lSun: 0.117, vMag: 14.76 },
    planets: [
      ['b', 0.409, 112.3053, 1.34, 2.3, 'ocean', true],
    ],
    desc: '約1,200光年先のK型の恒星。スーパーアース b は、知られている中で最も地球に似た環境の候補のひとつ。',
  },
];

// -------------------------------------------------------------
// 銀河のステーション（架空）。明るい恒星のまわりの、地球ほどの明るさの場所を回る
//   region: まわりの星団・星雲の見た目（半径[pc]・星の数・星雲の色）
// -------------------------------------------------------------
const GALAXY_STATIONS = [
  {
    id: 'andromeda1', galaxy: 'アンドロメダ銀河', galaxyId: 'm31', area: 'NGC 206',
    ja: 'アンドロメダI宇宙ステーション', ra: 10.13042, dec: 40.73917, distKpc: 765,
    star: { id: 'ngc206_sg', ja: 'NGC 206 の青色超巨星', massSun: 30, rSun: 24, teff: 25000, lSun: 2.0e5, vMag: 17.0 },
    orbitAU: 450,
    region: { radiusPc: 300, count: 9000, color: [0.70, 0.82, 1.0], nebula: [0.45, 0.62, 1.0], nebulaPc: 260 },
    desc: 'アンドロメダ銀河の円盤にある巨大な星の雲 NGC 206 のそばの宇宙ステーション。若い青い星が数千個集まる。',
  },
  {
    id: 'cradle346', galaxy: '小マゼラン雲', galaxyId: 'smc', area: 'NGC 346',
    ja: 'クレイドル宇宙ステーション', ra: 14.77167, dec: -72.17722, distKpc: 61.7,
    star: { id: 'ngc346_o', ja: 'NGC 346 の大質量星（O型）', massSun: 50, rSun: 11, teff: 42000, lSun: 3.0e5, vMag: 12.6 },
    orbitAU: 550,
    region: { radiusPc: 25, count: 5000, color: [0.75, 0.85, 1.0], nebula: [1.0, 0.42, 0.62], nebulaPc: 50 },
    desc: '小マゼラン雲で最も活発な星の生まれる場所（星のゆりかご）NGC 346 のそばの宇宙ステーション。',
  },
  {
    id: 'tarantula', galaxy: '大マゼラン雲', galaxyId: 'lmc', area: 'タランチュラ星雲',
    ja: 'タランチュラ港', ra: 84.67667, dec: -69.10083, distKpc: 49.97,
    star: { id: 'r136a1', ja: 'R136a1', massSun: 196, rSun: 39, teff: 46000, lSun: 6.2e6, vMag: 12.28 },
    orbitAU: 2500,
    region: { radiusPc: 40, count: 8000, color: [0.72, 0.84, 1.0], nebula: [1.0, 0.40, 0.55], nebulaPc: 90 },
    desc: '大マゼラン雲のタランチュラ星雲（かじき座30）の中心、知られている中で最も重い星 R136a1 を回る宇宙港。',
  },
];

// 有効温度 → 星の色（おおまかな黒体の色）
function exoStarColor(teff) {
  const t = teff / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
  else { r = 329.70 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
  const c = (v) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(b)];
}

// 惑星の種類ごとの平均の色・アルベド
const EXO_PLANET_LOOK = {
  hot: { color: [0.62, 0.42, 0.30], albedo: 0.12 },
  rock: { color: [0.55, 0.50, 0.46], albedo: 0.15 },
  ice: { color: [0.82, 0.86, 0.92], albedo: 0.6 },
  ocean: { color: [0.36, 0.52, 0.78], albedo: 0.3 },
  mini: { color: [0.62, 0.74, 0.86], albedo: 0.45 },
};

// -------------------------------------------------------------
// SolarSystem の天体として登録する（SOLAR_BODIES に足す）
// -------------------------------------------------------------
const DeepSpace = {
  systems: [],   // { id, ja, starId, helio, radiusM, kind: 'exo'|'galaxy' }
  stations: [],

  // 決定的な乱数
  _rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },
  _hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  },

  // 恒星の周りの軌道面（宇宙座標の正規直交基底 u, v）。トランジットする星系は太陽の方向を含む面
  _orbitPlane(helio, transit, seed) {
    const rand = this._rng(seed);
    const d = Math.hypot(helio.x, helio.y, helio.z);
    const los = { x: -helio.x / d, y: -helio.y / d, z: -helio.z / d }; // 恒星 → 太陽
    let n;
    if (transit) {
      // 法線は視線に垂直（わずかに傾けて、ちょうど真横から見えるように）
      const ref = Math.abs(los.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      n = vecNormalize(vecCross(los, ref));
      // 視線のまわりに回す（法線は視線に垂直のまま）
      const ang = rand() * Math.PI * 2;
      const w = vecCross(los, n);
      n = vecNormalize({ x: n.x * Math.cos(ang) + w.x * Math.sin(ang), y: n.y * Math.cos(ang) + w.y * Math.sin(ang), z: n.z * Math.cos(ang) + w.z * Math.sin(ang) });
    } else {
      const th = rand() * Math.PI * 2, z = rand() * 2 - 1;
      const s = Math.sqrt(1 - z * z);
      n = { x: s * Math.cos(th), y: z, z: s * Math.sin(th) };
    }
    const ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const u = vecNormalize(vecCross(ref, n));
    const v = vecCross(n, u);
    return { u, v, n };
  },

  register(list) {
    const C = 1.32712440018e11; // 太陽の GM [km^3/s^2]
    const GM_EARTH = 398600.4418;
    for (const sys of EXO_SYSTEMS) {
      const dir = Astro.radecToThree(sys.ra, sys.dec);
      const dM = sys.distPc * Astro.PC;
      const helio = { x: dir.x * dM, y: dir.y * dM, z: dir.z * dM };
      const s = sys.star;
      const starId = sys.id;
      const outer = Math.max(...sys.planets.map((p) => p[1]));
      const radiusM = Math.max(2000 * Astro.AU, outer * Astro.AU * 400);
      this.systems.push({ id: sys.id, ja: sys.ja, starId, helio, radiusM, kind: 'exo', distLy: dM / Astro.LY });
      list.push({
        id: starId, ja: sys.ja, en: sys.ja, type: 'star', sys: sys.id, r: s.rSun * 695700, gm: s.massSun * C,
        albedo: 0, color: exoStarColor(s.teff), teff: s.teff, lum: s.lSun, vMag: s.vMag, distPc: sys.distPc,
        rot: { periodH: 24 * 40 }, orbit: { kind: 'fixed', helio }, systemRadiusM: radiusM,
        desc: `${sys.desc}（距離 ${(dM / Astro.LY).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} 光年、有効温度 ${s.teff.toLocaleString('ja-JP')} K）`,
      });
      const plane = this._orbitPlane(helio, sys.transit, this._hash(sys.id));
      const rand = this._rng(this._hash(sys.id + ':phase'));
      for (const [sym, aAU, pDays, rE, mE, kind, hz] of sys.planets) {
        const look = EXO_PLANET_LOOK[kind] || EXO_PLANET_LOOK.rock;
        const tidal = aAU < 0.5;
        const def = {
          id: `${sys.id}_${sym}`, ja: `${sys.ja} ${sym}`, en: `${sys.ja} ${sym}`, type: 'planet', parent: starId, host: starId, sys: sys.id,
          r: rE * 6371, gm: mE * GM_EARTH, albedo: look.albedo, color: look.color, hz, exoKind: kind,
          rot: tidal ? 'tidal' : { periodH: 20 + rand() * 20 },
          orbit: { kind: 'exo', aAU, pDays, u: plane.u, v: plane.v, M0: rand() * Math.PI * 2 },
          proc: { kind, seed: this._hash(`${sys.id}_${sym}`), hz },
          desc: `${sys.ja}の惑星 ${sym}。半径は地球の${rE}倍、質量は約${mE}倍、公転周期${pDays < 10 ? pDays.toFixed(2) : pDays.toFixed(1)}日${hz ? '。ハビタブルゾーン（液体の水がありうる範囲）にある。街明かりは架空' : ''}${tidal ? '。恒星にいつも同じ面を向けている（潮汐固定）と考えられる' : ''}。`,
        };
        if (kind === 'ocean') def.atmo = { color: [0.40, 0.62, 1.0], strength: 0.9, heightKm: 100 };
        if (kind === 'mini') def.atmo = { color: [0.55, 0.75, 1.0], strength: 0.6, heightKm: 900 };
        if (hz) def.earthLike = { proc: true };
        list.push(def);
      }
    }
    for (const st of GALAXY_STATIONS) {
      const dir = Astro.radecToThree(st.ra, st.dec);
      const dM = st.distKpc * 1000 * Astro.PC;
      const helio = { x: dir.x * dM, y: dir.y * dM, z: dir.z * dM };
      const s = st.star;
      const radiusM = st.region.radiusPc * Astro.PC * 3;
      this.systems.push({ id: st.id, ja: `${st.galaxy}・${st.area}`, starId: s.id, helio, radiusM, kind: 'galaxy', distLy: dM / Astro.LY, region: st.region, stationId: st.id });
      list.push({
        id: s.id, ja: s.ja, en: s.ja, type: 'star', sys: st.id, r: s.rSun * 695700, gm: s.massSun * C,
        albedo: 0, color: exoStarColor(s.teff), teff: s.teff, lum: s.lSun, vMag: s.vMag, distPc: st.distKpc * 1000,
        rot: { periodH: 24 * 5 }, orbit: { kind: 'fixed', helio }, systemRadiusM: radiusM,
        desc: `${st.galaxy}の${st.area}にある明るい恒星（有効温度 ${s.teff.toLocaleString('ja-JP')} K、太陽の約${s.lSun.toExponential(1).replace('e+', '×10^')}倍の明るさ）。`,
      });
      const plane = this._orbitPlane(helio, false, this._hash(st.id));
      const pDays = 365.25 * Math.sqrt(Math.pow(st.orbitAU, 3) / s.massSun);
      list.push({
        id: st.id, ja: st.ja, en: st.ja, type: 'station', parent: s.id, host: s.id, sys: st.id,
        r: 1.6, gm: 1e-12, albedo: 0.5, color: [0.85, 0.88, 0.95],
        soiFixedM: 2e9, // 近く（200万km 以内）ではステーションと一緒に動く座標で航行する（恒星のまわりを回っているため）
        rot: { periodH: 0.05 }, // ゆっくり回る（重力の代わり）
        orbit: { kind: 'exo', aAU: st.orbitAU, pDays, u: plane.u, v: plane.v, M0: 0.7 },
        galaxy: st.galaxy, area: st.area, distLy: dM / Astro.LY,
        desc: `${st.desc}（距離 約${Math.round(dM / Astro.LY / 10000).toLocaleString('ja-JP')}万光年。ステーションは架空）`,
      });
      this.stations.push(st);
    }
  },

  // 天体 b（orbit.kind === 'exo'）の、恒星からの位置 [m]（宇宙座標の軸）
  exoRel(b, jd) {
    const o = b.orbit;
    const th = o.M0 + (2 * Math.PI * (jd - 2451545.0)) / o.pDays;
    const a = o.aAU * Astro.AU;
    const c = Math.cos(th) * a, s = Math.sin(th) * a;
    return { x: o.u.x * c + o.v.x * s, y: o.u.y * c + o.v.y * s, z: o.u.z * c + o.v.z * s };
  },

  // 点（太陽中心の座標）がどの星系にいるか（いなければ null）
  systemAtHelio(h) {
    let best = null, bestD = Infinity;
    for (const s of this.systems) {
      const d = Math.hypot(h.x - s.helio.x, h.y - s.helio.y, h.z - s.helio.z);
      if (d < s.radiusM && d < bestD) { best = s; bestD = d; }
    }
    return best;
  },
  // 宇宙座標の原点にふさわしい場所（太陽中心の座標）: いちばん近い星系の恒星。太陽系に近ければ太陽
  originFor(h) {
    let best = { x: 0, y: 0, z: 0 }, bestD = Math.hypot(h.x, h.y, h.z);
    for (const s of this.systems) {
      const d = Math.hypot(h.x - s.helio.x, h.y - s.helio.y, h.z - s.helio.z);
      if (d < bestD) { best = s.helio; bestD = d; }
    }
    return best;
  },
};

DeepSpace.register(SOLAR_BODIES);

// =============================================================
// 惑星の表面（架空）: 海と陸と雲、夜側の街明かり
//   恒星系ごとに決まった乱数で、球面の上の滑らかな雑音から作る（毎回同じ模様）。
//   最初に画面に大きく写ったときに作る（作るのに数十ミリ秒かかるため）。
// =============================================================
const ExoTextures = {
  _cache: {},

  // 球面上の3Dの値の雑音（格子点の乱数を三次補間）
  _noise3(seed) {
    const N = 64;
    const rand = DeepSpace._rng(seed);
    const perm = new Uint8Array(512);
    const vals = new Float32Array(256);
    for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = rand(); }
    for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const v = (x, y, z) => vals[perm[(perm[(perm[x & 255] + y) & 255] + z) & 255]];
    const sm = (t) => t * t * (3 - 2 * t);
    return (x, y, z) => {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
      const l = (a, b, t) => a + (b - a) * t;
      return l(
        l(l(v(xi, yi, zi), v(xi + 1, yi, zi), xf), l(v(xi, yi + 1, zi), v(xi + 1, yi + 1, zi), xf), yf),
        l(l(v(xi, yi, zi + 1), v(xi + 1, yi, zi + 1), xf), l(v(xi, yi + 1, zi + 1), v(xi + 1, yi + 1, zi + 1), xf), yf),
        zf,
      );
    };
  },

  // b.proc から { day, night, clouds, ocean } の CanvasTexture を作る
  get(b, size) {
    const key = `${b.id}_${size}`;
    if (this._cache[key]) return this._cache[key];
    const W = size, H = size / 2;
    const p = b.proc;
    const n1 = this._noise3(p.seed), n2 = this._noise3(p.seed ^ 0x9e3779b9), n3 = this._noise3(p.seed ^ 0x51ed270b);
    const fbm = (fn, x, y, z, oct) => {
      let s = 0, a = 0.5, f = 1;
      for (let i = 0; i < oct; i++) { s += a * fn(x * f, y * f, z * f); a *= 0.5; f *= 2.03; }
      return s;
    };
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
    const day = mk(), night = p.hz ? mk() : null, clouds = p.hz || p.kind === 'ocean' ? mk() : null, ocean = p.kind === 'ocean' ? mk() : null;
    const dctx = day.getContext('2d'), dimg = dctx.createImageData(W, H);
    const nimg = night ? night.getContext('2d').createImageData(W, H) : null;
    const cimg = clouds ? clouds.getContext('2d').createImageData(W, H) : null;
    const oimg = ocean ? ocean.getContext('2d').createImageData(W, H) : null;
    const rand = DeepSpace._rng(p.seed ^ 0x2545f491);
    const sea = 0.5 + (rand() - 0.5) * 0.08; // 海の割合の目安
    const sc = 2.2;
    for (let j = 0; j < H; j++) {
      const lat = (0.5 - (j + 0.5) / H) * Math.PI;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        // テクスチャの u=0 が経度 -180°（three.js の球の UV の向き）
        const lon = ((i + 0.5) / W) * Math.PI * 2 - Math.PI;
        const x = cl * Math.cos(lon) * sc + 10, y = sl * sc + 10, z = cl * Math.sin(lon) * sc + 10;
        const h = fbm(n1, x, y, z, 6);
        const m = fbm(n2, x * 1.7, y * 1.7, z * 1.7, 4);
        const k = (j * W + i) * 4;
        let r, g, bl;
        const polar = Math.abs(lat) / (Math.PI / 2);
        if (p.kind === 'ocean') {
          const land = h > sea;
          const ice = polar > 0.82 - (h - 0.45) * 0.4;
          if (ice) { r = 225; g = 232; bl = 240; }
          else if (land) {
            const e = Math.min(1, (h - sea) * 6);
            const dry = m;
            r = 70 + 90 * dry + 60 * e; g = 95 + 40 * (1 - dry) + 45 * e; bl = 50 + 30 * dry + 55 * e;
          } else {
            const deep = Math.min(1, (sea - h) * 5);
            r = 18 + 20 * (1 - deep); g = 52 + 40 * (1 - deep); bl = 104 + 50 * (1 - deep);
          }
          if (oimg) { const ov = land || ice ? 0 : 255; oimg.data[k] = oimg.data[k + 1] = oimg.data[k + 2] = ov; oimg.data[k + 3] = 255; }
          // 街明かり: 陸の、海に近い低地ほど多い。細かな雑音で町の粒にする
          if (nimg) {
            let lv = 0;
            if (land && !ice) {
              // 都市圏（大きな雑音）の中に、町の粒（細かな雑音）と点々とした明かりを散らす
              const coast = Math.max(0, 1 - (h - sea) * 9);
              const region = fbm(n3, x * 2.2 + 3, y * 2.2, z * 2.2, 3);
              const town = fbm(n3, x * 22, y * 22, z * 22, 2);
              const urban = Math.min(1.2, Math.max(0, (region - 0.42) * 3.4) * (0.45 + coast));
              lv = Math.max(0, (town - 0.48) * 4.5) * urban;
              if (rand() < 0.10 * urban + 0.006 * coast) lv += 0.3 + rand() * 0.5;
              lv = Math.min(1, lv * 1.8) * (1 - polar * 0.8);
            }
            nimg.data[k] = 255 * lv; nimg.data[k + 1] = 190 * lv; nimg.data[k + 2] = 110 * lv; nimg.data[k + 3] = 255;
          }
        } else if (p.kind === 'hot') {
          const e = h;
          r = 80 + 110 * e + 30 * m; g = 50 + 70 * e; bl = 35 + 40 * e;
        } else if (p.kind === 'ice') {
          const e = h;
          r = 180 + 60 * e; g = 190 + 55 * e; bl = 205 + 45 * e;
          if (m > 0.62) { r -= 50; g -= 35; bl -= 15; }
        } else if (p.kind === 'mini') {
          const band = 0.5 + 0.5 * Math.sin(lat * 9 + (h - 0.5) * 3);
          r = 120 + 40 * band; g = 160 + 35 * band; bl = 200 + 30 * band;
        } else {
          const e = h;
          r = 100 + 80 * e + 20 * m; g = 92 + 70 * e; bl = 84 + 60 * e;
        }
        dimg.data[k] = r; dimg.data[k + 1] = g; dimg.data[k + 2] = bl; dimg.data[k + 3] = 255;
        if (cimg) {
          const cv = fbm(n2, x * 2.4 + 5, y * 3.2, z * 2.4, 5);
          const c = Math.max(0, Math.min(1, (cv - 0.48) * 3.2));
          cimg.data[k] = cimg.data[k + 1] = cimg.data[k + 2] = 255 * c; cimg.data[k + 3] = 255;
        }
      }
    }
    dctx.putImageData(dimg, 0, 0);
    if (nimg) night.getContext('2d').putImageData(nimg, 0, 0);
    if (cimg) clouds.getContext('2d').putImageData(cimg, 0, 0);
    if (oimg) ocean.getContext('2d').putImageData(oimg, 0, 0);
    const tex = (c) => {
      if (!c) return null;
      const t = new THREE.CanvasTexture(c);
      t.anisotropy = 4;
      return t;
    };
    const out = { day: tex(day), night: tex(night), clouds: tex(clouds), ocean: tex(ocean) };
    if (out.day) out.day.encoding = THREE.sRGBEncoding;
    this._cache[key] = out;
    return out;
  },
};

// =============================================================
// 宇宙ステーション（架空）の3Dモデル
//   中心の筒・回転する居住リング・スポーク・太陽電池・窓の明かり・航行灯。半径 1.6 km
//   単位は「天体の最大半径 = 1」（宇宙の描画の天体と同じ扱い）
// =============================================================
const StationModel = {
  VERT: `
    varying vec3 vN;
    varying vec3 vP;
    varying vec2 vUv;
    void main() {
      vN = normalize(mat3(modelMatrix) * normal);
      vP = position;
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  FRAG: `
    uniform vec3 uColor;
    uniform vec3 uSunDirW;
    uniform float uSunIntensity;
    uniform float uWindows;
    uniform float uTime;
    uniform vec3 uGlow;
    varying vec3 vN;
    varying vec3 vP;
    varying vec2 vUv;
    void main() {
      vec3 N = normalize(vN);
      float diff = max(dot(N, normalize(uSunDirW)), 0.0);
      vec3 col = uColor * (0.06 + diff * uSunIntensity);
      if (uWindows > 0.5) {
        // 窓の明かり（並んだ小さな四角）
        vec2 g = fract(vUv * vec2(220.0, 6.0));
        float w = step(0.25, g.x) * step(g.x, 0.75) * step(0.3, g.y) * step(g.y, 0.7);
        float on = step(0.35, fract(sin(dot(floor(vUv * vec2(220.0, 6.0)), vec2(12.9898, 78.233))) * 43758.5453));
        col += vec3(1.0, 0.82, 0.55) * w * on * 0.9;
      }
      col += uGlow;
      gl_FragColor = vec4(col, 1.0);
    }
  `,

  build(b) {
    const group = new THREE.Group();
    const mats = [];
    const mat = (color, windows, glow) => {
      const m = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(...color) }, uSunDirW: { value: new THREE.Vector3(1, 0, 0) },
          uSunIntensity: { value: 1 }, uWindows: { value: windows ? 1 : 0 }, uTime: { value: 0 },
          uGlow: { value: new THREE.Color(...(glow || [0, 0, 0])) },
        },
        vertexShader: this.VERT, fragmentShader: this.FRAG,
      });
      mats.push(m);
      return m;
    };
    const hull = mat([0.72, 0.74, 0.78], false);
    const habit = mat([0.82, 0.84, 0.88], true);
    const dark = mat([0.25, 0.27, 0.32], false);
    const panel = mat([0.10, 0.16, 0.34], false);
    const k = 1 / 1600; // 1 m
    // 居住リング（半径 1000 m）
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1000 * k, 70 * k, 24, 160), habit);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    // 中心の筒（長さ 1800 m）
    const core = new THREE.Mesh(new THREE.CylinderGeometry(120 * k, 120 * k, 1800 * k, 32, 1), hull);
    group.add(core);
    // 入港口（筒の両端）
    for (const s of [1, -1]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(180 * k, 140 * k, 120 * k, 32), dark);
      cap.position.y = s * 960 * k;
      group.add(cap);
      const light = new THREE.Mesh(new THREE.SphereGeometry(30 * k, 12, 8), mat([0, 0, 0], false, [0.6, 0.85, 1.0]));
      light.position.y = s * 1030 * k;
      group.add(light);
    }
    // スポーク
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(25 * k, 25 * k, 880 * k, 10), hull);
      sp.rotation.z = Math.PI / 2;
      sp.position.set(Math.cos(a) * 500 * k, 0, Math.sin(a) * 500 * k);
      sp.rotation.y = -a;
      group.add(sp);
    }
    // 太陽電池（筒の上下）
    for (const s of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const p = new THREE.Mesh(new THREE.BoxGeometry(520 * k, 4 * k, 150 * k), panel);
        p.position.set(Math.cos(a) * 400 * k, s * 650 * k, Math.sin(a) * 400 * k);
        p.rotation.y = -a;
        group.add(p);
      }
    }
    // 航行灯（リングの外周、赤と緑が点滅）
    const blinkers = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const m = mat([0, 0, 0], false, i % 2 ? [1.0, 0.15, 0.1] : [0.1, 1.0, 0.3]);
      const l = new THREE.Mesh(new THREE.SphereGeometry(22 * k, 8, 6), m);
      l.position.set(Math.cos(a) * 1080 * k, 0, Math.sin(a) * 1080 * k);
      group.add(l);
      blinkers.push({ m, base: m.uniforms.uGlow.value.clone(), phase: i * 0.37 });
    }
    group.userData.station = { mats, blinkers, ring };
    return group;
  },

  update(group, sunDirW, intensity, t) {
    const s = group.userData.station;
    for (const m of s.mats) {
      m.uniforms.uSunDirW.value.copy(sunDirW);
      m.uniforms.uSunIntensity.value = intensity;
    }
    for (const bl of s.blinkers) {
      const on = (Math.sin(t * 3 + bl.phase * 6) > 0.6) ? 1 : 0.08;
      bl.m.uniforms.uGlow.value.copy(bl.base).multiplyScalar(on);
    }
  },
};

// =============================================================
// 銀河のステーションのまわりの星団・星雲（宇宙の描画の遠景で描く）
// =============================================================
const DeepSpaceFx = {
  _items: [],

  build(scene) {
    if (typeof GalaxyModel === 'undefined' || !GalaxyModel._points) return;
    for (const sys of DeepSpace.systems) {
      if (sys.kind !== 'galaxy') continue;
      const R = sys.region;
      const rand = DeepSpace._rng(DeepSpace._hash(sys.id + ':cloud'));
      const gauss = () => {
        const u = Math.max(1e-9, rand()), v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      };
      const N = R.count;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        // 中心ほど密な星団（半径は radiusPc を 1 とする単位）
        const core = rand() < 0.35;
        const s = core ? 0.12 : 0.45;
        const x = gauss() * s, y = gauss() * s * 0.8, z = gauss() * s;
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        const hot = rand() < 0.7;
        const c = hot ? R.color : [1.0, 0.82, 0.62];
        const j = 0.85 + rand() * 0.3;
        col[i * 3] = c[0] * j; col[i * 3 + 1] = c[1] * j; col[i * 3 + 2] = c[2] * j;
        size[i] = (0.0006 + rand() * 0.0012) * (core ? 1.6 : 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const m = GalaxyModel._points.material.clone();
      const unitM = R.radiusPc * Astro.PC;
      m.uniforms.uUnitM = { value: unitM };
      m.uniforms.uPointGain = { value: 0.9 };
      const pts = new THREE.Points(geo, m);
      pts.frustumCulled = false;
      const group = new THREE.Group();
      group.add(pts);
      group.scale.setScalar(unitM);
      // 星雲（ぼんやり光る雲。いくつか重ねる）
      const tex = GalaxyModel._makeGlowTexture();
      const neb = [];
      for (let i = 0; i < 7; i++) {
        const sm = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(...R.nebula), transparent: true, opacity: 0.22, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
        const sp = new THREE.Sprite(sm);
        const k = (R.nebulaPc / R.radiusPc) * (0.5 + rand() * 0.8);
        sp.scale.set(k, k, 1);
        sp.position.set(gauss() * 0.25, gauss() * 0.2, gauss() * 0.25);
        group.add(sp);
        neb.push(sp);
      }
      group.visible = false;
      scene.add(group);
      this._items.push({ sys, group, pts, neb, unitM });
    }
  },

  // camHelio: カメラの太陽中心の座標
  update(camHelio, pxPerRad) {
    for (const it of this._items) {
      const dx = it.sys.helio.x - camHelio.x, dy = it.sys.helio.y - camHelio.y, dz = it.sys.helio.z - camHelio.z;
      const d = Math.hypot(dx, dy, dz);
      // 近く（その銀河の中、数千pc 以内）でだけ見える
      const vis = Math.max(0, Math.min(1, (it.unitM * 60 - d) / (it.unitM * 30)));
      it.group.visible = vis > 0.01;
      if (!it.group.visible) continue;
      it.group.position.set(dx, dy, dz);
      const u = it.pts.material.uniforms;
      u.uPxPerRad.value = pxPerRad;
      u.uOpacity.value = vis;
      // 星雲は中にいると全体を覆うので、近いほど淡く
      const inside = Math.max(0, Math.min(1, d / (it.unitM * 1.5)));
      for (const sp of it.neb) sp.material.opacity = 0.3 * vis * (0.6 + 0.4 * inside);
    }
  },
};
