// =============================================================
// 15-universe-render.js
// 宇宙の描画: 星空（ヒッパルコス星表）・天の川（ESOの全天写真）・
// 太陽系の天体（実寸・実際の位置と自転）
//
// v77: 従来はランダムな点を20000単位の箱にばらまいただけの背景だった
// ものを、実在の宇宙に置き換える。
//
// 描画の仕組み:
//   - 天体の座標は太陽中心で 1e12 m（数十億km）を超えるため、Three.js の
//     float32 では精度が足りない。そこで「カメラ中心の座標」（各天体の
//     位置からカメラの位置を倍精度で引いた値）だけを GPU に渡す。
//     カメラ自体は常に原点に置き、向きだけを持たせる。
//   - 近い天体と遠い天体の距離の比が極端なので、カメラの near/far を
//     毎フレーム「いちばん近い天体の表面までの距離」から決め直す。
//   - 描画順: 星空（無限遠）→ 天体 → （index.html側で深度をクリアして）
//     艦・ドッキングポートなどのローカルシーン。
//   - 画面上で数ピクセル未満になる遠い天体は、等級に応じた光点として描く
//     （地球軌道から見た木星や金星が明るい星のように見える）。
//
// このファイルはカメラの「宇宙での位置・向き」を setView() で受け取る
// だけで、艦の座標系（16-navigation.js）や星図（19-star-map.js）には
// 依存しない。
// =============================================================

const UNIVERSE_TEX_DIR = 'textures/';

// -------------------------------------------------------------
// テクスチャの段階読み込み（表示サイズに応じて 1k/2k/4k を必要な分だけ）
// -------------------------------------------------------------
const TextureLOD = {
  _cache: {},
  _loader: null,
  _maxLevel: '4k',
  LEVELS: ['1k', '2k', '4k'],

  init(maxLevel) {
    this._loader = new THREE.TextureLoader();
    this._maxLevel = maxLevel || '4k';
  },

  // name_level のテクスチャを返す（未読み込みなら読み込みを開始して null）
  request(name, level, opts) {
    const key = `${name}_${level}`;
    let entry = this._cache[key];
    if (!entry) {
      entry = { status: 'loading', tex: null };
      this._cache[key] = entry;
      const url = `${UNIVERSE_TEX_DIR}${key}${(opts && opts.ext) || '.jpg'}`;
      this._loader.load(
        url,
        (tex) => {
          tex.anisotropy = 4;
          if (opts && opts.wrapS) tex.wrapS = opts.wrapS;
          entry.tex = tex;
          entry.status = 'ready';
        },
        undefined,
        () => {
          entry.status = 'error';
          console.warn(`テクスチャの読み込みに失敗しました: ${url}`);
        }
      );
    }
    entry.lastUsed = performance.now();
    return entry.status === 'ready' ? entry.tex : null;
  },

  // available（用意されている段階）のうち、wanted 以下で読み込み済みの最高解像度を返し、
  // wanted がまだなら読み込みを開始する。
  best(name, available, wanted) {
    const maxIdx = this.LEVELS.indexOf(this._maxLevel);
    let wantIdx = Math.min(this.LEVELS.indexOf(wanted), maxIdx);
    // 用意されていない段階は、用意されている中で最も近い下位へ
    while (wantIdx > 0 && !available.includes(this.LEVELS[wantIdx])) wantIdx--;
    if (!available.includes(this.LEVELS[wantIdx])) return null;
    const tex = this.request(name, this.LEVELS[wantIdx]);
    if (tex) return tex;
    for (let i = wantIdx - 1; i >= 0; i--) {
      const lv = this.LEVELS[i];
      if (!available.includes(lv)) continue;
      const t = this.request(name, lv);
      if (t) return t;
    }
    return null;
  },
};

// -------------------------------------------------------------
// シェーダー共通部品
// -------------------------------------------------------------
const UNIVERSE_GLSL_COMMON = `
  vec3 srgbToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
  vec3 linearToSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
  // 太陽の円盤が球(中心c,半径r)にどれだけ隠されるか（0=隠れない,1=全部）の近似。
  // p:評価点, L:太陽方向, sunAng:太陽の視半径[rad]
  float occlusion(vec3 p, vec3 L, vec4 occ, float sunAng) {
    vec3 toC = occ.xyz - p;
    float d = dot(toC, L);
    if (d <= 0.0) return 0.0;
    float dist = length(toC);
    float occAng = asin(clamp(occ.w / dist, 0.0, 1.0));
    float sep = acos(clamp(d / dist, -1.0, 1.0));
    // 2つの円（太陽と遮蔽物）の重なり具合を滑らかに近似
    float t = (sep - abs(occAng - sunAng)) / max(1e-6, (occAng + sunAng) - abs(occAng - sunAng));
    float overlap = 1.0 - smoothstep(0.0, 1.0, t);
    float maxCover = min(1.0, (occAng * occAng) / max(1e-12, sunAng * sunAng));
    return overlap * maxCover;
  }
`;

// 天体の表面（地球型の夜景・海の反射、環の影、他天体の影つき）
const PLANET_VERT = `
  uniform vec3 uScale;
  varying vec2 vUv;
  varying vec3 vPos;     // 天体ローカル（最大半径=1の単位）
  varying vec3 vNormal;  // 天体ローカルの法線
  void main() {
    vUv = uv;
    vPos = position * uScale;
    vNormal = normalize(position / uScale);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLANET_FRAG = `
  ${UNIVERSE_GLSL_COMMON}
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3 uBaseColor;
  uniform vec3 uSunDir;       // 天体ローカル、太陽への単位ベクトル
  uniform float uSunAng;      // 太陽の視半径 [rad]
  uniform float uSunIntensity;
  uniform vec3 uCamPos;       // 天体ローカル（最大半径=1）
  uniform float uKind;        // 0=岩石(大気なし) 1=大気あり 2=ガス惑星 3=地球
  uniform vec3 uAtmoColor;
  uniform float uAtmoStrength;
  uniform sampler2D uNight;
  uniform sampler2D uOcean;
  uniform float uHasNight;
  uniform float uHasOcean;
  uniform vec4 uOcc[4];       // 影を落とす天体（天体ローカル中心, 半径）
  uniform float uOccCount;
  uniform sampler2D uRingMap; // 環の影
  uniform float uHasRing;
  uniform vec2 uRingRange;    // 環の内径・外径（最大半径=1の単位）
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vNormal;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(uCamPos - vPos);
    float NdotL = dot(N, L);
    float NdotV = max(dot(N, V), 0.0);

    vec3 albedo = uHasMap > 0.5 ? srgbToLinear(texture2D(uMap, vUv).rgb) : srgbToLinear(uBaseColor);

    // 拡散反射
    float diffuse;
    if (uKind < 0.5) {
      // 大気の無い岩石天体: ロンメル=ゼーリガー則（満月が「平たく」明るく見える性質）とランバートの混合
      float mu0 = max(NdotL, 0.0);
      float ls = mu0 / max(mu0 + NdotV, 1e-4);
      diffuse = mix(mu0, 2.0 * ls, 0.65);
    } else {
      // 大気のある天体は明暗境界がわずかに柔らかい
      diffuse = clamp((NdotL + 0.04) / 1.04, 0.0, 1.0);
      if (uKind > 1.5 && uKind < 2.5) diffuse *= pow(max(NdotV, 0.02), 0.18); // ガス惑星の周縁減光
    }

    // 他の天体の影（衛星の影・日食・月食）
    float shadow = 1.0;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uOccCount) break;
      shadow *= 1.0 - occlusion(vPos, L, uOcc[i], uSunAng);
    }
    // 環の影（土星）
    if (uHasRing > 0.5 && abs(L.y) > 1e-4) {
      float t = -vPos.y / L.y;
      if (t > 0.0) {
        vec3 h = vPos + L * t;
        float r = length(h.xz);
        float u = (r - uRingRange.x) / (uRingRange.y - uRingRange.x);
        if (u > 0.0 && u < 1.0) {
          float a = texture2D(uRingMap, vec2(u, 0.5)).a;
          shadow *= 1.0 - a * 0.85;
        }
      }
    }

    vec3 color = albedo * diffuse * shadow * uSunIntensity;

    if (uKind > 2.5) {
      // 地球: 海の太陽反射、夜側の街明かり
      float day = smoothstep(-0.10, 0.12, NdotL);
      if (uHasOcean > 0.5) {
        float ocean = texture2D(uOcean, vUv).r;
        vec3 H = normalize(L + V);
        float spec = pow(max(dot(N, H), 0.0), 80.0);
        float fres = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
        color += vec3(1.0, 0.95, 0.85) * spec * ocean * (0.9 + fres) * shadow * uSunIntensity * step(0.0, NdotL);
      }
      if (uHasNight > 0.5) {
        vec3 lights = srgbToLinear(texture2D(uNight, vUv).rgb);
        color += lights * (1.0 - day) * 1.6;
      }
    }

    // 大気による周縁のかすみ（青い縁取り）
    if (uAtmoStrength > 0.0) {
      float haze = pow(1.0 - NdotV, 3.0) * uAtmoStrength;
      float lit = smoothstep(-0.25, 0.4, NdotL) * shadow;
      color = mix(color, srgbToLinear(uAtmoColor) * lit * uSunIntensity, clamp(haze, 0.0, 0.85));
    }

    gl_FragColor = vec4(linearToSrgb(color), 1.0);
  }
