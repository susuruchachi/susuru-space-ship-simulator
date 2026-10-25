// =============================================================
// 14-solar-system.js
// 太陽系の天体データと、毎フレームの位置・姿勢の計算
//
// v77: 太陽・惑星・準惑星・主要な衛星・小惑星・彗星を実寸・実軌道で定義する。
// 位置・姿勢の計算は 13-astro-core.js（Astro）を使い、結果は
// 「宇宙座標（three）」= 太陽中心・J2000黄道基準・単位メートル で保持する。
// Three.js には依存しない（描画は 15-universe-render.js 側）。
//
// 物理量の出典: 半径・自転はIAU WGCCRE、GMはJPL、幾何アルベドはNASA
// Planetary Fact Sheet、衛星の軌道要素は JPL Horizons の暦への当てはめ
// （tools/fit_satellites.py）、小天体の軌道要素は JPL Small-Body Database。
// =============================================================

const SOLAR_EPOCH_J2000 = 2451545.0;

// 小天体の接触軌道要素（JPL SBDB）。a[au], 角度[度], n[度/日]
function oscEl(epochJd, a, e, i, node, w, M, n) {
  return { epochJd, a, e, i, node, w, M, n };
}

// -------------------------------------------------------------
// 天体の定義
//   id        : 内部ID（英小文字）
//   ja / en   : 表示名
//   type      : 'star' | 'planet' | 'dwarf' | 'moon' | 'asteroid' | 'comet'
//   parent    : 親天体のID（衛星のみ）
//   r         : 赤道半径 [km]、rp: 極半径 [km]（省略時 r）、rb: 3軸目（楕円体のみ）
//   gm        : 重力定数×質量 [km^3/s^2]（影響圏・ワープ速度制限に使う）
//   albedo    : 幾何アルベド（遠くで点として描くときの明るさ）
//   color     : 平均的な色（点表示・惑星光に使う）
//   tex       : テクスチャ名（textures/<tex>_<level>.jpg）と用意されている解像度
//   rot       : 自転モデル（Astro.ROTATION のキー）| 'tidal'（親に同じ面を向ける）
//               | { periodH } （自転周期のみ。軸は黄道北極）
//   orbit     : 軌道の種類と要素
//   atmo      : 大気の見た目（色, 強さ, 厚み[km]）
//   rings     : 環（内径・外径[km]）
// -------------------------------------------------------------
const SOLAR_BODIES = [
  {
    id: 'sun', ja: '太陽', en: 'Sun', type: 'star', r: 695700, gm: 1.32712440018e11,
    albedo: 0, color: [1.0, 0.96, 0.88], tex: 'sun', texLevels: ['1k', '2k'], rot: 'sun',
    orbit: { kind: 'origin' },
    desc: '太陽系の中心にあるG型主系列星。半径は地球の約109倍。',
  },
  {
    id: 'mercury', ja: '水星', en: 'Mercury', type: 'planet', r: 2439.7, gm: 22031.78,
    albedo: 0.142, color: [0.62, 0.60, 0.57], tex: 'mercury', texLevels: ['1k', '2k', '4k'], rot: 'mercury',
    orbit: { kind: 'planet', key: 'mercury' },
    desc: '最も太陽に近い惑星。大気がほとんど無く、表面はクレーターに覆われている。',
  },
  {
    id: 'venus', ja: '金星', en: 'Venus', type: 'planet', r: 6051.8, gm: 324858.59,
    albedo: 0.689, color: [0.93, 0.86, 0.68], tex: 'venus', texLevels: ['1k', '2k'], rot: 'venus',
    orbit: { kind: 'planet', key: 'venus' },
    atmo: { color: [1.0, 0.86, 0.6], strength: 0.9, heightKm: 250 },
    desc: '濃い二酸化炭素の大気と硫酸の雲に覆われた惑星。可視光では雲しか見えない。',
  },
  {
    id: 'earth', ja: '地球', en: 'Earth', type: 'planet', r: 6378.137, rp: 6356.752, gm: 398600.435,
    albedo: 0.434, color: [0.45, 0.58, 0.82], tex: 'earth_day', texLevels: ['1k', '2k', '4k'], rot: 'earth',
    earthLike: { night: 'earth_night', nightLevels: ['1k', '2k', '4k'], clouds: 'earth_clouds',
      cloudLevels: ['1k', '2k', '4k'], ocean: 'earth_ocean', oceanLevels: ['1k', '2k'] },
    orbit: { kind: 'earth' },
    atmo: { color: [0.32, 0.56, 1.0], strength: 1.0, heightKm: 110 },
    desc: '私たちの母星。母港（ドッキングポート群）は高度2,000kmの軌道上にある。',
  },
  {
    id: 'moon', ja: '月', en: 'Moon', type: 'moon', parent: 'earth', r: 1737.4, gm: 4902.800,
    albedo: 0.12, color: [0.66, 0.65, 0.63], tex: 'moon', texLevels: ['1k', '2k', '4k'], rot: 'tidal',
    orbit: { kind: 'moon' },
    desc: '地球唯一の衛星。いつも同じ面を地球に向けている（潮汐固定）。',
  },
  {
    id: 'mars', ja: '火星', en: 'Mars', type: 'planet', r: 3396.19, rp: 3376.20, gm: 42828.37,
    albedo: 0.170, color: [0.80, 0.50, 0.33], tex: 'mars', texLevels: ['1k', '2k', '4k'], rot: 'mars',
    orbit: { kind: 'planet', key: 'mars' },
    atmo: { color: [0.95, 0.62, 0.45], strength: 0.3, heightKm: 60 },
    desc: '赤い惑星。太陽系最大の火山オリンポス山と大峡谷マリネリス峡谷がある。',
  },
  {
    id: 'phobos', ja: 'フォボス', en: 'Phobos', type: 'moon', parent: 'mars', r: 13.0, rp: 9.1, rb: 11.4, gm: 7.087e-4,
    albedo: 0.071, color: [0.45, 0.42, 0.40], tex: 'phobos', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [317.7, 52.9], a: 9376, e: 0.0018, i: 1.075, node0: 169.191, nodeRate: -0.435796, u0: 45.7066, n: 1129.2807236, w0: 169.74, wRate: 0.896024 } },
    desc: '火星の内側の衛星。いびつな形をした小さな天体で、少しずつ火星に近づいている。',
  },
  {
    id: 'deimos', ja: 'ダイモス', en: 'Deimos', type: 'moon', parent: 'mars', r: 7.8, rp: 5.1, rb: 6.0, gm: 9.615e-5,
    albedo: 0.068, color: [0.50, 0.47, 0.44], tex: 'deimos', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [316.6, 53.5], a: 23458, e: 0.0001, i: 1.796, node0: 55.160, nodeRate: -0.018137, u0: 204.3224, n: 285.1800180, w0: 202.19, wRate: 0 } },
    desc: '火星の外側の小さな衛星。',
  },
  {
    id: 'jupiter', ja: '木星', en: 'Jupiter', type: 'planet', r: 71492, rp: 66854, gm: 126686534,
    albedo: 0.538, color: [0.85, 0.78, 0.66], tex: 'jupiter', texLevels: ['1k', '2k', '4k'], rot: 'jupiter',
    orbit: { kind: 'planet', key: 'jupiter' },
    atmo: { color: [0.95, 0.88, 0.75], strength: 0.25, heightKm: 1500 },
    desc: '太陽系最大の惑星。大赤斑は地球がすっぽり入る巨大な嵐。',
  },
  {
    id: 'io', ja: 'イオ', en: 'Io', type: 'moon', parent: 'jupiter', r: 1821.6, gm: 5959.916,
    albedo: 0.63, color: [0.85, 0.80, 0.50], tex: 'io', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [268.1, 64.5], a: 421769, e: 0.0041, i: 0, node0: 0, nodeRate: 0, u0: 19.9044, n: 203.4889588, w0: 48.06, wRate: -0.739405 } },
    desc: '太陽系で最も火山活動が活発な天体。',
  },
  {
    id: 'europa', ja: 'エウロパ', en: 'Europa', type: 'moon', parent: 'jupiter', r: 1560.8, gm: 3202.739,
    albedo: 0.67, color: [0.82, 0.78, 0.70], tex: 'europa', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [268.1, 64.5], a: 671089, e: 0.0010, i: 0, node0: 0, nodeRate: 0, u0: 214.4648, n: 101.3747245, w0: 293.85, wRate: -0.707049 } },
    desc: '氷の地殻の下に液体の海があると考えられている衛星。',
  },
  {
    id: 'ganymede', ja: 'ガニメデ', en: 'Ganymede', type: 'moon', parent: 'jupiter', r: 2631.2, gm: 9887.834,
    albedo: 0.43, color: [0.62, 0.58, 0.52], tex: 'ganymede', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [268.2, 64.6], a: 1070436, e: 0.0009, i: 0, node0: 0, nodeRate: 0, u0: 221.6536, n: 50.3176076, w0: 192.42, wRate: 0.014431 } },
    desc: '太陽系最大の衛星。水星よりも大きい。',
  },
  {
    id: 'callisto', ja: 'カリスト', en: 'Callisto', type: 'moon', parent: 'jupiter', r: 2410.3, gm: 7179.289,
    albedo: 0.22, color: [0.45, 0.42, 0.38], tex: 'callisto', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [268.7, 64.8], a: 1882786, e: 0.0071, i: 0, node0: 0, nodeRate: 0, u0: 80.3905, n: 21.5710727, w0: 338.23, wRate: 0.003546 } },
    desc: '太陽系で最もクレーターの多い天体のひとつ。',
  },
  {
    id: 'saturn', ja: '土星', en: 'Saturn', type: 'planet', r: 60268, rp: 54364, gm: 37931187,
    albedo: 0.499, color: [0.89, 0.82, 0.64], tex: 'saturn', texLevels: ['1k', '2k', '4k'], rot: 'saturn',
    orbit: { kind: 'planet', key: 'saturn' },
    atmo: { color: [0.95, 0.88, 0.70], strength: 0.25, heightKm: 1500 },
    rings: { inner: 74500, outer: 140220, tex: 'saturn_ring', kind: 'saturn' },
    desc: '美しい環を持つ惑星。環は主に氷の粒でできていて、厚さは数十mしかない。',
  },
  {
    id: 'mimas', ja: 'ミマス', en: 'Mimas', type: 'moon', parent: 'saturn', r: 198.2, gm: 2.503,
    albedo: 0.962, color: [0.80, 0.80, 0.80], tex: 'mimas', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [40.6, 83.5], a: 185612, e: 0.0196, i: 1.576, node0: 173.013, nodeRate: -0.999503, u0: 347.3673, n: 382.9940011, w0: 343.02, wRate: 1.999242, lib: [25858.0, -33.9198, 27.5951] } },
    desc: '巨大なハーシェル・クレーターを持つ小さな衛星。',
  },
  {
    id: 'enceladus', ja: 'エンケラドゥス', en: 'Enceladus', type: 'moon', parent: 'saturn', r: 252.1, gm: 7.211,
    albedo: 1.375, color: [0.95, 0.95, 0.96], tex: 'enceladus', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [40.6, 83.5], a: 238037, e: 0.0047, i: 0, node0: 0, nodeRate: 0, u0: 182.2408, n: 262.7318994, w0: 171.23, wRate: 0.338006 } },
    desc: '南極から水を噴き出している、太陽系で最も白い天体。',
  },
  {
    id: 'tethys', ja: 'テティス', en: 'Tethys', type: 'moon', parent: 'saturn', r: 531.1, gm: 41.21,
    albedo: 1.229, color: [0.88, 0.88, 0.88], tex: 'tethys', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [40.6, 83.5], a: 294673, e: 0.0004, i: 1.092, node0: 259.851, nodeRate: -0.197852, u0: 288.4878, n: 190.8957682, w0: 145.87, wRate: 0, lib: [25858.0, 1.6596, -1.2549] } },
    desc: '大きなオデュッセウス・クレーターと長い峡谷を持つ氷の衛星。',
  },
  {
    id: 'dione', ja: 'ディオネ', en: 'Dione', type: 'moon', parent: 'saturn', r: 561.4, gm: 73.11,
    albedo: 0.998, color: [0.82, 0.82, 0.82], tex: 'dione', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [40.6, 83.5], a: 377416, e: 0.0022, i: 0, node0: 0, nodeRate: 0, u0: 176.9066, n: 131.5349303, w0: 214.71, wRate: 0.084256 } },
    desc: '明るい氷の崖が筋のように見える衛星。',
  },
  {
    id: 'rhea', ja: 'レア', en: 'Rhea', type: 'moon', parent: 'saturn', r: 763.8, gm: 153.94,
    albedo: 0.949, color: [0.80, 0.80, 0.80], tex: 'rhea', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [40.6, 83.5], a: 527068, e: 0.0001, i: 0, node0: 0, nodeRate: 0, u0: 52.1687, n: 79.6900455, w0: 218.81, wRate: 0.029041 } },
    desc: '土星で2番目に大きい衛星。',
  },
  {
    id: 'titan', ja: 'タイタン', en: 'Titan', type: 'moon', parent: 'saturn', r: 2574.7, gm: 8978.14,
    albedo: 0.22, color: [0.86, 0.62, 0.30], tex: 'titan', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [36.4, 84.0], a: 1222443, e: 0.0282, i: 0, node0: 0, nodeRate: 0, u0: 11.7582, n: 22.5769732, w0: 195.19, wRate: 0.002843 } },
    atmo: { color: [0.95, 0.65, 0.30], strength: 0.9, heightKm: 400 },
    desc: '濃いオレンジ色の大気を持つ土星最大の衛星。地表にはメタンの湖がある。',
  },
  {
    id: 'iapetus', ja: 'イアペトゥス', en: 'Iapetus', type: 'moon', parent: 'saturn', r: 734.5, gm: 120.51,
    albedo: 0.3, color: [0.60, 0.56, 0.50], tex: 'iapetus', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [288.7, 78.9], a: 3562622, e: 0.0285, i: 7.579, node0: 74.812, nodeRate: -0.000315, u0: 125.4549, n: 4.5382611, w0: 276.54, wRate: 0.000593 } },
    desc: '半球ごとに白と黒にはっきり塗り分けられた不思議な衛星。',
  },
  {
    id: 'uranus', ja: '天王星', en: 'Uranus', type: 'planet', r: 25559, rp: 24973, gm: 5793939,
    albedo: 0.488, color: [0.67, 0.86, 0.90], tex: 'uranus', texLevels: ['1k', '2k'], rot: 'uranus',
    orbit: { kind: 'planet', key: 'uranus' },
    atmo: { color: [0.65, 0.88, 0.95], strength: 0.45, heightKm: 800 },
    rings: { inner: 41800, outer: 51200, kind: 'uranus' },
    desc: '自転軸がほぼ横倒しになった氷の巨大惑星。',
  },
  {
    id: 'miranda', ja: 'ミランダ', en: 'Miranda', type: 'moon', parent: 'uranus', r: 235.8, gm: 4.4,
    albedo: 0.32, color: [0.70, 0.70, 0.70], tex: 'miranda', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [77.311, 15.175], a: 129848, e: 0.0013, i: 4.428, node0: 100.861, nodeRate: -0.055414, u0: 227.9279, n: 254.7460686, w0: 153.56, wRate: 0.110261 } },
    desc: '高さ20kmの断崖ヴェローナ・ルペスがある継ぎはぎ模様の衛星。',
  },
  {
    id: 'ariel', ja: 'アリエル', en: 'Ariel', type: 'moon', parent: 'uranus', r: 578.9, gm: 86.4,
    albedo: 0.53, color: [0.72, 0.72, 0.72], tex: 'ariel', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [77.311, 15.175], a: 190930, e: 0.0001, i: 0, node0: 0, nodeRate: 0, u0: 203.1199, n: 142.8356483, w0: 105.33, wRate: 0.034104 } },
    desc: '天王星の衛星の中で最も明るい表面を持つ。',
  },
  {
    id: 'umbriel', ja: 'ウンブリエル', en: 'Umbriel', type: 'moon', parent: 'uranus', r: 584.7, gm: 81.5,
    albedo: 0.26, color: [0.50, 0.50, 0.50], tex: 'umbriel', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [77.311, 15.175], a: 265986, e: 0.0025, i: 0, node0: 0, nodeRate: 0, u0: 251.2569, n: 86.8688733, w0: 283.41, wRate: 0.015370 } },
    desc: '天王星の衛星の中で最も暗い表面を持つ。',
  },
  {
    id: 'titania', ja: 'チタニア', en: 'Titania', type: 'moon', parent: 'uranus', r: 788.9, gm: 228.2,
    albedo: 0.35, color: [0.66, 0.64, 0.62], tex: 'titania', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [77.311, 15.175], a: 436281, e: 0.0015, i: 0, node0: 0, nodeRate: 0, u0: 281.5657, n: 41.3514149, w0: 240.55, wRate: 0.001700 } },
    desc: '天王星最大の衛星。',
  },
  {
    id: 'oberon', ja: 'オベロン', en: 'Oberon', type: 'moon', parent: 'uranus', r: 761.4, gm: 192.4,
    albedo: 0.31, color: [0.62, 0.58, 0.56], tex: 'oberon', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [77.311, 15.175], a: 583461, e: 0.0013, i: 0, node0: 0, nodeRate: 0, u0: 352.5685, n: 26.7394819, w0: 129.99, wRate: 0.006214 } },
    desc: '天王星の外側の大きな衛星。',
  },
  {
    id: 'neptune', ja: '海王星', en: 'Neptune', type: 'planet', r: 24764, rp: 24341, gm: 6836529,
    albedo: 0.442, color: [0.36, 0.52, 0.95], tex: 'neptune', texLevels: ['1k', '2k'], rot: 'neptune',
    orbit: { kind: 'planet', key: 'neptune' },
    atmo: { color: [0.40, 0.58, 1.0], strength: 0.45, heightKm: 800 },
    desc: '太陽系で最も外側の惑星。太陽系最速の風が吹く。',
  },
  {
    id: 'triton', ja: 'トリトン', en: 'Triton', type: 'moon', parent: 'neptune', r: 1353.4, gm: 1427.6,
    albedo: 0.76, color: [0.82, 0.76, 0.72], tex: 'triton', texLevels: ['1k'], rot: 'tidal',
    orbit: { kind: 'satellite', fit: { pole: [299.36, 43.46], a: 354759, e: 0.0001, i: 156.825, node0: 177.869, nodeRate: 0.001434, u0: 58.5982, n: 61.2586943, w0: 86.96, wRate: 0.001460 } },
    desc: '海王星の自転と逆向きに公転する大きな衛星。窒素の間欠泉がある。',
  },
  {
    id: 'pluto', ja: '冥王星', en: 'Pluto', type: 'dwarf', parent: null, r: 1188.3, gm: 869.6,
    albedo: 0.52, color: [0.82, 0.72, 0.60], tex: 'pluto', texLevels: ['1k'], rot: 'pluto',
    orbit: { kind: 'pluto' },
    atmo: { color: [0.45, 0.65, 1.0], strength: 0.15, heightKm: 150 },
    desc: '準惑星。ハート形の窒素氷の平原（トンボー領域）がある。',
  },
  {
    id: 'charon', ja: 'カロン', en: 'Charon', type: 'moon', parent: 'pluto', r: 606.0, gm: 106.1,
    albedo: 0.38, color: [0.62, 0.60, 0.58], tex: 'charon', texLevels: ['1k'], rot: 'charon',
    orbit: { kind: 'charon', fit: { pole: [132.993, -6.163], a: 19596, e: 0.0002, i: 0, node0: 0, nodeRate: 0, u0: 304.1210, n: 56.3625306, w0: 155.39, wRate: 0 } },
    desc: '冥王星の半分ほどの大きさの衛星。冥王星と互いに同じ面を向け合っている。',
  },
  {
    id: 'ceres', ja: 'ケレス', en: 'Ceres', type: 'dwarf', r: 482.1, rp: 445.9, gm: 62.63,
    albedo: 0.09, color: [0.46, 0.45, 0.43], tex: 'ceres', texLevels: ['2k', '1k'], rot: 'ceres',
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 2.765552595034094, 0.07969229514816586, 10.58802780183462, 80.24862682043221, 73.29421453021587, 274.4193463761342, 0.21430445064843) },
    desc: '小惑星帯最大の天体で準惑星。表面は探査機ドーンの撮影画像。オッカトル・クレーターの白い輝点は塩類の堆積物。',
  },
  {
    id: 'vesta', ja: 'ベスタ', en: 'Vesta', type: 'asteroid', r: 286.3, rp: 223.2, rb: 278.6, gm: 17.29,
    albedo: 0.423, color: [0.62, 0.60, 0.56], tex: 'vesta', texLevels: ['1k'], rot: 'vesta',
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 2.361365965127599, 0.09020374382834395, 7.143925545058711, 103.701293265032, 151.4686478221564, 81.19015607686903, 0.2716183613599909) },
    desc: '小惑星帯で2番目に重い天体。表面は探査機ドーンの撮影画像で、南極には巨大なレアシルビア盆地がある。',
  },
  {
    id: 'pallas', ja: 'パラス', en: 'Pallas', type: 'asteroid', r: 256, rp: 248, gm: 13.63,
    albedo: 0.155, color: [0.52, 0.52, 0.52], tex: 'pallas', texLevels: ['1k'], rot: { periodH: 7.8132214 },
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 2.769559010737709, 0.2307000995648547, 34.93279321851542, 172.8866193357694, 310.9699161652136, 254.2496521742734, 0.2138396029251949) },
    desc: '軌道が大きく傾いた大型の小惑星。表面の地図は簡易表示。',
  },
  {
    id: 'hygiea', ja: 'ヒギエア', en: 'Hygiea', type: 'asteroid', r: 216, gm: 5.78,
    albedo: 0.072, color: [0.40, 0.40, 0.40], tex: 'hygiea', texLevels: ['1k'], rot: { periodH: 13.828 },
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 3.150974033963701, 0.1067092741240963, 3.829529946447122, 283.1198927508594, 312.4242387344704, 252.0344242359649, 0.1762125505792448) },
    desc: 'ほぼ球形の暗い小惑星。表面の地図は簡易表示。',
  },
  {
    id: 'haumea', ja: 'ハウメア', en: 'Haumea', type: 'dwarf', r: 1161, rp: 513, rb: 852, gm: 267.4,
    albedo: 0.66, color: [0.85, 0.84, 0.83], tex: 'haumea', texLevels: ['1k'], rot: { periodH: 3.9154 },
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 43.06029023650952, 0.1944430148898797, 28.20847393040364, 121.7860561329425, 240.6905472508661, 223.2104118812299, 0.003488097731816818) },
    desc: '約4時間で高速自転するため、ラグビーボールのように細長い準惑星。表面の地図は簡易表示。',
  },
  {
    id: 'makemake', ja: 'マケマケ', en: 'Makemake', type: 'dwarf', r: 715, gm: 200,
    albedo: 0.81, color: [0.82, 0.68, 0.55], tex: 'makemake', texLevels: ['1k'], rot: { periodH: 22.8266 },
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 45.57093317300052, 0.1588889953992523, 29.02785603743067, 79.2948338209406, 297.0922733397207, 169.9379962048232, 0.003203850120050116) },
    desc: 'エッジワース・カイパーベルトの準惑星。表面の地図は簡易表示。',
  },
  {
    id: 'eris', ja: 'エリス', en: 'Eris', type: 'dwarf', r: 1163, gm: 1108,
    albedo: 0.96, color: [0.90, 0.89, 0.88], tex: 'eris', texLevels: ['1k'], rot: { periodH: 25.9 * 24 },
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 67.93394687853566, 0.4382385347971672, 43.9258279471791, 36.00477044417249, 150.7949235840312, 211.774434275007, 0.001760247770619088) },
    desc: '冥王星とほぼ同じ大きさの、非常に遠い準惑星。表面の地図は簡易表示。',
  },
  {
    id: 'sedna', ja: 'セドナ', en: 'Sedna', type: 'dwarf', r: 500, gm: 50,
    albedo: 0.32, color: [0.72, 0.45, 0.35], tex: 'makemake', texLevels: ['1k'], rot: { periodH: 10.273 },
    orbit: { kind: 'osculating', el: oscEl(2461200.5, 543.7195289104732, 0.8598824585187618, 11.92527582847476, 144.5061662673739, 311.0987725939751, 358.5956944005428, 7.773948799642578e-5) },
    desc: '太陽から最も遠くまで離れる軌道を持つ天体のひとつ（遠日点 約940au）。',
  },
  {
    id: 'halley', ja: 'ハレー彗星', en: '1P/Halley', type: 'comet', r: 5.5, rp: 4.0, rb: 4.0, gm: 1.5e-8,
    albedo: 0.04, color: [0.35, 0.33, 0.30], tex: 'ceres', texLevels: ['1k'], rot: { periodH: 52.8 },
    orbit: { kind: 'osculating', el: oscEl(2439875.5, 17.92863504856923, 0.9679359956953211, 162.1905300439129, 59.09894720612437, 112.2414314637764, 274.3823371366792, 0.01298324443268444) },
    desc: '約76年周期の彗星。次の近日点通過は2061年。',
  },
];

