// =============================================================
// 01-state-and-config.js
// 状態管理 + 艦種パラメータ定義
// =============================================================

// v27: 画面右下のバージョン表示・<title>で共通して使うバージョン名。
// リリースのたびにここだけ書き換えれば全画面に反映される。
const GAME_VERSION = 'v41';

// -------------------------------------------------------------
// 速度制限モード
//   'hard-cap'  : 最高速到達で加速度を強制ゼロ、噴射も弱める（物理整合）
//   'soft-glow' : 速度は頭打ちだが噴射は出続ける（演出優先）
// -------------------------------------------------------------
const SpeedCapMode = {
  HARD_CAP: 'hard-cap',
  SOFT_GLOW: 'soft-glow',
};

// -------------------------------------------------------------
// スラスター定義
//   position   : ローカル座標 {x,y,z}（艦重心を原点とする）
//   direction  : 噴射方向（ローカル、正規化済みでなくてもよい）
//                このベクトルの逆向きに艦が押される（反作用）
//   maxThrust  : そのスラスター単体の最大推力
//   kind       : 'main' | 'rcs'（07-engine-fx.js側のエフェクト分岐・
//                太さ/色の違いに使う。物理計算上は区別しない）
//   id         : 任意の識別子（ギズモ編集UIで個体を指すためのキー、
//                後続バージョンで使用）
//
// 艦重心(0,0,0)から見た位置と方向から、推力配分ソルバー
// （07-thruster-solver.js）が「欲しい並進力/トルク」に対する
// 各スラスターの寄与度を計算し、出力比を自動配分する。
// -------------------------------------------------------------
function makeThrusterList(entries) {
  return entries.map((e, i) => ({
    id: e.id ?? `thr_${i}`,
    position: e.position,
    direction: e.direction,
    maxThrust: e.maxThrust,
    kind: e.kind ?? 'rcs',
  }));
}