`;

// 雲（地球）
const CLOUD_FRAG = `
  ${UNIVERSE_GLSL_COMMON}
  uniform sampler2D uClouds;
  uniform vec3 uSunDir;
  uniform float uSunAng;
  uniform float uSunIntensity;
  uniform vec3 uCamPos;
  uniform vec4 uOcc[4];
  uniform float uOccCount;
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunDir);
    float NdotL = dot(N, L);
    float c = texture2D(uClouds, vUv).r;
    float shadow = 1.0;
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uOccCount) break;
      shadow *= 1.0 - occlusion(vPos, L, uOcc[i], uSunAng);
    }
    float lit = clamp((NdotL + 0.06) / 1.06, 0.0, 1.0) * shadow;
    // 夕焼けの赤み
    vec3 tint = mix(vec3(1.0, 0.55, 0.35), vec3(1.0), smoothstep(0.0, 0.25, NdotL));
    vec3 col = tint * lit * uSunIntensity;
    float alpha = smoothstep(0.08, 0.9, c) * 0.95;
    gl_FragColor = vec4(linearToSrgb(col), alpha);
  }
`;

// 大気の光芒（惑星の縁の光る層）
const ATMO_FRAG = `
  ${UNIVERSE_GLSL_COMMON}
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform vec3 uAtmoColor;
  uniform float uAtmoStrength;
  uniform float uSunIntensity;
  uniform float uLimbT;     // 惑星本体の縁に相当する N・V の値
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCamPos - vPos);
    vec3 L = normalize(uSunDir);
    float t = max(dot(N, V), 0.0);
    // 本体の縁あたりで最も明るく、外側(t→0)と内側(t→1)に向かって弱まる
    float w = max(uLimbT, 0.06);
    float g = exp(-pow((t - uLimbT) / w, 2.0)) * 0.9 + (1.0 - t) * 0.12;
    float sun = smoothstep(-0.35, 0.5, dot(N, L));
    // 昼夜境界の外側は夕焼け色に
    vec3 col = mix(vec3(1.0, 0.5, 0.3), uAtmoColor, smoothstep(-0.18, 0.08, dot(N, L)));
    float a = g * sun * uAtmoStrength;
    gl_FragColor = vec4(col * a * uSunIntensity, 1.0);
  }
`;

// 環（土星・天王星）
const RING_VERT = `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const RING_FRAG = `
  ${UNIVERSE_GLSL_COMMON}
  uniform sampler2D uRingMap;
  uniform float uHasMap;
  uniform vec2 uRingRange;     // 惑星の赤道半径=1 の単位
  uniform vec3 uSunDir;        // 天体ローカル
  uniform vec3 uCamPos;        // 天体ローカル（赤道半径=1）
  uniform float uSunIntensity;
  uniform float uPlanetPolar;  // 極半径/赤道半径
  uniform vec3 uTint;
  varying vec3 vPos;
  void main() {
    float r = length(vPos.xz);
    float u = (r - uRingRange.x) / (uRingRange.y - uRingRange.x);
    if (u < 0.0 || u > 1.0) discard;
    vec4 tex = uHasMap > 0.5 ? texture2D(uRingMap, vec2(u, 0.5)) : vec4(uTint, 0.0);
    float alpha = tex.a;
    if (alpha < 0.01) discard;
    vec3 L = normalize(uSunDir);
    // 惑星の影（円柱で近似。極方向のつぶれも考慮）
    float shadow = 1.0;
    float along = dot(vPos, L);
    if (along < 0.0) {
      vec3 perp = vPos - L * along;
      vec3 q = vec3(perp.x, perp.y / uPlanetPolar, perp.z);
      shadow = smoothstep(0.98, 1.02, length(q));
    }
    // 太陽に照らされた面とその裏側（裏側は透過光でうっすら光る）
    float sunSide = sign(L.y);
    float camSide = sign(uCamPos.y - vPos.y);
    float lit = sunSide == camSide ? 1.0 : 0.25 + 0.35 * (1.0 - alpha);
    vec3 col = srgbToLinear(tex.rgb) * lit * shadow * uSunIntensity * (0.35 + 0.65 * abs(L.y) * 0.0 + 0.65);
    gl_FragColor = vec4(linearToSrgb(col), alpha);
  }
`;

// 太陽の表面（周縁減光つき）
const SUN_FRAG = `
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3 uCamPos;
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCamPos - vPos);
    float mu = max(dot(N, V), 0.0);
    // 周縁減光（中心が明るく縁が暗い）。縁ほど赤みが増す
    float limb = 1.0 - 0.62 * (1.0 - mu) - 0.2 * (1.0 - mu) * (1.0 - mu);
    vec3 tex = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : vec3(1.0, 0.8, 0.5);
    vec3 warm = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.92, 0.75), mu);
    vec3 col = (0.55 + 0.75 * tex) * warm * limb * 1.15;
    gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
  }
`;

// 太陽のまぶしさ（画面上の光芒）
const GLOW_VERT = `
  uniform float uSizePx;
  uniform vec2 uViewport;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 offset = position.xy * uSizePx / uViewport * 2.0 * clip.w;
    gl_Position = clip + vec4(offset, 0.0, 0.0);
  }
`;
const GLOW_FRAG = `
  uniform float uIntensity;
  uniform float uCoreScale;   // 太陽の円盤が大きく見えるときは中心の白飛びを抑える
  uniform float uDiscR;       // 太陽の円盤の半径（光芒の板の半径を1とした割合）
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    // 円盤の縁から外側へ向かって減衰させる（円盤が小さいときは普通の星の光芒）
    float rr = max(0.0, r - uDiscR) / max(1e-3, 1.0 - uDiscR);
    float core = exp(-rr * rr * 60.0) * uCoreScale;
    float halo = exp(-rr * 7.0) * 0.55 + pow(max(0.0, 1.0 - rr), 3.0) * 0.12;
    float ang = atan(d.y, d.x);
    float rays = pow(abs(cos(ang * 2.0)), 60.0) * exp(-rr * 3.0) * 0.35;
    float onDisc = r < uDiscR ? 0.12 : 1.0;
    float v = (core + halo + rays) * uIntensity * smoothstep(1.0, 0.8, r) * onDisc;
    gl_FragColor = vec4(uColor * v, 1.0);
  }
`;

// 星（点光源）: 等級から明るさと大きさを決める。observer を動かすと
// 近い星ほど方向と明るさが変わる（恒星間を移動したときの見え方）。
const STAR_VERT = `
  attribute float aMag;
  attribute float aDist;   // パーセク。0 = 距離不明（無限遠扱い）
  attribute vec3 aColor;
  uniform vec3 uObserver;  // 太陽から見た観測者の位置 [pc]（宇宙座標の軸）
  uniform float uMagOffset;
  uniform float uPixelRatio;
  uniform float uFluxScale;
  uniform float uMode;     // 0=天球（無限遠）, 1=3D（星図の近傍恒星表示）
  uniform float uPcScale;  // 3D表示時: 1pc あたりのシーン単位
  uniform float uMinMag;
  uniform float uMagClamp;
  varying vec3 vColor;
  varying float vPeak;
  void main() {
    vec3 dir = position;
    float mag = aMag;
    vec3 rel = position;
    if (aDist > 0.0) {
      rel = position * aDist - uObserver;
      float d = max(length(rel), 1e-6);
      dir = rel / d;
      mag += 5.0 * log(d / aDist) / 2.302585;
    }
    mag = max(mag, uMinMag) - uMagOffset;
    // 星図（3D表示）では、遠くの暗い星も最低限の点として見えるようにする
    if (uMode > 0.5) mag = min(mag, uMagClamp);
    float flux = pow(10.0, -0.4 * mag) * uFluxScale;
    float sigma0 = 0.62 * uPixelRatio;
    float peak0 = flux / (6.2832 * sigma0 * sigma0);
    // 明るい星は「より大きく」見せる（ピークは飽和させ、にじみを広げる）
    float sigma = sigma0 * max(1.0, pow(max(peak0, 1e-6), 0.32));
    vPeak = min(1.0, flux / (6.2832 * sigma * sigma));
    vColor = aColor;
    vec4 mv;
    if (uMode < 0.5) {
      mv = modelViewMatrix * vec4(dir, 1.0);
    } else {
      if (aDist <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      mv = modelViewMatrix * vec4(rel * uPcScale, 1.0);
    }
    gl_Position = projectionMatrix * mv;
    gl_PointSize = vPeak < 0.004 ? 0.0 : sigma * 6.0;
  }
`;
const STAR_FRAG = `
  varying vec3 vColor;
  varying float vPeak;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d) * 36.0; // σ単位の距離の二乗
    float g = exp(-0.5 * r2);
    if (g < 0.01) discard;
    gl_FragColor = vec4(vColor * vPeak * g, 1.0);
  }
`;