// =============================================================
// 実行時の状態
// =============================================================
const SolarSystem = {
  bodies: [],   // 定義 + 実行時状態（pos, quat など）
  byId: {},
  jd: 0,
  // v88: 宇宙座標の原点（太陽中心の座標）。艦のいる星系の恒星に付け替える（28-deep-space.js）。
  // pos はすべて「太陽中心の座標 − origin」。太陽の pos は −origin になる
  origin: { x: 0, y: 0, z: 0 },
  _originListeners: [],

  init() {
    this.bodies = SOLAR_BODIES.map((def) => ({
      ...def,
      rM: def.r * 1000,                          // 赤道半径 [m]
      rpM: (def.rp ?? def.r) * 1000,             // 極半径 [m]
      rbM: (def.rb ?? def.r) * 1000,             // 3軸目 [m]（楕円体）
      meanRadiusM: ((def.r + (def.rp ?? def.r) + (def.rb ?? def.r)) / 3) * 1000,
      pos: { x: 0, y: 0, z: 0 },                 // 宇宙座標 [m]
      quat: { x: 0, y: 0, z: 0, w: 1 },          // 天体固定座標(three並び) → 宇宙座標
      rotMat: [1, 0, 0, 0, 1, 0, 0, 0, 1],       // 同上の回転行列（three並び）
      soiM: Infinity,                            // 影響圏の半径 [m]
      children: [],
    }));
    this.byId = {};
    for (const b of this.bodies) this.byId[b.id] = b;
    for (const b of this.bodies) {
      if (b.parent && this.byId[b.parent]) this.byId[b.parent].children.push(b);
    }
    this._computeSoi();
    this.update(SimClock.jd);
  },

  get(id) {
    return this.byId[id] || null;
  },

  // 影響圏（ラプラスの重力圏）半径 = a × (m/M)^(2/5)。ワープの目的地判定や
  // 基準座標系の切り替えに使う。
  _computeSoi() {
    const sun = this.byId.sun;
    for (const b of this.bodies) {
      if (b.id === 'sun') continue;
      const parent = b.parent ? this.byId[b.parent] : sun;
      let aM;
      if (b.orbit.kind === 'planet') aM = Astro.PLANET_ELEMENTS[b.orbit.key].el[0] * Astro.AU;
      else if (b.orbit.kind === 'earth') aM = Astro.AU;
      else if (b.orbit.kind === 'moon') aM = 384400e3;
      else if (b.orbit.kind === 'pluto') aM = Astro.PLANET_ELEMENTS.pluto.el[0] * Astro.AU;
      else if (b.orbit.kind === 'osculating') aM = b.orbit.el.a * Astro.AU;
      else if (b.orbit.kind === 'fixed') { b.soiM = b.systemRadiusM || 1e15; b.orbitRadiusM = 0; continue; } // v88: 系外の恒星
      else if (b.orbit.kind === 'exo') aM = b.orbit.aAU * Astro.AU;
      else aM = b.orbit.fit.a * 1000;
      b.soiM = b.soiFixedM || aM * Math.pow(b.gm / parent.gm, 0.4); // v88: ステーションは決めた値
      b.orbitRadiusM = aM;
    }
  },

  // -----------------------------------------------------------
  // 全天体の位置・姿勢を時刻jd（ユリウス日TT）に更新する
  // -----------------------------------------------------------
  update(jd) {
    this.jd = jd;
    const AU = Astro.AU;
    const toThreeM = (v, scale) => ({ x: v.x * scale, y: v.z * scale, z: -v.y * scale });
    const byId = this.byId;

    // 地球と月（地球月系の重心からの配分）
    const emb = Astro.planetHelioEcl('emb', jd);
    const moonGeo = Astro.moonGeoEclKm(jd);
    const muMoon = 0.0121505856; // 月の質量 / (地球+月)
    const earthEcl = {
      x: emb.x * AU - moonGeo.x * 1000 * muMoon,
      y: emb.y * AU - moonGeo.y * 1000 * muMoon,
      z: emb.z * AU - moonGeo.z * 1000 * muMoon,
    };

    // 冥王星系の重心
    const plutoBary = Astro.planetHelioEcl('pluto', jd);

    for (const b of this.bodies) {
      const o = b.orbit;
      let eclM = null; // 日心黄道座標[m]
      switch (o.kind) {
        case 'origin':
          eclM = { x: 0, y: 0, z: 0 };
          break;
        case 'planet': {
          const p = Astro.planetHelioEcl(o.key, jd);
          eclM = { x: p.x * AU, y: p.y * AU, z: p.z * AU };
          break;
        }
        case 'earth':
          eclM = earthEcl;
          break;
        case 'moon':
          eclM = {
            x: earthEcl.x + moonGeo.x * 1000,
            y: earthEcl.y + moonGeo.y * 1000,
            z: earthEcl.z + moonGeo.z * 1000,
          };
          b.relEcl = { x: moonGeo.x * 1000, y: moonGeo.y * 1000, z: moonGeo.z * 1000 };
          break;
        case 'osculating': {
          const p = Astro.osculatingHelioEcl(o.el, jd);
          eclM = { x: p.x * AU, y: p.y * AU, z: p.z * AU };
          break;
        }
        default:
          break; // 衛星・冥王星系は親の位置が決まってから下で計算する
      }
      if (eclM) b.eclM = eclM;
    }

    // 冥王星とカロン（重心のまわりを互いに回る）
    {
      const pluto = byId.pluto, charon = byId.charon;
      const rel = Astro.fittedSatelliteEclKm(charon.orbit.fit, jd); // 冥王星→カロン [km]
      const fC = charon.gm / (pluto.gm + charon.gm);
      const bx = plutoBary.x * AU, by = plutoBary.y * AU, bz = plutoBary.z * AU;
      pluto.eclM = { x: bx - rel.x * 1000 * fC, y: by - rel.y * 1000 * fC, z: bz - rel.z * 1000 * fC };
      charon.eclM = {
        x: pluto.eclM.x + rel.x * 1000, y: pluto.eclM.y + rel.y * 1000, z: pluto.eclM.z + rel.z * 1000,
      };
      charon.relEcl = { x: rel.x * 1000, y: rel.y * 1000, z: rel.z * 1000 };
    }

    // 通常の衛星（親の位置＋平均軌道要素）
    for (const b of this.bodies) {
      if (b.orbit.kind !== 'satellite') continue;
      const parent = byId[b.parent];
      const rel = Astro.fittedSatelliteEclKm(b.orbit.fit, jd);
      b.relEcl = { x: rel.x * 1000, y: rel.y * 1000, z: rel.z * 1000 };
      b.eclM = {
        x: parent.eclM.x + b.relEcl.x, y: parent.eclM.y + b.relEcl.y, z: parent.eclM.z + b.relEcl.z,
      };
    }

    // 宇宙座標へ変換し、姿勢を計算（v88: 原点を引く。系外の恒星は太陽中心の位置から、
    // その惑星・ステーションは恒星の位置から求める。原点がその恒星なら誤差なく 0 から積み上がる）
    const O = this.origin;
    for (const b of this.bodies) {
      const k = b.orbit.kind;
      if (k === 'fixed') {
        b.pos.x = b.orbit.helio.x - O.x; b.pos.y = b.orbit.helio.y - O.y; b.pos.z = b.orbit.helio.z - O.z;
      } else if (k !== 'exo') {
        const p = toThreeM(b.eclM, 1);
        b.pos.x = p.x - O.x; b.pos.y = p.y - O.y; b.pos.z = p.z - O.z;
      }
    }
    for (const b of this.bodies) {
      if (b.orbit.kind !== 'exo') continue;
      const h = byId[b.parent];
      const r = DeepSpace.exoRel(b, jd);
      b.pos.x = h.pos.x + r.x; b.pos.y = h.pos.y + r.y; b.pos.z = h.pos.z + r.z;
      b.relEcl = Astro.threeToEcl(r);
    }
    for (const b of this.bodies) this._updateOrientation(b, jd);
  },

  // v88: 宇宙座標の原点を付け替える（太陽中心の座標）。登録した関数に、ずれ（新 − 旧）を知らせる
  setOrigin(o) {
    const d = { x: o.x - this.origin.x, y: o.y - this.origin.y, z: o.z - this.origin.z };
    if (d.x === 0 && d.y === 0 && d.z === 0) return;
    this.origin = { x: o.x, y: o.y, z: o.z };
    this.update(this.jd);
    for (const fn of this._originListeners) fn(d);
  },
  onOriginShift(fn) { this._originListeners.push(fn); },
  // 太陽中心の座標 ⇔ 宇宙座標
  helioToU(p) { return { x: p.x - this.origin.x, y: p.y - this.origin.y, z: p.z - this.origin.z }; },
  uToHelio(p) { return { x: p.x + this.origin.x, y: p.y + this.origin.y, z: p.z + this.origin.z }; },

  // v88: 天体 b を照らす恒星（太陽系の天体は太陽）
  lightOf(b) {
    return this.byId[b.host || (b.type === 'star' ? b.id : 'sun')] || this.byId.sun;
  },
  // 点 p（宇宙座標）でいちばん明るい恒星（光度 / 距離^2 が最大）
  lightStarAt(p) {
    let best = this.byId.sun, bestF = -1;
    for (const b of this.bodies) {
      if (b.type !== 'star') continue;
      const d2 = (p.x - b.pos.x) ** 2 + (p.y - b.pos.y) ** 2 + (p.z - b.pos.z) ** 2;
      const f = (b.lum ?? 1) / Math.max(d2, 1);
      if (f > bestF) { bestF = f; best = b; }
    }
    return best;
  },

  _updateOrientation(b, jd) {
    let eclMat = null; // 天体固定座標(x=経度0, z=北極) → 黄道座標
    if (b.rot === 'tidal') {
      eclMat = this._tidalMatrix(b, jd);
    } else if (typeof b.rot === 'string') {
      const ang = Astro.rotationAngles(b.rot, jd);
      if (ang) eclMat = Astro.bodyToEclMatrix(ang[0], ang[1], ang[2]);
    } else if (b.rot && b.rot.periodH) {
      // 自転軸は黄道の北極、自転周期だけ反映する簡易モデル
      const W = ((jd - SOLAR_EPOCH_J2000) * 24 / b.rot.periodH) * 360;
      eclMat = Astro.mat3RotZ(W * Astro.DEG);
    }
    if (!eclMat) eclMat = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // three並び: M · eclMat · M^-1
    const m = Astro.mat3Mul(Astro.THREE_FROM_ECL, Astro.mat3Mul(eclMat, Astro.ECL_FROM_THREE));
    b.rotMat = m;
    b.quat = Astro.quatFromMat3(m);
    // 自転軸（北極方向）の宇宙座標ベクトル = 天体固定のthree並び+Y の行き先
    b.poleThree = { x: m[1], y: m[4], z: m[7] };
  },

  // 潮汐固定の衛星: 経度0°（テクスチャ中央）を常に親天体へ向け、
  // 自転軸は公転面の法線にそろえる。
  _tidalMatrix(b, jd) {
    const r = b.relEcl;
    if (!r) return null;
    // 公転面の法線（少し先の時刻との外積）
    const periodDays = b.orbit.fit ? 360 / Math.abs(b.orbit.fit.n) : b.orbit.pDays || 27.32;
    const dt = Math.max(1e-5, periodDays * 0.002);
    let r2;
    if (b.orbit.kind === 'exo') {
      r2 = Astro.threeToEcl(DeepSpace.exoRel(b, jd + dt));
    } else if (b.orbit.kind === 'moon') {
      const m = Astro.moonGeoEclKm(jd + dt);
      r2 = { x: m.x * 1000, y: m.y * 1000, z: m.z * 1000 };
    } else {
      const rel = Astro.fittedSatelliteEclKm(b.orbit.fit, jd + dt);
      r2 = { x: rel.x * 1000, y: rel.y * 1000, z: rel.z * 1000 };
    }
    let zx = r.y * r2.z - r.z * r2.y;
    let zy = r.z * r2.x - r.x * r2.z;
    let zz = r.x * r2.y - r.y * r2.x;
    let zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    // x軸 = 衛星から親へ向かう方向を、法線に直交化
    let xl = Math.hypot(r.x, r.y, r.z) || 1;
    let xx = -r.x / xl, xy = -r.y / xl, xz = -r.z / xl;
    const d = xx * zx + xy * zy + xz * zz;
    xx -= d * zx; xy -= d * zy; xz -= d * zz;
    xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return Astro.mat3FromColumns({ x: xx, y: xy, z: xz }, { x: yx, y: yy, z: yz }, { x: zx, y: zy, z: zz });
  },

  // -----------------------------------------------------------
  // 便利関数
  // -----------------------------------------------------------
  // 宇宙座標の点 p から最も近い天体（表面までの距離が最小）
  nearestBody(p, filter) {
    let best = null, bestD = Infinity;
    for (const b of this.bodies) {
      if (filter && !filter(b)) continue;
      const d = Math.hypot(p.x - b.pos.x, p.y - b.pos.y, p.z - b.pos.z) - b.rM;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best ? { body: best, surfaceDist: bestD } : null;
  },

  // 宇宙座標の点 p が影響圏に入っている「最も内側の」天体（無ければ太陽）
  dominantBody(p) {
    let best = this.byId.sun, bestSoi = Infinity;
    for (const b of this.bodies) {
      if (b.id === 'sun') continue;
      const d = Math.hypot(p.x - b.pos.x, p.y - b.pos.y, p.z - b.pos.z);
      if (d < b.soiM && b.soiM < bestSoi) { best = b; bestSoi = b.soiM; }
    }
    return best;
  },

  distance(p, b) {
    return Math.hypot(p.x - b.pos.x, p.y - b.pos.y, p.z - b.pos.z);
  },
};