// -------------------------------------------------------------
// 艦種プリセット
//   mass              : 質量 (kg相当、シミュレーション単位)
//   inertia            : 慣性モーメント (スカラー簡略化。本格化する場合は3x3テンソルへ拡張)
//   thrusters           : スラスター定義配列（makeThrusterList()で生成）
//   maxAngularSpeed        : 最大角速度リミッター (rad/s)
//   maxSpeed            : 最高速度
//   speedCapMode          : SpeedCapMode のいずれか（艦ごとに変更可能、デフォルト値）
// -------------------------------------------------------------
const ShipClassPresets = {
  rocket: {
    label: 'ロケット級',
    mass: 1200,
    inertia: 800,
    maxAngularSpeed: 2.4,
    maxSpeed: 420,
    speedCapMode: SpeedCapMode.HARD_CAP,
    thrusters: makeThrusterList([
      // 主機: 船尾中心、+Z方向（後方）へ噴射→艦は-Z（前方）へ押される
      { id: 'main', position: { x: 0, y: 0, z: 4 }, direction: { x: 0, y: 0, z: 1 }, maxThrust: 26000, kind: 'main' },
      // v15: 逆噴射(retro)スラスターを船首側に新設。真正面(-Z、艦の
      // 進行方向)へ噴射し、その反作用で艦を+Z（後方）へ押す＝減速・
      // 後進させる純粋な逆噴射専用スラスター。船首側RCS(fwd)は
      // これとは分離し、横方向(X/Y)成分のみを持つ純粋な姿勢制御用に
      // 戻した（-Z成分は完全に除去）。
      { id: 'retro_left', position: { x: -1, y: 0, z: -3 }, direction: { x: 0, y: 0, z: -1 }, maxThrust: 13000, kind: 'rcs' },
      { id: 'retro_right', position: { x: 1, y: 0, z: -3 }, direction: { x: 0, y: 0, z: -1 }, maxThrust: 13000, kind: 'rcs' },
      { id: 'rcs_fwd_right', position: { x: 1, y: 0, z: -3 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      { id: 'rcs_fwd_left', position: { x: -1, y: 0, z: -3 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      { id: 'rcs_fwd_up', position: { x: 0, y: 1, z: -3 }, direction: { x: 0, y: 1, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      { id: 'rcs_fwd_down', position: { x: 0, y: -1, z: -3 }, direction: { x: 0, y: -1, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      { id: 'rcs_aft_right', position: { x: 1, y: 0, z: 3 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      { id: 'rcs_aft_left', position: { x: -1, y: 0, z: 3 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      { id: 'rcs_aft_up', position: { x: 0, y: 1, z: 3 }, direction: { x: 0, y: 1, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      { id: 'rcs_aft_down', position: { x: 0, y: -1, z: 3 }, direction: { x: 0, y: -1, z: 0 }, maxThrust: 1100, kind: 'rcs' },
      // ロール専用（Z軸まわりのトルクを生む唯一のグループ）:
      // 艦体中央付近の断面円周上、斜め45度の4点に接線方向へ噴射する
      // スラスターを配置。前後左右上下(fwd/aft×right/left/up/down)の
      // RCSは全てZ軸上（x=0またはy=0付近）にあるためposition×forceの
      // 外積がZ成分を持たず、ロールに一切寄与できない。この8基だけが
      // ロール操作(rotateRoll)に応答する。
      // 時計回り(cw)方向4基
      { id: 'rcs_roll_tr_cw', position: { x: 0.7, y: 0.7, z: 0 }, direction: { x: -0.7, y: 0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
      { id: 'rcs_roll_tl_cw', position: { x: -0.7, y: 0.7, z: 0 }, direction: { x: -0.7, y: -0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
      { id: 'rcs_roll_br_cw', position: { x: 0.7, y: -0.7, z: 0 }, direction: { x: 0.7, y: 0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
      { id: 'rcs_roll_bl_cw', position: { x: -0.7, y: -0.7, z: 0 }, direction: { x: 0.7, y: -0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
      // 反時計回り(ccw)方向4基。同じ4点から逆向きに噴射することで
      // rotateRoll=-1（反対方向のロール要求）にも応答できるようにする
      { id: 'rcs_roll_tr_ccw', position: { x: 0.7, y: 0.7, z: 0 }, direction: { x: 0.7, y: -0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
      { id: 'rcs_roll_tl_ccw', position: { x: -0.7, y: 0.7, z: 0 }, direction: { x: 0.7, y: 0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
      { id: 'rcs_roll_br_ccw', position: { x: 0.7, y: -0.7, z: 0 }, direction: { x: -0.7, y: -0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
      { id: 'rcs_roll_bl_ccw', position: { x: -0.7, y: -0.7, z: 0 }, direction: { x: -0.7, y: 0.7, z: 0 }, maxThrust: 900, kind: 'rcs' },
    ]),
  },
  cruiser: {
    label: '巡洋艦級',
    mass: 45000,
    inertia: 260000,
    maxAngularSpeed: 0.9,
    maxSpeed: 260,
    speedCapMode: SpeedCapMode.HARD_CAP,
    thrusters: makeThrusterList([
      { id: 'main', position: { x: 0, y: 0, z: 30 }, direction: { x: 0, y: 0, z: 1 }, maxThrust: 180000, kind: 'main' },
      // v15: 逆噴射(retro)スラスターを船首側に新設（真正面-Zへ噴射、
      // 反作用で艦を+Z後方へ押す）。船首側RCSは横方向(X/Y)成分のみに
      // 戻した（-Z成分は除去）。
      { id: 'retro_left', position: { x: -6, y: 0, z: -25 }, direction: { x: 0, y: 0, z: -1 }, maxThrust: 90000, kind: 'rcs' },
      { id: 'retro_right', position: { x: 6, y: 0, z: -25 }, direction: { x: 0, y: 0, z: -1 }, maxThrust: 90000, kind: 'rcs' },
      { id: 'rcs_fwd_right', position: { x: 6, y: 0, z: -25 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      { id: 'rcs_fwd_left', position: { x: -6, y: 0, z: -25 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      { id: 'rcs_fwd_up', position: { x: 0, y: 4, z: -25 }, direction: { x: 0, y: 1, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      { id: 'rcs_fwd_down', position: { x: 0, y: -4, z: -25 }, direction: { x: 0, y: -1, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      { id: 'rcs_aft_right', position: { x: 6, y: 0, z: 25 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      { id: 'rcs_aft_left', position: { x: -6, y: 0, z: 25 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      { id: 'rcs_aft_up', position: { x: 0, y: 4, z: 25 }, direction: { x: 0, y: 1, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      { id: 'rcs_aft_down', position: { x: 0, y: -4, z: 25 }, direction: { x: 0, y: -1, z: 0 }, maxThrust: 5500, kind: 'rcs' },
      // ロール専用（rocketと同様の理由。艦体中央断面の斜め45度4点×CW/CCW）
      { id: 'rcs_roll_tr_cw', position: { x: 4.2, y: 2.8, z: 0 }, direction: { x: -4.2, y: 2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
      { id: 'rcs_roll_tl_cw', position: { x: -4.2, y: 2.8, z: 0 }, direction: { x: -4.2, y: -2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
      { id: 'rcs_roll_br_cw', position: { x: 4.2, y: -2.8, z: 0 }, direction: { x: 4.2, y: 2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
      { id: 'rcs_roll_bl_cw', position: { x: -4.2, y: -2.8, z: 0 }, direction: { x: 4.2, y: -2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
      { id: 'rcs_roll_tr_ccw', position: { x: 4.2, y: 2.8, z: 0 }, direction: { x: 4.2, y: -2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
      { id: 'rcs_roll_tl_ccw', position: { x: -4.2, y: 2.8, z: 0 }, direction: { x: 4.2, y: 2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
      { id: 'rcs_roll_br_ccw', position: { x: 4.2, y: -2.8, z: 0 }, direction: { x: -4.2, y: -2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
      { id: 'rcs_roll_bl_ccw', position: { x: -4.2, y: -2.8, z: 0 }, direction: { x: -4.2, y: 2.8, z: 0 }, maxThrust: 4200, kind: 'rcs' },
    ]),
  },
  battleship: {
    label: '戦艦級',
    mass: 320000,
    inertia: 4200000,
    maxAngularSpeed: 0.35,
    maxSpeed: 140,
    speedCapMode: SpeedCapMode.SOFT_GLOW,
    thrusters: makeThrusterList([
      { id: 'main', position: { x: 0, y: 0, z: 70 }, direction: { x: 0, y: 0, z: 1 }, maxThrust: 620000, kind: 'main' },
      // v15: 逆噴射(retro)スラスターを船首側に新設（真正面-Zへ噴射、
      // 反作用で艦を+Z後方へ押す）。船首側RCSは横方向(X/Y)成分のみに
      // 戻した（-Z成分は除去）。
      // 大型艦は前後2組に加え中央にも1組、計3クラスターで旋回制御を厚めに
      { id: 'retro_left', position: { x: -12, y: 0, z: -60 }, direction: { x: 0, y: 0, z: -1 }, maxThrust: 310000, kind: 'rcs' },
      { id: 'retro_right', position: { x: 12, y: 0, z: -60 }, direction: { x: 0, y: 0, z: -1 }, maxThrust: 310000, kind: 'rcs' },
      { id: 'rcs_fwd_right', position: { x: 12, y: 0, z: -60 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_fwd_left', position: { x: -12, y: 0, z: -60 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_fwd_up', position: { x: 0, y: 9, z: -60 }, direction: { x: 0, y: 1, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_fwd_down', position: { x: 0, y: -9, z: -60 }, direction: { x: 0, y: -1, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_mid_right', position: { x: 12, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_mid_left', position: { x: -12, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_aft_right', position: { x: 12, y: 0, z: 60 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_aft_left', position: { x: -12, y: 0, z: 60 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_aft_up', position: { x: 0, y: 9, z: 60 }, direction: { x: 0, y: 1, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      { id: 'rcs_aft_down', position: { x: 0, y: -9, z: 60 }, direction: { x: 0, y: -1, z: 0 }, maxThrust: 16000, kind: 'rcs' },
      // ロール専用（rocketと同様の理由。艦体中央断面の斜め45度4点×CW/CCW）
      { id: 'rcs_roll_tr_cw', position: { x: 8.4, y: 6.3, z: 0 }, direction: { x: -8.4, y: 6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
      { id: 'rcs_roll_tl_cw', position: { x: -8.4, y: 6.3, z: 0 }, direction: { x: -8.4, y: -6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
      { id: 'rcs_roll_br_cw', position: { x: 8.4, y: -6.3, z: 0 }, direction: { x: 8.4, y: 6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
      { id: 'rcs_roll_bl_cw', position: { x: -8.4, y: -6.3, z: 0 }, direction: { x: 8.4, y: -6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
      { id: 'rcs_roll_tr_ccw', position: { x: 8.4, y: 6.3, z: 0 }, direction: { x: 8.4, y: -6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
      { id: 'rcs_roll_tl_ccw', position: { x: -8.4, y: 6.3, z: 0 }, direction: { x: 8.4, y: 6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
      { id: 'rcs_roll_br_ccw', position: { x: 8.4, y: -6.3, z: 0 }, direction: { x: -8.4, y: -6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
      { id: 'rcs_roll_bl_ccw', position: { x: -8.4, y: -6.3, z: 0 }, direction: { x: -8.4, y: 6.3, z: 0 }, maxThrust: 12000, kind: 'rcs' },
    ]),
  },
};

// -------------------------------------------------------------
// グローバル状態
// -------------------------------------------------------------
const State = {
  // シミュレーション全体
  time: 0,
  paused: false,

  // プレイヤー操縦艦
  ship: null, // createShipState() で初期化

  // 他の艦（艦隊AIやNPC想定、v01時点ではプレイヤーのみ運用）
  fleet: [],

  // 入力状態（02-input.js が更新）
  input: {
    // v04: thrustForwardはスティックの瞬間傾きではなく「スロットル
    // レバー」の保持値（-1..1）。指を離しても値は維持され、
    // 明示的にレバーを動かすまで出力比が変わらない
    thrustForward: 0, // -1..1 (スロットル保持値)
    thrustStrafeX: 0, // -1..1 (左右ストレイフ, RCS)
    thrustStrafeY: 0, // -1..1 (上下ストレイフ, RCS)
    rotatePitch: 0, // -1..1
    rotateYaw: 0, // -1..1
    rotateRoll: 0, // -1..1
    boost: false,
  },

  // 設定（settings.html・index.html双方から読み書きされる。
  // localStorage永続化はloadPersistedSettings/savePersistedSettings
  // 参照。ここでの初期値はページ起動直後の値で、initGame()内で
  // 永続化された値に上書きされる）
  settings: {
    speedCapModeOverride: null, // null なら艦プリセットのデフォルトに従う
    showDebugHud: true,
    // 自動姿勢制動（旋回入力を離すと自動でRCSが逆噴射して回転を止める、
    // 角速度ダンピングのみを対象とする）。
    // v10: 従来はこのトグル1つで「並進制動（機首方向以外の速度成分を
    // 打ち消す慣性キャンセル）」も一括ON/OFFしていたが、「逆噴射用の
    // SRCを独立させたい」という要望に応じて分離した。回転を止める
    // 自動制動と、並進の慣性を殺す自動逆噴射は別々にON/OFFできる
    // （03-thruster-solver.js参照）。
    autoDampingEnabled: true,
    // v10: 並進制動（ストレイフ入力が無い間、ローカルX/Y速度成分を
    // 自動でRCS逆噴射して打ち消す機能）専用のトグル。旧仕様では
    // autoDampingEnabledと同一フラグだったため、回転だけ自動制動を
    // 使いたい／並進の慣性だけ自分で殺したい、といった使い分けが
    // できなかった。
    retroDampingEnabled: true,
    cameraMode: 'chase', // 'chase'（追従）| 'orbit'（自由視点）
    // v08: RCS（逆噴射含む姿勢制御スラスター全般）の最大出力を、
    // 主機(main)最大推力に対する割合で頭打ちにする設定。
    // 1.0 = 制限なし（各RCSはそれぞれの定義上のmaxThrustまで出せる）。
    // 0.5 なら「RCS単体のmaxThrustが主機maxThrustの50%相当を超える
    // 場合、その50%相当で頭打ち」という形でクランプする
    // （03-thruster-solver.js の _effectiveMaxThrust() 参照）。
    // v40: 進入軸マーカー・目的地ゲート（DockingPlatform）の表示/
    // 非表示。06-hud.jsの設定ボタン横のトグルボタンで切り替え、
    // cameraMode等と同じくlocalStorageへ永続化する。
    // v41: 「進路の線の表示非表示は、ターミナル・進入軸とは別に
    // したい」という要望への対応で、予定航路の表示/非表示は
    // showRouteLineへ分離した（このフラグは以後、進入軸＋目的地
    // ゲート専用）。
    showApproachGuides: true,
    // v41: 予定航路（艦がこれから辿る経路の線）専用の表示/非表示。
    // showApproachGuidesとは独立にON/OFFできる。
    showRouteLine: true,
    rcsThrustCapRatio: 1.0,
  },

  // v08: 入港（オートドッキング）目的地。ゲーム中にHUDの
  // 「ここを目的地として保存」ボタンで設定される。nullなら未設定。
  // 座標はワールド座標、姿勢はクォータニオン（艦が目的地でとるべき向き）。
  dockingTarget: null, // { position: {x,y,z}, quaternion: {x,y,z,w} } | null
};

// -------------------------------------------------------------
// 艦の状態オブジェクトを生成
// -------------------------------------------------------------
function createShipState(classKey, overrides = {}) {
  const preset = ShipClassPresets[classKey];
  if (!preset) {
    throw new Error(`Unknown ship class: ${classKey}`);
  }

  return {
    classKey,
    label: preset.label,

    // 物理パラメータ（プリセットからコピー。個体差を持たせたい場合はoverridesで上書き）
    mass: overrides.mass ?? preset.mass,
    inertia: overrides.inertia ?? preset.inertia,
    // スラスター定義配列。優先順位: overrides.thrusters（呼び出し側の
    // 明示指定、テスト等で使用）> thruster-editor.htmlで保存された
    // カスタム配置（localStorage）> 艦種プリセットのデフォルト配置
    thrusters: overrides.thrusters ?? loadCustomThrusters(classKey) ?? preset.thrusters,
    maxAngularSpeed: overrides.maxAngularSpeed ?? preset.maxAngularSpeed,
    maxSpeed: overrides.maxSpeed ?? preset.maxSpeed,
    speedCapMode: overrides.speedCapMode ?? preset.speedCapMode,

    // 位置・姿勢（Three.jsのVector3/Quaternionは05-ship-controller.jsで生成、ここではプレーンな数値のみ保持）
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },

    // 速度（並進・角速度）
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 }, // pitch/yaw/roll軸のローカル角速度

    // 噴射エフェクト用の状態（07-engine-fx.jsが参照）
    // キーはスラスターのid、値は0..1の出力比。
    // 07-thruster-solver.js の solve() が毎フレーム再計算する。
    thrusterOutputRatios: {},
    isAtMaxSpeed: false, // 速度キャップに達しているか

    // v08: 自動操船（入港）モードが有効かどうか。
    // trueの間、03-thruster-solver.js の buildDesiredFromInput() が
    // 手動のrotatePitch/rotateYaw/thrustForward/thrustStrafeX/Y入力を
    // 無視し、State.dockingTargetへ向かう自動制御トルク・並進力を
    // 生成する（rotateRollと、自動制御力への手動加算のみ受け付ける）。
    autoDockingEnabled: false,
  };
}

// -------------------------------------------------------------
// 有効な速度制限モードを取得（設定オーバーライドを考慮）
// -------------------------------------------------------------
function getEffectiveSpeedCapMode(ship) {
  return State.settings.speedCapModeOverride ?? ship.speedCapMode;
}

// -------------------------------------------------------------
// v08: スラスター単体の「実効最大推力」を返す。
//   kind === 'main' はそのまま t.maxThrust を返す（上限の対象外、
//   主機自体が上限の基準になるスラスターのため）。
//   id が 'retro' で始まるスラスター（v15新設の逆噴射専用RCS）も
//   上限の対象外とする（v16: 「逆噴射は常に主機と同等の出力を
//   保証したい、rcsThrustCapRatioで一般RCSと一緒に絞られたくない」
//   という要望対応）。定義上のmaxThrust（各艦種プリセットで
//   main合計と同等になるよう設定済み）がそのまま常に有効になる。
//   kind === 'rcs'（retro以外）は、艦の主機合計推力 ×
//   settings.rcsThrustCapRatio を上限として t.maxThrust をクランプ
//   する。rcsThrustCapRatioが1.0（デフォルト）なら実質無制限
//   （各RCSは元のmaxThrustのまま）。
//
// 03-thruster-solver.js（推力配分の評価・解） と 04-flight-physics.js
// （実際の力・トルク積分）の両方から呼ばれる、スラスター系の
// 唯一の「実効推力」参照点。艦種プリセットのmaxThrust値そのものは
// 変更せず、常にこの関数越しに読むことで一貫性を保つ。
// -------------------------------------------------------------
function getEffectiveMaxThrust(ship, thruster) {
  if (thruster.kind !== 'rcs') return thruster.maxThrust;
  if (thruster.id.startsWith('retro')) return thruster.maxThrust;

  const capRatio = State.settings.rcsThrustCapRatio ?? 1.0;
  if (capRatio >= 1.0) return thruster.maxThrust;

  const mainThrusters = ship.thrusters.filter((t) => t.kind === 'main');
  if (mainThrusters.length === 0) return thruster.maxThrust; // 主機が無い艦は基準が無いためクランプしない

  const mainTotal = mainThrusters.reduce((sum, t) => sum + t.maxThrust, 0);
  const cap = mainTotal * capRatio;
  return Math.min(thruster.maxThrust, cap);
}

// -------------------------------------------------------------
// 設定の永続化（localStorage）
//
// settings.html を開くたびに選択状態がデフォルトへ戻ってしまう
// 問題への対応。以前はURLパラメータ経由でindex.html→ゲーム内へ
// 一方向に渡すだけで、settings.html側は常にコード内デフォルト
// （rocket / hard-cap）から表示していた。
//
// 今回からlocalStorageに「最後に選ばれた設定一式」を保存し、
// settings.html・index.htmlの両方がここから読み書きする。
// 優先順位（index.html側）: URLパラメータ（明示指定があれば最優先）
// → localStorage（前回の設定）→ コード内デフォルト
// -------------------------------------------------------------
const SETTINGS_STORAGE_KEY = 'spaceSimSettings';

const DEFAULT_PERSISTED_SETTINGS = {
  shipClass: 'rocket',
  speedCapMode: null, // null = 艦プリセットのデフォルトに従う（オーバーライドなし）
  showDebugHud: true,
  autoDampingEnabled: true, // 自動姿勢制動（回転ダンピングのみ、v10で並進制動から分離）
  retroDampingEnabled: true, // v10: 並進制動（逆噴射でのX/Y速度キャンセル）専用トグル
  cameraMode: 'chase', // 'chase'（追従）| 'orbit'（自由視点）
  rcsThrustCapRatio: 1.0, // v08: RCS最大出力の主機推力に対する上限比率（1.0=無制限）
  showApproachGuides: true, // v40: 進入軸・目的地ゲートの可視化表示/非表示
  showRouteLine: true, // v41: 予定航路の線の表示/非表示（showApproachGuidesとは独立）
};

// 保存されている設定を読み込む。localStorageが使えない環境
// （プライベートブラウジング等）やパース失敗時はデフォルトを返す。
function loadPersistedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PERSISTED_SETTINGS };
    const parsed = JSON.parse(raw);
    // 将来的にキーが増えた場合に備え、デフォルトとマージする
    return { ...DEFAULT_PERSISTED_SETTINGS, ...parsed };
  } catch (e) {
    console.warn('設定の読み込みに失敗しました。デフォルト値を使用します。', e);
    return { ...DEFAULT_PERSISTED_SETTINGS };
  }
}

// 設定を保存する。呼び出し側は「変更したいキーだけ」を渡せば、
// 既存の保存内容とマージされる。
function savePersistedSettings(partial) {
  try {
    const current = loadPersistedSettings();
    const merged = { ...current, ...partial };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
    return merged;
  } catch (e) {
    console.warn('設定の保存に失敗しました。', e);
    return null;
  }
}

// -------------------------------------------------------------
// 入港（オートドッキング）目的地の永続化
//
// HUDの「ここを目的地として保存」ボタンで、現在の艦位置・姿勢を
// 目的地として保存する。艦種は問わない単一の目的地のみ保持する
// （v08時点では複数目的地の管理は行わない）。
// -------------------------------------------------------------
const DOCKING_TARGET_STORAGE_KEY = 'spaceSimDockingTarget';

function loadDockingTarget() {
  try {
    const raw = localStorage.getItem(DOCKING_TARGET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.position || !parsed.quaternion) return null;
    return parsed;
  } catch (e) {
    console.warn('入港目的地の読み込みに失敗しました。', e);
    return null;
  }
}

function saveDockingTarget(target) {
  try {
    localStorage.setItem(DOCKING_TARGET_STORAGE_KEY, JSON.stringify(target));
    return true;
  } catch (e) {
    console.warn('入港目的地の保存に失敗しました。', e);
    return false;
  }
}

// -------------------------------------------------------------
// カスタムスラスター配置の永続化（thruster-editor.html用）
//
// 艦種ごとに別々のキー（spaceSimThrusters:<classKey>）で保存する。
// これにより、rocketで編集したスラスター配置がcruiser側に誤って
// 適用される、といった艦種間の混線を防ぐ。
//
// createShipState()は艦を生成する際、対応するカスタム配置が
// localStorageにあればそちらを優先し、なければ艦種プリセットの
// デフォルト配置（makeThrusterList()で組んだもの）を使う。
// -------------------------------------------------------------
const THRUSTER_STORAGE_KEY_PREFIX = 'spaceSimThrusters:';

// 指定した艦種のカスタムスラスター配置を読み込む。保存が無い、
// またはパース失敗時はnullを返す（呼び出し側はデフォルトへ
// フォールバックする）。
function loadCustomThrusters(classKey) {
  try {
    const raw = localStorage.getItem(THRUSTER_STORAGE_KEY_PREFIX + classKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    console.warn(`スラスター配置(${classKey})の読み込みに失敗しました。デフォルトを使用します。`, e);
    return null;
  }
}

// 指定した艦種のカスタムスラスター配置を保存する。
function saveCustomThrusters(classKey, thrusters) {
  try {
    localStorage.setItem(THRUSTER_STORAGE_KEY_PREFIX + classKey, JSON.stringify(thrusters));
    return true;
  } catch (e) {
    console.warn(`スラスター配置(${classKey})の保存に失敗しました。`, e);
    return false;
  }
}

// 指定した艦種のカスタムスラスター配置を削除し、艦種プリセットの
// デフォルト配置に戻す（thruster-editor.htmlの「リセット」用）。
function resetCustomThrusters(classKey) {
  try {
    localStorage.removeItem(THRUSTER_STORAGE_KEY_PREFIX + classKey);
    return true;
  } catch (e) {
    console.warn(`スラスター配置(${classKey})のリセットに失敗しました。`, e);
    return false;
  }
}

// -------------------------------------------------------------
// 艦種ごとのカスタム3Dモデル（ship-builder.html）の永続化
//
// ship-builder.htmlで保存し、index.html側の起動処理
// (loadSavedShipModelInto())が読み込んで仮の箱メッシュと差し替える。
// 保存形式の詳細は09-ship-builder.js冒頭のコメントを参照。
//
// v13: localStorage（Base64文字列として保存）はオリジン全体で
// 5〜10MB程度しか使えず、GLBモデル1体でもQuotaExceededErrorで
// 保存に失敗することがあったため、IndexedDBへ移行。
// IndexedDBはBlob/ArrayBufferをそのまま保存でき、上限も
// 数百MB〜GB単位（ブラウザ・空き容量依存）とはるかに大きい。
// これに伴い load/save/removeはすべてPromiseを返す非同期関数になった
// （呼び出し側はasync/await、または.then()で扱うこと）。
// -------------------------------------------------------------
const SHIP_MODEL_DB_NAME = 'spaceSimShipModels';
const SHIP_MODEL_DB_VERSION = 1;
const SHIP_MODEL_STORE_NAME = 'models';
const SHIP_MODEL_STORAGE_PREFIX = 'spaceSimShipModel:'; // 旧localStorageキー（移行用）

let shipModelDbPromise = null;

function openShipModelDb() {
  if (shipModelDbPromise) return shipModelDbPromise;
  shipModelDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('このブラウザ環境ではIndexedDBが利用できません。'));
      return;
    }
    const req = indexedDB.open(SHIP_MODEL_DB_NAME, SHIP_MODEL_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SHIP_MODEL_STORE_NAME)) {
        db.createObjectStore(SHIP_MODEL_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDBを開けませんでした。'));
  });
  return shipModelDbPromise;
}

// 旧バージョン（v12以前）でlocalStorageに保存されたモデルがあれば
// 一度だけIndexedDBへ引き継ぎ、localStorage側は削除する。
// 対象が無ければ何もしない。失敗しても致命的ではないため握りつぶす。
async function migrateShipModelFromLocalStorage(classKey, db) {
  try {
    const raw = localStorage.getItem(SHIP_MODEL_STORAGE_PREFIX + classKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SHIP_MODEL_STORE_NAME, 'readwrite');
      tx.objectStore(SHIP_MODEL_STORE_NAME).put(parsed, classKey);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    localStorage.removeItem(SHIP_MODEL_STORAGE_PREFIX + classKey);
    console.info(`艦モデル(${classKey})をlocalStorageからIndexedDBへ移行しました。`);
    return parsed;
  } catch (e) {
    console.warn(`艦モデル(${classKey})の旧データ移行に失敗しました。`, e);
    return null;
  }
}

async function loadShipModelData(classKey) {
  try {
    const db = await openShipModelDb();
    const fromDb = await new Promise((resolve, reject) => {
      const tx = db.transaction(SHIP_MODEL_STORE_NAME, 'readonly');
      const req = tx.objectStore(SHIP_MODEL_STORE_NAME).get(classKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (fromDb) return fromDb;
    // IndexedDBに無ければ、旧localStorage保存分の移行を試みる
    return await migrateShipModelFromLocalStorage(classKey, db);
  } catch (e) {
    console.warn(`艦モデル(${classKey})の読み込みに失敗しました。`, e);
    return null;
  }
}

async function saveShipModelData(classKey, data) {
  const db = await openShipModelDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SHIP_MODEL_STORE_NAME, 'readwrite');
    tx.objectStore(SHIP_MODEL_STORE_NAME).put(data, classKey);
    tx.oncomplete = resolve;
    // QuotaExceededErrorはここに来る（IndexedDBでも上限はあるが、
    // localStorageよりはるかに大きく、実用上ほぼ問題にならない）
    tx.onerror = () => reject(tx.error);
  });
}

async function removeShipModelData(classKey) {
  const db = await openShipModelDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SHIP_MODEL_STORE_NAME, 'readwrite');
    tx.objectStore(SHIP_MODEL_STORE_NAME).delete(classKey);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  // 旧localStorage側にも残っていれば併せて掃除する
  try { localStorage.removeItem(SHIP_MODEL_STORAGE_PREFIX + classKey); } catch (e) {}
}

// -------------------------------------------------------------
// 小さなベクトル/クォータニオンユーティリティ
// （Three.js非依存。05-ship-controller.js側でThree.jsの
//   Vector3/Quaternionとの相互変換を行う）
// 02-input.js以降の全ファイルから参照される共通基盤のため、読み込み順が
// 最初になるこのファイルに配置している。
// -------------------------------------------------------------
function vecLength(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vecNormalize(v) {
  const len = vecLength(v);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function vecScale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vecDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function vecCross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function vecAdd(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// クォータニオンの共役（逆回転）。正規化済みクォータニオンでは
// 逆元と一致するため、ワールド→ローカル座標変換に使う
// （rotateVecByQuat(v, conjugateQuat(q)) でqと逆方向の回転を適用できる）
function conjugateQuat(q) {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

// クォータニオン回転（ハミルトン積によるベクトル回転、
// Three.jsのQuaternion.applyToVectorと同等の計算をThree.js非依存で実装）
function rotateVecByQuat(v, q) {
  // q * v * q^-1 を展開した公式
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const { x: vx, y: vy, z: vz } = v;

  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}