// 天の川（全天写真）
const MILKYWAY_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const MILKYWAY_FRAG = `
  uniform sampler2D uMap;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(uMap, vUv).rgb;
    // 写真の背景のわずかなかぶりを落とし、暗い部分を締める
    c = max(c - vec3(0.018), vec3(0.0)) * uIntensity;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// 遠い天体（惑星・衛星）の光点
// ワープ中の光の筋（進行方向から放射状に流れる）
const WARP_VERT = `
  attribute vec3 aDir;     // 進行方向を+Zとした座標系での方向（単位ベクトル）
  attribute float aPhase;  // 0..1 流れの位相
  attribute float aEnd;    // 0=筋の後端, 1=先端
  uniform mat3 uBasis;     // 進行方向の座標系 → 宇宙座標
  uniform float uTime;
  uniform float uLength;
  varying float vFade;
  void main() {
    float t = fract(aPhase + uTime);
    // 進行方向の近くから外側へ流れる: 角度を t とともに広げる
    vec3 d = normalize(vec3(aDir.xy * (0.15 + 2.2 * t * t + aEnd * uLength * (0.2 + t)), 1.0));
    vec3 w = uBasis * d;
    vFade = smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.75, 1.0, t)) * (0.35 + 0.65 * aEnd);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 1.0);
  }
`;
const WARP_FRAG = `
  uniform float uIntensity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(vec3(0.65, 0.8, 1.0) * vFade * uIntensity, 1.0);
  }
`;

const BODYPOINT_VERT = `
  attribute float aMag;
  attribute vec3 aColor;
  attribute float aAlpha;
  uniform float uPixelRatio;
  uniform float uFluxScale;
  uniform float uMagOffset;
  varying vec3 vColor;
  varying float vPeak;
  void main() {
    float mag = aMag - uMagOffset;
    float flux = pow(10.0, -0.4 * mag) * uFluxScale;
    float sigma0 = 0.7 * uPixelRatio;
    float peak0 = flux / (6.2832 * sigma0 * sigma0);
    // 惑星・衛星の光点は、明るくても恒星ほど大きくにじませない（最大で基本の2.6倍）
    float sigma = sigma0 * clamp(pow(max(peak0, 1e-6), 0.32), 1.0, 2.6);
    vPeak = min(1.0, flux / (6.2832 * sigma * sigma)) * aAlpha;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (aAlpha <= 0.0 || vPeak < 0.003) ? 0.0 : sigma * 6.0;
  }
`;

// =============================================================
// 星の色（B-V色指数 → 色温度 → RGB）
// =============================================================
function starColorFromBV(bv) {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  // Ballesteros (2012) の式で色温度へ
  const T = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  // 黒体の色（Tanner Helland の近似）
  const t = T / 100;
  let r, g, bl;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    bl = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    bl = 255;
  }
  const c = [r, g, bl].map((v) => Math.max(0, Math.min(255, v)) / 255);
  // 肉眼で見た印象に近づけるため、白へ少し寄せる
  const mix = 0.35;
  return c.map((v) => v * (1 - mix) + mix);
}

// =============================================================
// 星表の展開
// =============================================================
const StarCatalog = {
  count: 0,
  dirs: null,     // Float32Array（宇宙座標の単位ベクトル）
  mags: null,     // Float32Array（太陽から見たV等級）
  dists: null,    // Float32Array（pc, 0=不明）
  colors: null,   // Float32Array（RGB）
  names: [],      // { index, en, ja, bayer }
  nameByIndex: {},

  load() {
    if (typeof STAR_CATALOG_DATA === 'undefined') {
      console.warn('星表データ(data/star-catalog.js)が読み込まれていません。');
      return;
    }
    const data = STAR_CATALOG_DATA;
    const bin = atob(data.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const n = data.count;
    this.count = n;
    this.dirs = new Float32Array(n * 3);
    this.mags = new Float32Array(n);
    this.dists = new Float32Array(n);
    this.colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      const ra = (view.getUint16(o, true) / 65536) * 360;
      const dec = (view.getInt16(o + 2, true) / 32767) * 90;
      const v = view.getUint8(o + 4) / 20 - 2;
      const bv = view.getInt8(o + 5) / 50;
      const plx = view.getUint16(o + 6, true) * 0.05; // mas
      const d = Astro.radecToThree(ra, dec);
      this.dirs[i * 3] = d.x;
      this.dirs[i * 3 + 1] = d.y;
      this.dirs[i * 3 + 2] = d.z;
      this.mags[i] = v;
      this.dists[i] = plx > 0 ? 1000 / plx : 0;
      const c = starColorFromBV(bv);
      this.colors[i * 3] = c[0];
      this.colors[i * 3 + 1] = c[1];
      this.colors[i * 3 + 2] = c[2];
    }
    this.names = data.names.map(([index, en, ja, bayer]) => ({ index, en, ja, bayer }));
    this.nameByIndex = {};
    for (const nm of this.names) this.nameByIndex[nm.index] = nm;
  },

  displayName(index) {
    const nm = this.nameByIndex[index];
    if (!nm) return null;
    return nm.ja || nm.en;
  },
};

// =============================================================
// 本体
// =============================================================
const Universe = {
  ready: false,
  scene: null,
  skyScene: null,
  camera: null,
  skyCamera: null,
  _renderer: null,
  _views: {},
  _sphereGeo: null,
  _sphereGeoLow: null,
  _view: null,         // setView() で受け取った現在の視点
  _sunGlow: null,
  _bodyPoints: null,
  _starPoints: null,
  _milkyWay: null,
  _localLights: null,
  _orbitLines: {},
  settings: {
    showOrbits: false,      // 飛行中の軌道線
    milkyWayIntensity: 0.85,
    starBrightness: 1.0,
  },
  // 他の処理から参照する、直近フレームの計算結果
  frameInfo: {
    near: 1, far: 1e12,
    sunVisibility: 1,
    bodyScreen: {},  // id → { x, y, onScreen, pxRadius, dist }
  },

  init(renderer, opts) {
    this._renderer = renderer;
    const maxTex = (opts && opts.maxTexture) || '4k';
    TextureLOD.init(maxTex);
    StarCatalog.load();

    this.scene = new THREE.Scene();
    this.skyScene = new THREE.Scene();
    // 光点・太陽の光芒は「方向」だけが重要なので、天球用カメラ（原点・単位球）で
    // 最後に重ねて描く（遠方の座標をGPUに渡すと精度が落ちて形が崩れるため）。
    this.overlayScene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 1, 1e12);
    this.skyCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);

    this._sphereGeo = new THREE.SphereGeometry(1, 128, 64);
    this._sphereGeoLow = new THREE.SphereGeometry(1, 48, 24);

    this._buildMilkyWay(maxTex === '4k' ? '4k' : '2k');
    this._buildStars();
    for (const b of SolarSystem.bodies) this._buildBodyView(b);
    this._buildBodyPoints();
    this._buildSunGlow();
    this._buildWarpStreaks();
    if (typeof GalaxyModel !== 'undefined') GalaxyModel.build(this.scene, (opts && opts.galaxyPoints) || 90000);
    this.ready = true;
  },

  // -----------------------------------------------------------
  // 天の川
  // -----------------------------------------------------------
  _buildMilkyWay(level) {
    const geo = new THREE.SphereGeometry(5, 96, 48);
    // 内側から見るので経度方向を反転（天球図は東が左）
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uIntensity: { value: this.settings.milkyWayIntensity } },
      vertexShader: MILKYWAY_VERT,
      fragmentShader: MILKYWAY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // 球の局所座標を「銀河座標を three 並びにしたもの」とみなし、宇宙座標へ回す
    const m = Astro.mat3Mul(Astro.threeFromGalMatrix(), Astro.ECL_FROM_THREE);
    const q = Astro.quatFromMat3(m);
    mesh.quaternion.set(q.x, q.y, q.z, q.w);
    mesh.renderOrder = -10;
    mesh.frustumCulled = false;
    this.skyScene.add(mesh);
    this._milkyWay = mesh;
    const loader = new THREE.TextureLoader();
    loader.load(`${UNIVERSE_TEX_DIR}milkyway_${level}.jpg`, (tex) => {
      tex.anisotropy = 4;
      mat.uniforms.uMap.value = tex;
    }, undefined, () => {
      if (level === '4k') this._buildMilkyWayFallback(mat);
    });
  },

  _buildMilkyWayFallback(mat) {
    new THREE.TextureLoader().load(`${UNIVERSE_TEX_DIR}milkyway_2k.jpg`, (tex) => {
      mat.uniforms.uMap.value = tex;
    });
  },

  // -----------------------------------------------------------
  // 星
  // -----------------------------------------------------------
  _buildStars() {
    const n = StarCatalog.count;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(StarCatalog.dirs, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(StarCatalog.mags, 1));
    geo.setAttribute('aDist', new THREE.BufferAttribute(StarCatalog.dists, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(StarCatalog.colors, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e30);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uObserver: { value: new THREE.Vector3() },
        uMagOffset: { value: 0 },
        uPixelRatio: { value: 1 },
        uFluxScale: { value: 40 },
        uMode: { value: 0 },
        uPcScale: { value: 1 },
        uMinMag: { value: -30 },
        uMagClamp: { value: 99 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -5;
    this.skyScene.add(pts);
    this._starPoints = pts;
    this._starCount = n;

    // 星図用: 同じ星表を実際の3D位置（距離のわかる星のみ）に置いたもの
    const mat3d = mat.clone();
    mat3d.uniforms.uMode.value = 1;
    mat3d.uniforms.uPcScale.value = Astro.PC;
    mat3d.uniforms.uMagClamp.value = 6.0;
    mat3d.depthTest = false;
    const pts3d = new THREE.Points(geo, mat3d);
    pts3d.frustumCulled = false;
    pts3d.renderOrder = 6;
    pts3d.visible = false;
    this.scene.add(pts3d);
    this._stars3D = pts3d;
  },

  // -----------------------------------------------------------
  // 天体1つぶんの描画オブジェクト
  // -----------------------------------------------------------
  _buildBodyView(b) {
    const group = new THREE.Group();
    group.visible = false;
    this.scene.add(group);
    const view = { body: b, group, mesh: null, clouds: null, atmo: null, ring: null, mat: null, texLevel: null };

    const maxR = Math.max(b.rM, b.rpM, b.rbM);
    const scale = new THREE.Vector3(b.rM / maxR, b.rpM / maxR, b.rbM / maxR);
    view.maxR = maxR;

    if (b.type === 'star') {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: null }, uHasMap: { value: 0 }, uCamPos: { value: new THREE.Vector3() }, uScale: { value: scale } },
        vertexShader: PLANET_VERT,
        fragmentShader: SUN_FRAG,
      });
      view.mesh = new THREE.Mesh(this._sphereGeo, mat);
      view.mat = mat;
    } else {
      let kind = 0;
      if (b.id === 'earth') kind = 3;
      else if (['jupiter', 'saturn', 'uranus', 'neptune'].includes(b.id)) kind = 2;
      else if (b.atmo) kind = 1;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: null }, uHasMap: { value: 0 },
          uBaseColor: { value: new THREE.Color(b.color[0], b.color[1], b.color[2]) },
          uSunDir: { value: new THREE.Vector3(1, 0, 0) },
          uSunAng: { value: 0.005 },
          uSunIntensity: { value: 1 },
          uCamPos: { value: new THREE.Vector3() },
          uKind: { value: kind },
          uAtmoColor: { value: new THREE.Color(...(b.atmo ? b.atmo.color : [0, 0, 0])) },
          uAtmoStrength: { value: b.atmo ? b.atmo.strength * 0.55 : 0 },
          uNight: { value: null }, uOcean: { value: null },
          uHasNight: { value: 0 }, uHasOcean: { value: 0 },
          uOcc: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
          uOccCount: { value: 0 },
          uRingMap: { value: null }, uHasRing: { value: 0 },
          uRingRange: { value: new THREE.Vector2(1.2, 2.3) },
          uScale: { value: scale },
        },
        vertexShader: PLANET_VERT,
        fragmentShader: PLANET_FRAG,
      });
      view.mesh = new THREE.Mesh(this._sphereGeo, mat);
      view.mat = mat;

      if (b.earthLike) {
        const cmat = new THREE.ShaderMaterial({
          uniforms: {
            uClouds: { value: null },
            uSunDir: { value: new THREE.Vector3(1, 0, 0) },
            uSunAng: { value: 0.005 },
            uSunIntensity: { value: 1 },
            uCamPos: { value: new THREE.Vector3() },
            uOcc: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
            uOccCount: { value: 0 },
            uScale: { value: scale },
          },
          vertexShader: PLANET_VERT,
          fragmentShader: CLOUD_FRAG,
          transparent: true,
          depthWrite: false,
        });
        view.clouds = new THREE.Mesh(this._sphereGeo, cmat);
        view.clouds.scale.setScalar(1 + 12 / b.r); // 雲頂 約12km
        view.clouds.renderOrder = 2;
        view.clouds.visible = false;
        group.add(view.clouds);
      }

      if (b.atmo) {
        const shellScale = 1 + b.atmo.heightKm / b.r;
        const amat = new THREE.ShaderMaterial({
          uniforms: {
            uSunDir: { value: new THREE.Vector3(1, 0, 0) },
            uCamPos: { value: new THREE.Vector3() },
            uAtmoColor: { value: new THREE.Color(...b.atmo.color) },
            uAtmoStrength: { value: b.atmo.strength },
            uSunIntensity: { value: 1 },
            uLimbT: { value: Math.sqrt(Math.max(0, 1 - 1 / (shellScale * shellScale))) },
            uScale: { value: scale },
          },
          vertexShader: PLANET_VERT,
          fragmentShader: ATMO_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        view.atmo = new THREE.Mesh(this._sphereGeo, amat);
        view.atmo.scale.setScalar(shellScale);
        view.atmo.renderOrder = 3;
        view.atmoShellScale = shellScale;
        group.add(view.atmo);
      }

      if (b.rings) this._buildRings(view, b, scale);
    }
    view.mesh.renderOrder = 0;
    group.add(view.mesh);
    // 回転はgroup全体（天体固定座標）、つぶれ（扁平率）はメッシュ側の拡大率で表す
    view.mesh.scale.copy(scale);
    if (view.clouds) view.clouds.scale.multiply(scale);
    if (view.atmo) view.atmo.scale.multiply(scale);
    this._views[b.id] = view;
  },

  _buildRings(view, b, scale) {
    const R = b.r;
    const inner = b.rings.inner / R;
    const outer = b.rings.outer / R;
    const geo = new THREE.RingGeometry(inner, outer, 256, 1);
    geo.rotateX(-Math.PI / 2); // XY平面 → XZ平面（赤道面）
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uRingMap: { value: null }, uHasMap: { value: 0 },
        uRingRange: { value: new THREE.Vector2(inner, outer) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uCamPos: { value: new THREE.Vector3() },
        uSunIntensity: { value: 1 },
        uPlanetPolar: { value: b.rp / b.r },
        uTint: { value: new THREE.Color(0.5, 0.5, 0.5) },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.renderOrder = 1;
    // 環のメッシュは赤道半径=1単位で作っているので、天体のつぶれとは無関係に等倍
    view.ring = ring;
    view.group.add(ring);
    if (b.rings.tex) {
      new THREE.TextureLoader().load(`${UNIVERSE_TEX_DIR}${b.rings.tex}.png`, (tex) => {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        mat.uniforms.uRingMap.value = tex;
        mat.uniforms.uHasMap.value = 1;
        view.mat.uniforms.uRingMap.value = tex;
        view.mat.uniforms.uHasRing.value = 1;
        view.mat.uniforms.uRingRange.value.set(inner, outer);
      });
    } else if (b.rings.kind === 'uranus') {
      const tex = this._makeUranusRingTexture();
      mat.uniforms.uRingMap.value = tex;
      mat.uniforms.uHasMap.value = 1;
    }
  },

  // 天王星の環: 細く暗い環（ε環など）を半径方向の1次元テクスチャで作る
  _makeUranusRingTexture() {
    const W = 2048;
    const data = new Uint8Array(W * 4 * 4);
    const inner = 41800, outer = 51200;
    // [半径km, 幅km, 不透明度]
    const rings = [[41837, 2, 0.3], [42234, 2, 0.3], [42571, 2, 0.3], [44718, 7, 0.4], [45661, 8, 0.4],
      [47176, 2, 0.25], [47627, 2, 0.3], [48300, 6, 0.4], [51149, 40, 0.75]];
    for (let x = 0; x < W; x++) {
      const r = inner + (x / (W - 1)) * (outer - inner);
      let a = 0;
      for (const [rr, w, op] of rings) {
        const half = Math.max(w, 12) / 2;
        if (Math.abs(r - rr) < half) a = Math.max(a, op);
      }
      for (let y = 0; y < 4; y++) {
        const o = (y * W + x) * 4;
        data[o] = 70; data[o + 1] = 70; data[o + 2] = 75; data[o + 3] = Math.round(a * 255);
      }
    }
    const tex = new THREE.DataTexture(data, W, 4, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  },

  // 遠くの天体を光点として描く
  _buildBodyPoints() {
    const n = SolarSystem.bodies.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e30);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: 1 },
        uFluxScale: { value: 40 },
        uMagOffset: { value: 0 },
      },
      vertexShader: BODYPOINT_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    this.overlayScene.add(pts);
    this._bodyPoints = pts;
  },

  _buildSunGlow() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uSizePx: { value: 400 },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uIntensity: { value: 1 },
        uCoreScale: { value: 1 },
        uDiscR: { value: 0 },
        uColor: { value: new THREE.Color(1.0, 0.92, 0.8) },
      },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    this.overlayScene.add(mesh);
    this._sunGlow = mesh;
  },

  _buildWarpStreaks() {
    const N = 260;
    const dirs = new Float32Array(N * 2 * 3);
    const phase = new Float32Array(N * 2);
    const end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.25 + Math.random() * 0.75;
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        dirs[j * 3] = Math.cos(a) * r;
        dirs[j * 3 + 1] = Math.sin(a) * r;
        dirs[j * 3 + 2] = 1;
        phase[j] = (i * 0.618034) % 1;
        end[j] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uBasis: { value: new THREE.Matrix3() },
        uTime: { value: 0 },
        uLength: { value: 0.1 },
        uIntensity: { value: 0 },
      },
      vertexShader: WARP_VERT,
      fragmentShader: WARP_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 20;
    lines.visible = false;
    this.overlayScene.add(lines);
    this._warpStreaks = lines;
  },

  // ワープの演出: speed[m/s], dirU: 進行方向（宇宙座標の単位ベクトル）
  setWarpEffect(speed, dirU, dt) {
    const w = this._warpStreaks;
    if (!w) return;
    const level = speed > 0 ? Math.max(0, Math.min(1, (Math.log10(Math.max(speed, 1)) - 4) / 6)) : 0;
    this._warpLevel = (this._warpLevel || 0) + (level - (this._warpLevel || 0)) * Math.min(1, dt * 3);
    const lv = this._warpLevel;
    w.visible = lv > 0.01;
    if (!w.visible) return;
    const f = new THREE.Vector3(dirU.x, dirU.y, dirU.z).normalize();
    const tmp = Math.abs(f.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const xAxis = new THREE.Vector3().crossVectors(tmp, f).normalize();
    const yAxis = new THREE.Vector3().crossVectors(f, xAxis);
    w.material.uniforms.uBasis.value.set(
      xAxis.x, yAxis.x, f.x,
      xAxis.y, yAxis.y, f.y,
      xAxis.z, yAxis.z, f.z
    );
    w.material.uniforms.uTime.value = (w.material.uniforms.uTime.value + dt * (0.25 + lv * 0.9)) % 1000;
    w.material.uniforms.uLength.value = 0.05 + lv * 0.5;
    w.material.uniforms.uIntensity.value = lv * 0.55;
  },

  // -----------------------------------------------------------
  // ローカルシーン（艦・ポート）用の照明
  // -----------------------------------------------------------
  initLocalLights(localScene) {
    const ambient = new THREE.AmbientLight(0x8899aa, 0.22);
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.35);
    const planetshine = new THREE.DirectionalLight(0x6688cc, 0);
    localScene.add(ambient, sun, planetshine, sun.target, planetshine.target);
    this._localLights = { ambient, sun, planetshine };
  },

  // -----------------------------------------------------------
  // 視点の設定
  //   view = {
  //     anchorId: 基準天体のID,
  //     offset: {x,y,z} 基準天体の中心から見たカメラ位置 [m]（宇宙座標の軸）,
  //     quat: THREE.Quaternion（カメラの宇宙座標での向き）,
  //     fov, aspect,
  //     observerPc: {x,y,z}（恒星表示用。省略時は offset から計算）
  //   }
  // -----------------------------------------------------------
  setView(view) {
    this._view = view;
  },

  // 天体 b のカメラ中心座標（倍精度で計算してから返す）
  relPos(b, out) {
    const v = this._view;
    const a = SolarSystem.byId[v.anchorId];
    const o = out || {};
    o.x = (b.pos.x - a.pos.x) - v.offset.x;
    o.y = (b.pos.y - a.pos.y) - v.offset.y;
    o.z = (b.pos.z - a.pos.z) - v.offset.z;
    return o;
  },

  // カメラの宇宙座標（太陽中心）
  cameraUniversePos() {
    const v = this._view;
    const a = SolarSystem.byId[v.anchorId];
    return { x: a.pos.x + v.offset.x, y: a.pos.y + v.offset.y, z: a.pos.z + v.offset.z };
  },

  // 点 p（太陽中心の宇宙座標）から見た太陽の見え具合（0〜1、惑星による食を考慮）
  sunVisibilityAt(p, excludeId) {
    const sun = SolarSystem.byId.sun;
    const sx = sun.pos.x - p.x, sy = sun.pos.y - p.y, sz = sun.pos.z - p.z;
    const sd = Math.hypot(sx, sy, sz);
    if (sd < sun.rM) return 1;
    const sunAng = Math.asin(Math.min(1, sun.rM / sd));
    let vis = 1;
    for (const b of SolarSystem.bodies) {
      if (b.id === 'sun' || b.id === excludeId) continue;
      const cx = b.pos.x - p.x, cy = b.pos.y - p.y, cz = b.pos.z - p.z;
      const cd = Math.hypot(cx, cy, cz);
      if (cd >= sd || cd < b.rM) continue;
      const along = (cx * sx + cy * sy + cz * sz) / sd;
      if (along <= 0) continue;
      const occAng = Math.asin(Math.min(1, b.rM / cd));
      const sep = Math.acos(Math.max(-1, Math.min(1, along / cd)));
      if (sep > occAng + sunAng) continue;
      vis *= 1 - this._diskOverlapFraction(sunAng, occAng, sep);
    }
    return Math.max(0, vis);
  },

  // 半径 r1 の円（太陽）が、半径 r2 の円に中心間距離 d で覆われる割合
  _diskOverlapFraction(r1, r2, d) {
    if (d >= r1 + r2) return 0;
    if (d <= Math.abs(r2 - r1)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1);
    const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
    const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
    const c = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
    return Math.min(1, (a + b - c) / (Math.PI * r1 * r1));
  },

  // -----------------------------------------------------------
  // 毎フレームの更新
  // -----------------------------------------------------------
  // cssW/cssH: 画面の大きさ（CSSピクセル）、pixelRatio: devicePixelRatio
  update(cssW, cssH, pixelRatio) {
    const viewportW = cssW, viewportH = cssH;
    const v = this._view;
    if (!v || !this.ready) return;
    const cam = this.camera;
    cam.fov = v.fov;
    cam.aspect = v.aspect;
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(v.quat);
    cam.updateMatrixWorld(true);
    this.skyCamera.fov = v.fov;
    this.skyCamera.aspect = v.aspect;
    this.skyCamera.quaternion.copy(v.quat);
    this.skyCamera.updateProjectionMatrix();
    this.skyCamera.updateMatrixWorld(true);

    const camU = this.cameraUniversePos();
    const sun = SolarSystem.byId.sun;
    const tanHalf = Math.tan((v.fov * Math.PI) / 360);
    // 画面中心付近での1ラジアンあたりの「デバイス」ピクセル数（描画の細かさの判断に使う）
    const pxPerRad = ((viewportH * pixelRatio) / 2) / tanHalf;

    // 星空（観測者の位置: 太陽から何pc離れているか）
    const obsPc = v.observerPc || { x: camU.x / Astro.PC, y: camU.y / Astro.PC, z: camU.z / Astro.PC };
    const su = this._starPoints.material.uniforms;
    su.uObserver.value.set(obsPc.x, obsPc.y, obsPc.z);
    su.uPixelRatio.value = pixelRatio;
    // 太陽系内では太陽そのものは天体として描くので星表の「太陽」は無い。

    // 明るさの露出補正: 太陽が視野内にあるときは星を暗くする
    const sunRel = this.relPos(sun, {});
    const sunDist = Math.hypot(sunRel.x, sunRel.y, sunRel.z);
    const sunDirCam = new THREE.Vector3(sunRel.x, sunRel.y, sunRel.z).normalize();
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(v.quat);
    const sunVis = this.sunVisibilityAt(camU, null);
    this.frameInfo.sunVisibility = sunVis;
    const sunAngR = Math.asin(Math.min(1, sun.rM / Math.max(sunDist, sun.rM)));
    const sunInView = Math.max(0, (sunDirCam.dot(camFwd) - Math.cos((v.fov * Math.PI) / 180 * 0.75)));
    const glare = Math.min(1, sunInView * 6) * sunVis;
    const exposure = -2.2 * glare; // 等級のずらし量（負=暗く）
    su.uMagOffset.value = exposure + Math.log10(this.settings.starBrightness) * 2.5;
    this._milkyWay.material.uniforms.uIntensity.value = this.settings.milkyWayIntensity * (1 - 0.8 * glare);

    // 太陽光の強さ（距離に応じて弱まるが、見やすさのため圧縮）
    const sunDistAU = sunDist / Astro.AU;
    const sunIntensityAtCam = Math.max(0.35, Math.min(1.6, Math.pow(1 / Math.max(sunDistAU, 0.05), 0.35)));

    // 天体ごと
    let nearestSurface = Infinity;
    const posAttr = this._bodyPoints.geometry.attributes.position;
    const magAttr = this._bodyPoints.geometry.attributes.aMag;
    const colAttr = this._bodyPoints.geometry.attributes.aColor;
    const alphaAttr = this._bodyPoints.geometry.attributes.aAlpha;
    const rel = {};
    const screenInfo = this.frameInfo.bodyScreen;
    const projV = new THREE.Vector3();

    // near/far を先に決めるため、まず全天体の距離を測る
    const bodies = SolarSystem.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      this.relPos(b, rel);
      const d = Math.hypot(rel.x, rel.y, rel.z);
      const extent = b.rings ? b.rings.outer * 1000 : Math.max(b.rM, b.rpM, b.rbM);
      const surf = d - extent * 1.02;
      b._camDist = d;
      if (surf < nearestSurface) nearestSurface = surf;
    }
    let near = Math.max(1, nearestSurface * 0.45);
    // 星図では、カメラが注視している範囲に合わせて near を小さくする
    if (this._mapMode && this._mapNear) near = Math.min(near, this._mapNear);
    else near = Math.min(near, 1e10);
    const far = Math.max(near * 5e6, 1e7);
    cam.near = near;
    cam.far = far;
    cam.updateProjectionMatrix();
    this.frameInfo.near = near;
    this.frameInfo.far = far;

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const view = this._views[b.id];
      this.relPos(b, rel);
      const d = b._camDist;
      const maxR = view.maxR;
      const angR = Math.asin(Math.min(1, maxR / Math.max(d, maxR)));
      const pxR = angR * pxPerRad;

      // 画面位置（ラベル表示などに使う）
      projV.set(rel.x, rel.y, rel.z).applyMatrix4(cam.matrixWorldInverse);
      const inFront = projV.z < 0;
      projV.applyMatrix4(cam.projectionMatrix);
      let si = screenInfo[b.id];
      if (!si) si = screenInfo[b.id] = {};
      si.x = (projV.x * 0.5 + 0.5) * viewportW;
      si.y = (-projV.y * 0.5 + 0.5) * viewportH;
      si.onScreen = inFront && Math.abs(projV.x) <= 1.05 && Math.abs(projV.y) <= 1.05;
      si.inFront = inFront;
      si.pxRadius = pxR / pixelRatio; // CSSピクセル
      si.dist = d;

      // メッシュとして描くか、光点として描くか
      const meshAlpha = Math.max(0, Math.min(1, (pxR - 1.2) / 2.5));
      // 太陽は光点ではなく光芒（_sunGlow）で表す
      const pointAlpha = b.type === 'star' ? 0 : Math.max(0, Math.min(1, (4.0 - pxR) / 2.5));
      const showMesh = meshAlpha > 0 && d < far * 0.9;
      view.group.visible = showMesh;

      // 太陽の方向（この天体から見て）と、太陽光の強さ
      const sdx = sun.pos.x - b.pos.x, sdy = sun.pos.y - b.pos.y, sdz = sun.pos.z - b.pos.z;
      const sdist = Math.hypot(sdx, sdy, sdz) || 1;

      if (showMesh) {
        view.group.position.set(rel.x, rel.y, rel.z);
        view.group.quaternion.set(b.quat.x, b.quat.y, b.quat.z, b.quat.w);
        view.group.scale.setScalar(maxR);
        view.group.updateMatrixWorld(true);
        this._updateBodyMaterials(view, b, rel, d, sdx / sdist, sdy / sdist, sdz / sdist, sdist, pxR);
      }

      // 光点（天球用カメラで描くので単位ベクトルの方向だけを渡す）
      const invD = 1 / Math.max(d, 1e-9);
      posAttr.setXYZ(i, rel.x * invD, rel.y * invD, rel.z * invD);
      let mag;
      if (b.type === 'star') {
        mag = Astro.SUN_V_AT_1AU + 5 * Math.log10(Math.max(d, 1) / Astro.AU);
      } else {
        const phaseCos = ((sun.pos.x - b.pos.x) * -rel.x + (sun.pos.y - b.pos.y) * -rel.y + (sun.pos.z - b.pos.z) * -rel.z) / (sdist * Math.max(d, 1));
        const alpha = Math.acos(Math.max(-1, Math.min(1, phaseCos)));
        mag = Astro.apparentMagnitude(b.meanRadiusM, Math.min(1, b.albedo), sdist, Math.max(d, 1), alpha);
        if (b.rings && b.id === 'saturn') mag -= 0.8; // 環の明るさ
      }
      let alphaOut = pointAlpha;
      if (this._mapMode && b.type !== 'star') {
        // 星図では、等級が暗くても天体の位置がわかるよう最低限の明るさで表示する
        const cap = this._mapBodyMagCap ? this._mapBodyMagCap(b) : null;
        if (cap === null) alphaOut = 0;
        else mag = Math.min(mag, cap);
      }
      magAttr.setX(i, mag);
      colAttr.setXYZ(i, b.color[0], b.color[1], b.color[2]);
      alphaAttr.setX(i, alphaOut);
      if (b.id === 'sun') this._updateSunGlow(rel, d, angR, pxR / pixelRatio, sunVis, viewportW * pixelRatio, viewportH * pixelRatio, pixelRatio);
    }
    // 手前の天体の円盤に隠れている光点は消す（深度テストの代わり）
    for (let i = 0; i < bodies.length; i++) {
      if (alphaAttr.getX(i) <= 0) continue;
      const b = bodies[i];
      const sb = screenInfo[b.id];
      for (let j = 0; j < bodies.length; j++) {
        if (j === i) continue;
        const o = bodies[j];
        const so = screenInfo[o.id];
        if (!so.inFront || so.dist >= sb.dist || so.pxRadius < 1) continue;
        if (Math.hypot(so.x - sb.x, so.y - sb.y) < so.pxRadius) {
          alphaAttr.setX(i, 0);
          break;
        }
      }
    }
    posAttr.needsUpdate = true;
    magAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    const bu = this._bodyPoints.material.uniforms;
    bu.uPixelRatio.value = pixelRatio;
    bu.uMagOffset.value = exposure;

    this._updateOrbitLines();
    this._sunIntensityAtCam = sunIntensityAtCam;

    // 太陽系から遠く離れたときの表示切り替え（星図の大縮尺表示）
    const camDistSun = Math.hypot(camU.x, camU.y, camU.z);
    const ly = camDistSun / Astro.LY;
    // 天球（天の川の写真・星表の星）は太陽の近くから見た姿なので、遠ざかったら消す
    const skyFade = 1 - Math.max(0, Math.min(1, (Math.log10(Math.max(ly, 1e-9)) - Math.log10(30)) / (Math.log10(800) - Math.log10(30))));
    this._milkyWay.visible = skyFade > 0.01;
    // 星図で小惑星帯などを表示しているときは、点と紛れないよう背景の星空を暗くする
    const skyK = skyFade * (this._mapMode ? this._mapSkyDim : 1);
    this._milkyWay.material.uniforms.uIntensity.value *= skyK;
    this._starPoints.visible = skyFade > 0.01;
    su.uMagOffset.value += skyK < 1 ? 2.5 * Math.log10(Math.max(skyK, 1e-3)) : 0;
    // 星図: 3Dの恒星（0.05光年〜数千光年の範囲で表示）
    const s3 = this._stars3D;
    const show3d = this._mapMode && ly > 0.02;
    s3.visible = show3d;
    if (show3d) {
      const u3 = s3.material.uniforms;
      u3.uObserver.value.set(camU.x / Astro.PC, camU.y / Astro.PC, camU.z / Astro.PC);
      u3.uPixelRatio.value = pixelRatio;
      const fade3 = Math.min(1, (ly - 0.02) / 0.3) * (1 - Math.max(0, Math.min(1, (ly - 4000) / 20000)));
      u3.uMagOffset.value = 2.5 * Math.log10(Math.max(fade3, 1e-3)) + 1.0;
      u3.uMagClamp.value = 6.0 + Math.max(0, Math.log10(Math.max(ly, 1)) - 1) * 1.2;
      s3.position.set(0, 0, 0);
    }
    // 星図: 銀河系モデル（数千光年より遠くから見るとき）
    if (typeof GalaxyModel !== 'undefined') {
      const gv = this._mapMode ? Math.max(0, Math.min(1, (Math.log10(Math.max(ly, 1)) - Math.log10(1500)) / (Math.log10(12000) - Math.log10(1500)))) : 0;
      GalaxyModel.update(camU, (viewportH * pixelRatio / 2) / tanHalf, gv);
    }
  },

  _updateBodyMaterials(view, b, rel, d, sx, sy, sz, sdist, pxR) {
    // 天体ローカル座標（天体固定、three並び）へ: R^T を掛ける
    const m = b.rotMat;
    const toLocal = (x, y, z) => ({
      x: m[0] * x + m[3] * y + m[6] * z,
      y: m[1] * x + m[4] * y + m[7] * z,
      z: m[2] * x + m[5] * y + m[8] * z,
    });
    const maxR = view.maxR;
    const sunL = toLocal(sx, sy, sz);
    const camL = toLocal(-rel.x / maxR, -rel.y / maxR, -rel.z / maxR);
    const sun = SolarSystem.byId.sun;
    const sunAng = Math.asin(Math.min(1, sun.rM / sdist));
    const sunI = Math.max(0.35, Math.min(1.6, Math.pow(Astro.AU / Math.max(sdist, 0.05 * Astro.AU), 0.35)));

    // テクスチャの解像度: 画面上の直径に応じて
    const diamPx = pxR * 2;
    const wanted = diamPx > 1100 ? '4k' : diamPx > 350 ? '2k' : '1k';
    const u = view.mat.uniforms;
    if (b.tex) {
      const tex = TextureLOD.best(b.tex, b.texLevels, wanted);
      if (tex && u.uMap.value !== tex) {
        u.uMap.value = tex;
        u.uHasMap.value = 1;
      }
    }

    u.uCamPos.value.set(camL.x, camL.y, camL.z);
    if (b.type === 'star') return;

    u.uSunDir.value.set(sunL.x, sunL.y, sunL.z);
    u.uSunAng.value = sunAng;
    u.uSunIntensity.value = sunI;

    if (b.earthLike) {
      const el = b.earthLike;
      const night = TextureLOD.best(el.night, el.nightLevels, wanted);
      if (night) { u.uNight.value = night; u.uHasNight.value = 1; }
      const ocean = TextureLOD.best(el.ocean, el.oceanLevels, wanted === '4k' ? '2k' : wanted);
      if (ocean) { u.uOcean.value = ocean; u.uHasOcean.value = 1; }
      if (view.clouds) {
        const cu = view.clouds.material.uniforms;
        const clouds = TextureLOD.best(el.clouds, el.cloudLevels, wanted);
        if (clouds) cu.uClouds.value = clouds;
        view.clouds.visible = !!clouds;
        cu.uSunDir.value.set(sunL.x, sunL.y, sunL.z);
        cu.uSunAng.value = sunAng;
        cu.uSunIntensity.value = sunI;
        cu.uCamPos.value.set(camL.x, camL.y, camL.z);
      }
    }
    if (view.atmo) {
      const au = view.atmo.material.uniforms;
      au.uSunDir.value.set(sunL.x, sunL.y, sunL.z);
      au.uCamPos.value.set(camL.x / view.atmoShellScale, camL.y / view.atmoShellScale, camL.z / view.atmoShellScale);
      au.uSunIntensity.value = sunI;
    }
    if (view.ring) {
      const ru = view.ring.material.uniforms;
      // 環のメッシュは赤道半径=1の単位。group は maxR(=赤道半径) でスケール済み
      ru.uSunDir.value.set(sunL.x, sunL.y, sunL.z);
      ru.uCamPos.value.set(camL.x, camL.y, camL.z);
      ru.uSunIntensity.value = sunI;
    }

    // 影を落とす天体（太陽の方向にある近くの天体、最大4つ）
    this._updateOccluders(view, b, sx, sy, sz, toLocal);
  },

  _updateOccluders(view, b, sx, sy, sz, toLocal) {
    const occ = [];
    const parent = b.parent ? SolarSystem.byId[b.parent] : null;
    const candidates = [];
    if (parent) candidates.push(parent);
    for (const c of b.children) candidates.push(c);
    if (parent) for (const s of parent.children) if (s !== b) candidates.push(s);
    const maxR = this._views[b.id].maxR;
    for (const c of candidates) {
      const dx = c.pos.x - b.pos.x, dy = c.pos.y - b.pos.y, dz = c.pos.z - b.pos.z;
      const along = dx * sx + dy * sy + dz * sz;
      if (along <= 0) continue; // 太陽と反対側にあれば影にはならない
      const dist = Math.hypot(dx, dy, dz);
      const perp = Math.sqrt(Math.max(0, dist * dist - along * along));
      if (perp > maxR + c.rM * 3 + dist * 0.01) continue;
      const l = toLocal(dx / maxR, dy / maxR, dz / maxR);
      occ.push({ l, r: c.rM / maxR, score: perp });
    }
    occ.sort((a, b2) => a.score - b2.score);
    const apply = (uniforms) => {
      const n = Math.min(4, occ.length);
      for (let i = 0; i < 4; i++) {
        if (i < n) uniforms.uOcc.value[i].set(occ[i].l.x, occ[i].l.y, occ[i].l.z, occ[i].r);
      }
      uniforms.uOccCount.value = n;
    };
    apply(view.mat.uniforms);
    if (view.clouds) apply(view.clouds.material.uniforms);
  },

  _updateSunGlow(rel, d, angR, pxR, sunVis, vw, vh, pixelRatio) {
    const g = this._sunGlow;
    // 天球用カメラで描くので、太陽の方向の単位ベクトル上に置く
    const k = 1 / Math.max(d, 1e-9);
    g.position.set(rel.x * k, rel.y * k, rel.z * k);
    const u = g.material.uniforms;
    // 遠くの太陽ほど小さく暗く、ただし最低限の大きさは保つ
    const distAU = d / Astro.AU;
    let sizeCss = Math.max(Math.max(90, Math.min(900, 520 / Math.pow(Math.max(distAU, 0.02), 0.45))), pxR * 7);
    if (this._mapMode) sizeCss = Math.max(40, sizeCss * 0.35); // 星図では控えめに
    u.uSizePx.value = sizeCss * pixelRatio;
    u.uCoreScale.value = Math.max(0, Math.min(1, 1 - (pxR - 6) / 30));
    u.uDiscR.value = Math.min(0.9, pxR / (sizeCss / 2));
    u.uViewport.value.set(vw, vh);
    u.uIntensity.value = sunVis * Math.max(0.35, Math.min(1.4, Math.pow(1 / Math.max(distAU, 0.05), 0.3)));
    // 太陽が視野の後ろにあるときは描かない
    const p = new THREE.Vector3(rel.x, rel.y, rel.z).applyMatrix4(this.camera.matrixWorldInverse);
    g.visible = p.z < 0 && sunVis > 0.001;
    g.updateMatrixWorld(true);
  },

  // -----------------------------------------------------------
  // 軌道線
  // -----------------------------------------------------------
  _orbitParent(b) {
    if (b.orbit.kind === 'origin') return null;
    if (b.parent) return SolarSystem.byId[b.parent];
    return SolarSystem.byId.sun;
  },

  _buildOrbitLine(b) {
    const parent = this._orbitParent(b);
    if (!parent) return null;
    const N = b.type === 'moon' ? 180 : 360;
    const positions = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const color = b.type === 'planet' ? 0x5f8fd8 : b.type === 'moon' ? 0x7f9fbf : b.type === 'comet' ? 0x8fd8c8 : 0xb89f7f;
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false });
    const line = new THREE.LineLoop(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 5;
    line.visible = false;
    this.scene.add(line);
    return { line, parent, builtJd: null, N };
  },

  // 軌道を1周ぶん（親天体からの相対位置で）サンプリング
  _sampleOrbit(entry, b) {
    const jd = SolarSystem.jd;
    const pos = entry.line.geometry.attributes.position;
    const N = entry.N;
    let period;
    if (b.orbit.kind === 'planet') {
      period = 365.25 * Math.pow(Astro.PLANET_ELEMENTS[b.orbit.key].el[0], 1.5);
    } else if (b.orbit.kind === 'earth') period = 365.256;
    else if (b.orbit.kind === 'moon') period = 27.3217;
    else if (b.orbit.kind === 'pluto') period = 90560;
    else if (b.orbit.kind === 'osculating') period = 360 / b.orbit.el.n;
    else period = 360 / Math.abs(b.orbit.fit.n);
    const sample = (t) => {
      switch (b.orbit.kind) {
        case 'planet': {
          const p = Astro.planetHelioEcl(b.orbit.key, t);
          return { x: p.x * Astro.AU, y: p.y * Astro.AU, z: p.z * Astro.AU };
        }
        case 'earth': {
          const p = Astro.planetHelioEcl('emb', t);
          return { x: p.x * Astro.AU, y: p.y * Astro.AU, z: p.z * Astro.AU };
        }
        case 'pluto': {
          const p = Astro.planetHelioEcl('pluto', t);
          return { x: p.x * Astro.AU, y: p.y * Astro.AU, z: p.z * Astro.AU };
        }
        case 'moon': {
          const m = Astro.moonGeoEclKm(t);
          return { x: m.x * 1000, y: m.y * 1000, z: m.z * 1000 };
        }
        case 'osculating': {
          const p = Astro.osculatingHelioEcl(b.orbit.el, t);
          return { x: p.x * Astro.AU, y: p.y * Astro.AU, z: p.z * Astro.AU };
        }
        default: {
          const p = Astro.fittedSatelliteEclKm(b.orbit.fit, t);
          return { x: p.x * 1000, y: p.y * 1000, z: p.z * 1000 };
        }
      }
    };
    const kind = b.orbit.kind;
    if (kind === 'planet' || kind === 'earth' || kind === 'pluto' || kind === 'osculating') {
      // 惑星・小天体: 現在の軌道要素から楕円を直接描く（細長い彗星の軌道も滑らかに）
      let el;
      if (kind === 'osculating') {
        const o = b.orbit.el;
        el = { a: o.a, e: o.e, i: o.i * Astro.DEG, node: o.node * Astro.DEG, argPeri: o.w * Astro.DEG };
      } else {
        el = Astro.planetOrbitElements(kind === 'planet' ? b.orbit.key : kind === 'earth' ? 'emb' : 'pluto', jd);
      }
      const pts = Astro.orbitPoints(el, N);
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        pos.setXYZ(i, p.x * Astro.AU, p.z * Astro.AU, -p.y * Astro.AU);
      }
    } else {
      // 衛星: 軌道面がゆっくり回るので、現在を中心に1周ぶんを時間でサンプリング
      for (let i = 0; i < N; i++) {
        const t = jd + ((i / N) - 0.5) * period;
        const p = sample(t);
        pos.setXYZ(i, p.x, p.z, -p.y);
      }
    }
    pos.needsUpdate = true;
    entry.builtJd = jd;
    entry.period = period;
  },

  _updateOrbitLines() {
    const show = this.settings.showOrbits || this._mapMode;
    const camU = this.cameraUniversePos();
    const rel = {};
    for (const b of SolarSystem.bodies) {
      if (b.type === 'star') continue;
      let entry = this._orbitLines[b.id];
      const parent = this._orbitParent(b);
      // 表示条件: 惑星・準惑星等は常に。衛星は親の近くにいるときだけ。
      let visible = show;
      if (visible && b.type === 'moon') {
        const dp = Math.hypot(camU.x - parent.pos.x, camU.y - parent.pos.y, camU.z - parent.pos.z);
        visible = dp < Math.max(parent.soiM * 2, (b.orbitRadiusM || 1e9) * 30);
      }
      if (visible && this._mapMode && this._mapVisibleFilter) visible = this._mapVisibleFilter(b);
      if (!visible) {
        if (entry) entry.line.visible = false;
        continue;
      }
      if (!entry) {
        entry = this._buildOrbitLine(b);
        this._orbitLines[b.id] = entry;
      }
      if (entry.builtJd === null || Math.abs(SolarSystem.jd - entry.builtJd) > Math.max(0.02 * (entry.period || 1), 0.01)) {
        this._sampleOrbit(entry, b);
      }
      this.relPos(parent, rel);
      entry.line.position.set(rel.x, rel.y, rel.z);
      // 天体のすぐ近くでは軌道線の折れ線の誤差が目立つので薄くする
      const dBody = b._camDist || Infinity;
      const fadeNear = Math.min(1, Math.max(0, (dBody / Math.max(b.rM * 200, 1) - 1) / 4));
      const base = b.type === 'moon' ? 0.35 : 0.5;
      entry.line.material.opacity = base * (this._mapMode ? 1 : fadeNear) * (this._orbitOpacityScale || 1);
      entry.line.visible = entry.line.material.opacity > 0.01;
    }
  },

  // -----------------------------------------------------------
  // ローカルシーンの照明（艦が受ける太陽光・惑星からの照り返し）
  //   frameRotT: 宇宙座標 → ローカル座標 の回転行列（3x3, 行優先）
  //   shipU: 艦の宇宙座標
  // -----------------------------------------------------------
  updateLocalLights(frameRotT, shipU, shipLocalPos) {
    if (!this._localLights) return;
    const sun = SolarSystem.byId.sun;
    const dx = sun.pos.x - shipU.x, dy = sun.pos.y - shipU.y, dz = sun.pos.z - shipU.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const vis = this.sunVisibilityAt(shipU, null);
    const toLocal = (x, y, z) => ({
      x: frameRotT[0] * x + frameRotT[1] * y + frameRotT[2] * z,
      y: frameRotT[3] * x + frameRotT[4] * y + frameRotT[5] * z,
      z: frameRotT[6] * x + frameRotT[7] * y + frameRotT[8] * z,
    });
    const sl = toLocal(dx / dist, dy / dist, dz / dist);
    const L = this._localLights;
    const sp = shipLocalPos || { x: 0, y: 0, z: 0 };
    L.sun.target.position.set(sp.x, sp.y, sp.z);
    L.sun.position.set(sp.x + sl.x * 1000, sp.y + sl.y * 1000, sp.z + sl.z * 1000);
    const distAU = dist / Astro.AU;
    L.sun.intensity = 1.35 * vis * Math.max(0.35, Math.min(1.5, Math.pow(1 / Math.max(distAU, 0.05), 0.35)));
    this.localSunDir = sl;
    this.localSunVisibility = vis;

    // 惑星光: 見かけの立体角が最大の天体（太陽以外）からの反射光
    let best = null, bestScore = 0;
    for (const b of SolarSystem.bodies) {
      if (b.type === 'star') continue;
      const bx = b.pos.x - shipU.x, by = b.pos.y - shipU.y, bz = b.pos.z - shipU.z;
      const bd = Math.hypot(bx, by, bz);
      if (bd <= b.rM) continue;
      const solid = (b.rM / bd) * (b.rM / bd);
      if (solid > bestScore) { bestScore = solid; best = { b, bx, by, bz, bd }; }
    }
    if (best && bestScore > 1e-4) {
      const { b, bx, by, bz, bd } = best;
      // 艦から見た天体の昼側の割合（位相）
      const sbx = sun.pos.x - b.pos.x, sby = sun.pos.y - b.pos.y, sbz = sun.pos.z - b.pos.z;
      const sbd = Math.hypot(sbx, sby, sbz);
      const cosPhase = (-bx * sbx - by * sby - bz * sbz) / (bd * sbd);
      const lit = (1 + cosPhase) / 2;
      const pl = toLocal(bx / bd, by / bd, bz / bd);
      L.planetshine.target.position.set(sp.x, sp.y, sp.z);
      L.planetshine.position.set(sp.x + pl.x * 1000, sp.y + pl.y * 1000, sp.z + pl.z * 1000);
      L.planetshine.color.setRGB(b.color[0], b.color[1], b.color[2]);
      L.planetshine.intensity = Math.min(0.9, 2.2 * Math.min(1, b.albedo) * lit * bestScore);
    } else {
      L.planetshine.intensity = 0;
    }
  },

  // -----------------------------------------------------------
  // 描画
  // -----------------------------------------------------------
  render(renderer) {
    if (!this.ready || !this._view) return;
    renderer.render(this.skyScene, this.skyCamera);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.render(this.overlayScene, this.skyCamera);
  },

  // 星図モード: filter(b) → 軌道線を出すか、magCap(b) → 光点の最低限の等級（nullなら非表示）
  // skyDim: 背景の星空の明るさの倍率
  setMapMode(on, filter, magCap, nearOverride, skyDim) {
    this._mapMode = !!on;
    this._mapVisibleFilter = filter || null;
    this._mapBodyMagCap = magCap || null;
    this._mapNear = nearOverride || null;
    this._mapSkyDim = skyDim === undefined ? 1 : skyDim;
  },
};
