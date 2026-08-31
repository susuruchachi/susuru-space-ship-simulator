// =============================================================
// 03-thruster-solver.js
// 推力配分ソルバー
//
// 「欲しい並進力ベクトル」と「欲しいトルクベクトル」（どちらも
// 艦ローカル座標系）を受け取り、艦が持つ各スラスターについて
// 出力比（0..1）を自動で割り当てる。
//
// 手法: 簡易貪欲法（擬似逆行列を使った厳密な最小二乗配分ではない）。
// 各スラスターの「反作用ベクトル」（=噴射方向の逆）が、
//   - 並進側: 欲しい並進力方向とどれだけ揃っているか（内積）
//   - 回転側: 位置×反作用ベクトル（モーメントアーム）が
//             欲しいトルク方向とどれだけ揃っているか（内積）
// をそれぞれ評価し、正の寄与を持つスラスターだけを
// 評価値に応じた比率で焚く。
//
// 艦の慣性テンソルを正確にモデル化した完全な力学的最適配分ではなく、
// 「それっぽく直感的に動く」ことを優先した近似実装。
// スラスター配置が極端に偏っている場合、望んだ方向とズレた
// 合成力になることがある点は既知の制約（v01時点）。
// =============================================================

const ThrusterSolver = {
  // -----------------------------------------------------------
  // デバッグ用ドッキングログ（一時的な調査機能）。
  // _buildDesiredForAutoDockingが呼ばれるたびに、フェーズ判定に
  // 使った生の物理量をリングバッファへ積む。HUDの「ログDL」
  // ボタン（06-hud.js）から任意のタイミングでJSON/CSVとして
  // ダウンロードできる。原因調査用の一時コードなので、原因が
  // 特定できたら削除して構わない。
  // -----------------------------------------------------------
  DOCKING_LOG_MAX_ENTRIES: 20000,
  _dockingLog: [],

  _logDockingFrame(entry) {
    this._dockingLog.push(entry);
    if (this._dockingLog.length > this.DOCKING_LOG_MAX_ENTRIES) {
      // 古いものから間引く（先頭を捨てる）。
      this._dockingLog.splice(0, this._dockingLog.length - this.DOCKING_LOG_MAX_ENTRIES);
    }
  },

  clearDockingLog() {
    this._dockingLog = [];
  },

  getDockingLog() {
    return this._dockingLog;
  },

  // 並進のみを要求している時（ユーザーがrotate入力をしていない時）に
  // 発生する「意図しない残留トルク」を、これ未満なら無視する閾値。
  // ゼロにすると浮動小数点誤差レベルの極小トルクにまで補正パスが
  // 反応してしまい無駄な計算とわずかな振動の原因になるため、
  // 小さな余裕を持たせる。
  UNWANTED_TORQUE_EPSILON: 1e-4,

  // 残留トルク相殺の反復回数上限。1回の相殺で新たに動員したRCSが
  // また別の残留トルクを生むことがあるため複数回繰り返して収束させる
  // （斜め配置のRCSが複数の並進成分を同時に持つ艦体では1回で
  // 収束しないケースが確認されている）。
  UNWANTED_TORQUE_MAX_ITERATIONS: 6,

  // -----------------------------------------------------------
  // メインエントリ
  //   ship: createShipState()で作った艦（ship.thrustersを参照）
  //   desiredForce: 欲しい並進力ベクトル（ローカル座標、大きさは
  //                 「最大でどれだけ欲しいか」の相対値でよい）
  //   desiredTorque: 欲しいトルクベクトル（ローカル座標）
  // 戻り値: { [thrusterId]: outputRatio(0..1), ... }
  // -----------------------------------------------------------
  //
  // 既知の不具合と対策（v07）:
  //   ストレイフ（左右/上下の並進のみ要求、desiredTorque=0）でも
  //   艦が勝手に旋回してしまう不具合があった。原因は_scoreThrusters()
  //   の貪欲法が各スラスターを完全に独立評価するだけで、採用した
  //   スラスター群の「合成トルク」がゼロになるよう解いているわけ
  //   ではなかったこと。特にrocket級のfwd/aft RCSペアは噴射方向が
  //   非対称（fwd側だけ前向き成分を持つ）ため、forceScoreの大きさが
  //   ペア間でわずかにズレ、片方が多めに焚かれて残留ヨートルクを
  //   生んでいた。
  //
  //   対策として、通常の並進ソルブ後に「そのratiosで実際に生じる
  //   合成トルク」を計算し、ユーザーが回転を要求していない場合は
  //   その残留トルクを打ち消す方向の補正トルクを追加でソルブして
  //   合成する2パス方式にした（_cancelUnwantedTorque）。
  // -----------------------------------------------------------
  // v22: 「rollの自動追従を追加したら、pitch/yawの収束が悪化した
  // （揃わなくなった）」という報告への対応。
  //
  // 原因: 艦のRCS配置はpitch/yaw用クラスタ（fwd/aft）とroll専用
  // クラスタ（roll_*、position×forceの外積がZ成分しか持たないよう
  // 意図的に分離配置されている、01-state-and-config.js参照）に
  // 物理的に完全分離されている。にもかかわらず、desiredTorque=
  // {x,y,z}をpitch/yaw/rollまとめて1本の合成ベクトルとして正規化し、
  // 各スラスターを「その合成方向にどれだけ寄与できるか」の単一
  // スコアで評価すると、
  //   1) pitch/yawクラスタはroll方向には全く寄与できないのに、
  //      torqueDirにroll成分が混じるほど実効スコアが下がり出力が
  //      弱まる
  //   2) 合成ベクトルの大きさ(torqueMag)が3軸分の二乗和になるため
  //      クランプされやすく、各軸が本来より弱いスケールで出力される
  // という問題が生じる（force/pitchYaw/rollの3方向を加重平均する
  // 案も試したが、pitch/yawクラスタの評価にroll要求の重みが混入
  // する構図は変わらず、むしろ悪化した。シミュレーションで確認）。
  //
  // 対策: _solveRawをforce+pitchYaw用とroll用で2回に分けて呼び、
  // 出力比を合算する。物理的に別クラスタなので、同じスラスターが
  // 両方の呼び出しで正の比率を得ることはまず無く（roll専用スラス
  // ターはforce/pitchYawのarmを持たない設計）、単純な加算で安全に
  // 合成できる。念のため合算後は1.0でクランプする。
  solve(ship, desiredForce, desiredTorque) {
    const pitchYawTorque = { x: desiredTorque.x, y: desiredTorque.y, z: 0 };
    const rollTorque = { x: 0, y: 0, z: desiredTorque.z };

    const ratios = this._solveRaw(ship, desiredForce, pitchYawTorque);
    const rollRatios = this._solveRaw(ship, { x: 0, y: 0, z: 0 }, rollTorque);
    for (const id in rollRatios) {
      ratios[id] = clamp((ratios[id] || 0) + rollRatios[id], 0, 1);
    }

    // ユーザーが明示的に回転を要求していない間だけ、並進操作が
    // 生んだ残留トルクを補正する（回転要求がある時は、ユーザーの
    // 意図した回転と補正がぶつかり合ってしまうため補正しない）。
    const torqueMag = vecLength(desiredTorque);
    if (torqueMag < 1e-6) {
      this._cancelUnwantedTorque(ship, ratios);
    }

    return ratios;
  },

  // -----------------------------------------------------------
  // 通常の貪欲法ソルブ本体（旧solve()の中身）
  // -----------------------------------------------------------
  _solveRaw(ship, desiredForce, desiredTorque) {
    const ratios = {};
    const thrusters = ship.thrusters;

    const forceMag = vecLength(desiredForce);
    const torqueMag = vecLength(desiredTorque);

    // 何も要求されていない場合は全スラスター0（早期リターン）
    if (forceMag < 1e-6 && torqueMag < 1e-6) {
      for (const t of thrusters) ratios[t.id] = 0;
      return ratios;
    }

    const forceDir = forceMag > 1e-6 ? vecNormalize(desiredForce) : null;
    const torqueDir = torqueMag > 1e-6 ? vecNormalize(desiredTorque) : null;

    // 要求の「大きさ」を0..1のスケールとして扱う。desiredForce/
    // desiredTorqueはbuildDesiredFromInput()で通常は各成分が-1..1の
    // 入力値からそのまま組み立てられるため、成分が1軸だけならmagは
    // 最大1、複数軸が同時に入っていれば1を超えることもある
    // （例: 前進+ストレイフ同時入力でforceMagが√2程度になる）。
    // 出力比の物理的な意味は「そのスラスターの最大推力に対する比率」
    // なので1を超えないようクランプする。
    const forceScale = clamp(forceMag, 0, 1);
    const torqueScale = clamp(torqueMag, 0, 1);

    // 各スラスターの寄与度（評価値、方向の一致度のみ。-1..1）を計算
    const scores = thrusters.map((t) => {
      const dirNorm = vecNormalize(t.direction);
      const reaction = vecScale(dirNorm, -1); // 反作用方向＝噴射方向の逆

      let forceScore = 0;
      if (forceDir) {
        forceScore = vecDot(reaction, forceDir); // -1..1
      }

      let torqueScore = 0;
      if (torqueDir) {
        const arm = vecCross(t.position, reaction); // モーメントアーム寄与
        const armLen = vecLength(arm);
        if (armLen > 1e-6) {
          torqueScore = vecDot(vecNormalize(arm), torqueDir); // -1..1
        }
      }

      // 並進要求と回転要求、両方が同時に出ている場合は加重平均
      // （要求されている方の比重が大きいほどそちらを優先）。
      // 重みは各要求の「大きさ」（forceMag/torqueMag）で決める—
      // 例えば並進要求はわずかで回転要求が強い場合、回転側の
      // スコアをより強く反映すべきなため。
      let combinedScore;
      let combinedScale;
      if (forceDir && torqueDir) {
        const wF = forceMag / (forceMag + torqueMag);
        const wT = torqueMag / (forceMag + torqueMag);
        combinedScore = forceScore * wF + torqueScore * wT;
        combinedScale = forceScale * wF + torqueScale * wT;
      } else if (forceDir) {
        combinedScore = forceScore;
        combinedScale = forceScale;
      } else {
        combinedScore = torqueScore;
        combinedScale = torqueScale;
      }

      return { thruster: t, score: combinedScore, scale: combinedScale };
    });

    // 正の寄与を持つスラスターのみ採用。出力比 = 方向の一致度(score)
    // × 要求の大きさ(scale)。以前はscoreのみを出力比としており、
    // desiredForce/desiredTorqueのノルム（入力の強弱）が正規化で
    // 失われ、rotateYaw=0.2でもrotateYaw=1.0でも同じ角速度になる
    // バグがあった（アナログ入力が事実上デジタルスイッチ化していた）。
    for (const { thruster, score, scale } of scores) {
      ratios[thruster.id] = score > 0 ? clamp(score * scale, 0, 1) : 0;
    }

    return ratios;
  },

  // -----------------------------------------------------------
  // ratiosで実際に生じる合成トルク（ローカル座標）を計算する。
  // -----------------------------------------------------------
  _computeResultingTorque(ship, ratios) {
    let totalTorque = { x: 0, y: 0, z: 0 };
    for (const t of ship.thrusters) {
      const ratio = ratios[t.id] ?? 0;
      if (ratio <= 0) continue;
      const dirNorm = vecNormalize(t.direction);
      const reaction = vecScale(dirNorm, -1);
      const force = vecScale(reaction, getEffectiveMaxThrust(ship, t) * ratio);
      const torque = vecCross(t.position, force);
      totalTorque = vecAdd(totalTorque, torque);
    }
    return totalTorque;
  },

  // -----------------------------------------------------------
  // 並進のみの要求（ユーザーが回転操作をしていない）で生じた
  // 残留トルクを、追加のRCS噴射で打ち消す。
  //
  // 手法: 実際に生じたトルクの大きさをそのまま「欲しいトルク」の
  // 大きさとして_solveRaw()を再度呼び、逆方向のトルクを別途ソルブ、
  // 得られた補正比率を既存ratiosに加算する。1回の相殺で新たに
  // 動員したRCSが（斜め配置などにより）別の軸へのトルクを新たに
  // 生むことがあるため、残留トルクが十分小さくなるか上限回数に
  // 達するまでこれを繰り返す（反復法）。
  //
  // トルクの「大きさ」はスラスター推力とモーメントアームのスケールに
  // 依存する物理量であり、desiredForce/desiredTorqueが前提とする
  // 0..1の正規化スケールとは単位が異なる。そのため大きさ部分は
  // 艦の慣性(inertia)で正規化し、補正比率が暴れないよう1にクランプ
  // した「補正の強さ」として扱う（厳密な物理量ではなく実用上の近似）。
  // -----------------------------------------------------------
  _cancelUnwantedTorque(ship, ratios) {
    for (let i = 0; i < this.UNWANTED_TORQUE_MAX_ITERATIONS; i++) {
      const resultingTorque = this._computeResultingTorque(ship, ratios);
      const torqueLen = vecLength(resultingTorque);
      if (torqueLen < this.UNWANTED_TORQUE_EPSILON) break;

      // 打ち消したい方向 = 生じたトルクと逆向き。大きさは慣性で
      // 正規化し0..1にクランプ（過剰補正で暴れないよう）。
      const cancelDir = vecScale(resultingTorque, -1 / torqueLen);
      const cancelStrength = clamp(torqueLen / ship.inertia, 0, 1);
      const cancelTorque = vecScale(cancelDir, cancelStrength);

      const correctionRatios = this._solveRaw(ship, { x: 0, y: 0, z: 0 }, cancelTorque);

      // 今回の反復で何らかの補正が実際に加算されたかを確認する。
      // 既に対象スラスターが軒並み1.0で頭打ちだと、これ以上加算しても
      // 変化が起きず無限に近い反復になり得るため、変化が無ければ
      // その時点で打ち切る。
      let anyChange = false;
      for (const t of ship.thrusters) {
        const added = correctionRatios[t.id] ?? 0;
        if (added <= 0) continue;
        const before = ratios[t.id] ?? 0;
        const after = clamp(before + added, 0, 1);
        if (after !== before) anyChange = true;
        ratios[t.id] = after;
      }
      if (!anyChange) break;
    }
  },

  // -----------------------------------------------------------
  // State.input（正規化された-1..1の操作入力）から
  // 「欲しい並進力ベクトル」と「欲しいトルクベクトル」を組み立てる。
  // 04-flight-physics.js から呼ばれる想定。
  //
  //   ship: 自動姿勢制動・並進制動（下記）のために
  //         ship.angularVelocity / ship.velocity / ship.quaternionを
  //         参照する。ship省略時はどちらも行わない単純変換のみ
  //         （テスト等でship不要な場合の後方互換）。
  //
  // 自動姿勢制動（ダンピング）:
  //   ユーザーが回転入力（rotatePitch/Yaw/Roll）を離すと、抵抗ゼロの
  //   宇宙空間では角速度がそのまま残り続け「延々と回り続ける」体感
  //   になっていた（バグ報告）。これに対応するため、回転入力が実質
  //   ゼロの間はship.angularVelocityを打ち消す方向のトルク要求を
  //   代わりに発生させ、RCSが自動で逆噴射して回転を止めるようにする。
  //   ユーザーが実際に回転操作をしている間（入力が閾値を超えている
  //   間）はこの自動制動を割り込ませず、操作を優先する。
  //   設定: State.settings.autoDampingEnabled。
  //
  // 並進制動（機首方向への慣性キャンセル、v07で再設計、v10で
  // トグルを自動姿勢制動から分離＝「逆噴射用のSRC」の独立化）:
  //   「船首の向きを変えても、慣性で元の軌道方向へ進み続けてしまう。
  //   それを止めて、船首が向いている方向へ実際の移動方向も収束させて
  //   ほしい」という要望に対応。
  //
  //   v05までは「機首を速度ベクトル方向へ回転させる」トルクとして
  //   実装しており、v06でこれを廃止して「機首方向（ローカルZ）以外の
  //   速度成分を並進力だけで打ち消す」設計に一本化した。
  //   しかしv06はローカルX/Yのみを制動対象とし、ローカルZ（前後）は
  //   スロットル保持値をそのまま推力として使い続けていたため、旋回で
  //   機首の向きが変わった瞬間、それまでの慣性速度ベクトルの
  //   ローカルZ成分が変化しても一切打ち消されず、新しい機首方向への
  //   加速と相殺せずに残ってしまい、「制動が効いて元の進路方向へ
  //   戻ろうとしているように見える」不具合になっていた。
  //
  //   v07ではZ軸も「スロットル値＝目標推力」から「スロットル値＝
  //   目標ローカルZ速度（-1..1をmaxSpeedにスケール、boost時は
  //   boostMult倍）」に変更。現在のローカルZ速度との差分を、X/Yの
  //   ブレーキと同じ比例制御（差が大きいほどフル推力に近づく）で
  //   埋める。これにより旋回直後は「新しい機首方向のローカルZ速度が
  //   目標より小さい（または逆符号）」状態になり、メインスラスターが
  //   自動的にその差を埋める形で新しい進路へ加速する。回転トルクは
  //   一切生成しないため、この制動が旋回を誘発することはない。
  //   なお、このZ軸速度追従自体はスロットルレバーの基本動作であり
  //   トグルの対象外（常時有効）。ON/OFFできるのはX/Yのストレイフ
  //   慣性キャンセル（retroDampingEnabled）のみ。
  //
  //   v10: このX/Y並進制動のトグルを、回転ダンピング用の
  //   autoDampingEnabledから独立したretroDampingEnabledへ分離した。
  //   「逆噴射用のSRC（並進の自動逆噴射）だけ切りたい／回転制動だけ
  //   切りたい」という使い分けができなかったための対応。
  // -----------------------------------------------------------
  ROTATION_INPUT_DEADZONE: 0.02, // これ未満の合計入力量は「入力なし」とみなす
  AUTO_DAMPING_MIN_ANGULAR_SPEED: 0.01, // これ未満の角速度は制動不要（無限収束を防ぐ）
  // v09: 艦種依存のオーバーシュート/振り切れ不具合対応のため、固定閾値の
  // 比例制動は_computeOvershootSafeBrakeTorque()に置き換えて廃止した。
  // 定数自体は他コードから参照されなくなったが、過去バージョンとの
  // 差分把握用に残置（実際のブレーキ計算では使用しない）。
  AUTO_DAMPING_FULL_BRAKE_THRESHOLD: 0.3,
  STRAFE_INPUT_DEADZONE: 0.02, // これ未満のストレイフ入力は「入力なし」とみなす
  STRAFE_DAMPING_MIN_SPEED: 0.05, // これ未満のローカルXY速度は制動不要（無限収束を防ぐ）
  STRAFE_DAMPING_FULL_BRAKE_SPEED: 6.0, // このローカルXY速度以上でフル制動、未満は比例して弱める
  // v35: headingHold（姿勢調整中）専用の全方位フルブレーキが
  // フル出力になる速度閾値。姿勢が乱れている間は「進入軸方向/横方向」
  // の区別自体が信用できないため、ローカル速度の大きさ全体を見て
  // 制動を効かせる（_buildDesiredForAutoDockingのheadingHold分岐参照）。
  DOCKING_HEADING_HOLD_BRAKE_FULL_SPEED: 3.0,
  FORWARD_VELOCITY_FULL_THROTTLE_ERROR: 40.0, // 目標Z速度との差がこれ以上でフル推力、未満は比例して弱める（オーバーシュート防止）

  // v09: 目標角度に対する「ぴったり停止」用の不感帯(rad)。
  // 船首方向と目標方向の角度差がこれを下回ったら、オートドッキングの
  // 姿勢制御トルク要求・角速度ダンピングの両方を打ち切り、
  // 代わりに角速度そのものを強制的にゼロへ吸収する（後述の
  // _lockHeadingIfWithinTolerance参照）。従来はAUTO_DAMPING_MIN_ANGULAR_SPEED
  // 未満の角速度を無視するだけで、誤差を消し込む力そのものが
  // 無かったため、わずかなオーバーシュート後の残留角速度分だけ
  // 目標角をわずかに外れ続け、それを打ち消そうとRCSが低出力で
  // 吹きっぱなしになる不具合があった。
  HEADING_LOCK_TOLERANCE_DEG: 0.01,

  // -----------------------------------------------------------
  // v09: 艦のRCSロールクラスタ構成から、各軸(pitch/yaw/roll)が
  // 出せる「概算の最大角加速度」(rad/s^2)を求める。
  //
  // 目的: 自動姿勢制動のブレーキ強度を「角速度に比例した固定の
  // 強さ」ではなく「今の角速度をこのdtでちょうどゼロにできる分」
  // として計算するため。艦種ごとに慣性(inertia)もスラスター推力・
  // 配置も大きく異なる（ロケット級 inertia=800 〜 戦艦級
  // inertia=4,200,000）ため、固定のAUTO_DAMPING_FULL_BRAKE_THRESHOLDだけでは
  // 重い艦（巡洋艦・戦艦級）で制動力が絶対的に不足してオーバーシュート
  // し続け、軽い艦では逆に強すぎて振動する、という艦種依存の不具合が
  // あった。
  //
  // 全スラスターについて「そのスラスターをフル出力にしたら生じる
  // トルク」を求め、軸ごとに正の寄与を合計することで概算最大トルクを
  // 出し、慣性で割って角加速度に変換する（実際のソルバーの貪欲法とは
  // 独立した見積もりだが、ブレーキ強度のスケール決定用としては十分）。
  // 艦のthrustersが変わらない限り結果は不変のため、艦オブジェクトに
  // キャッシュして毎フレームの再計算を避ける。
  // -----------------------------------------------------------
  _estimateMaxAngularAccel(ship) {
    if (ship._maxAngularAccelCache && ship._maxAngularAccelCacheThrusters === ship.thrusters) {
      return ship._maxAngularAccelCache;
    }

    const maxTorque = { x: 0, y: 0, z: 0 };
    for (const t of ship.thrusters) {
      const dirNorm = vecNormalize(t.direction);
      const reaction = vecScale(dirNorm, -1);
      const force = vecScale(reaction, getEffectiveMaxThrust(ship, t));
      const torque = vecCross(t.position, force);
      maxTorque.x += Math.abs(torque.x);
      maxTorque.y += Math.abs(torque.y);
      maxTorque.z += Math.abs(torque.z);
    }

    // 全スラスター同時フル出力という現実には起きない前提の合計なので
    // 過大評価気味だが、ブレーキ強度はこれを分母にしても最終的に
    // 「オーバーシュートしない」方向（強めに見積もって弱めにブレーキ
    // する）に働くため安全側。半分程度を実用値として採用する。
    const SAFETY_FACTOR = 0.5;
    const result = {
      x: (maxTorque.x / ship.inertia) * SAFETY_FACTOR,
      y: (maxTorque.y / ship.inertia) * SAFETY_FACTOR,
      z: (maxTorque.z / ship.inertia) * SAFETY_FACTOR,
    };

    ship._maxAngularAccelCache = result;
    ship._maxAngularAccelCacheThrusters = ship.thrusters;
    return result;
  },

  // -----------------------------------------------------------
  // v17: 艦のスラスター構成から、ローカル+Z方向（船尾側＝前進方向を
  // 減速させる逆噴射側）に出せる概算の最大並進減速度(m/s^2)を求める。
  // _estimateMaxAngularAccel()と同じ考え方: 全スラスターが同時に
  // フル出力という過大評価を安全係数で割り引く。
  //
  // 用途: オートドッキングの接近ブレーキを「目的地到達時にちょうど
  // 速度0になる制動距離」から逆算するため（_computeDockingStoppingDistance
  // 参照）。回転側の_estimateMaxAngularAccel()と対になる並進版。
  // -----------------------------------------------------------
  _estimateMaxLinearDecel(ship) {
    if (ship._maxLinearDecelCache && ship._maxLinearDecelCacheThrusters === ship.thrusters) {
      return ship._maxLinearDecelCache;
    }

    // 艦ローカル+Z方向（後方）へ艦を押せる合計反作用推力を集計する
    // （＝前進中の艦を減速させられるスラスター群の合計）。
    let maxDecelForceZ = 0;
    for (const t of ship.thrusters) {
      const dirNorm = vecNormalize(t.direction);
      const reaction = vecScale(dirNorm, -1);
      if (reaction.z > 1e-6) {
        maxDecelForceZ += reaction.z * getEffectiveMaxThrust(ship, t);
      }
    }

    // v17: 並進の減速は「retro系スラスターが常にセットで同時に
    // フル稼働する」構成であり、回転のように「軸ごとに寄与する
    // スラスターの組み合わせが変わる」ような過大評価要素が無い。
    // そのため_estimateMaxAngularAccel()ほど強い安全係数は不要。
    // ただし1フレーム分のタイミングずれ等を見込んで少しだけ
    // 割り引く（1.0だと理論値ぎりぎりでわずかなオーバーシュートが
    // 起こりうるため）。
    const SAFETY_FACTOR = 0.75;
    const result = Math.max(1e-3, (maxDecelForceZ / ship.mass) * SAFETY_FACTOR);

    ship._maxLinearDecelCache = result;
    ship._maxLinearDecelCacheThrusters = ship.thrusters;
    return result;
  },

  // -----------------------------------------------------------
  // v20: 艦のスラスター構成から、ローカルX/Y方向（横方向、RCS担当）に
  // 出せる概算の最大並進減速度(m/s^2)を求める。_estimateMaxLinearDecel
  // （Z軸＝主機関・逆噴射担当）の横方向版。
  //
  // 用途: 「旋回によって生じた横滑りを、RCSだけで目的地に着くまでに
  // 消しきれるか」を判定する（_updateMomentumKillState参照）ため。
  //
  // X軸・Y軸それぞれの合計反力を求め、小さい方（＝より非力な軸）を
  // 採用する。横滑りの向きは任意なので、片方の軸しか強くなくても
  // 意味が無く、両軸とも同程度に出せて初めて「どの向きの横滑りも
  // 安全に止められる」と言えるため。X/Y共有のRCSクラスタは互いの
  // 出力を食い合うことも多いSAFETY_FACTORはZ軸より保守的にしてある。
  // -----------------------------------------------------------
  _estimateMaxLateralDecel(ship) {
    if (ship._maxLateralDecelCache && ship._maxLateralDecelCacheThrusters === ship.thrusters) {
      return ship._maxLateralDecelCache;
    }

    let maxForceX = 0;
    let maxForceY = 0;
    for (const t of ship.thrusters) {
      const dirNorm = vecNormalize(t.direction);
      const reaction = vecScale(dirNorm, -1);
      maxForceX += Math.abs(reaction.x) * getEffectiveMaxThrust(ship, t);
      maxForceY += Math.abs(reaction.y) * getEffectiveMaxThrust(ship, t);
    }

    const SAFETY_FACTOR = 0.4;
    const minForce = Math.min(maxForceX, maxForceY);
    const result = Math.max(1e-3, (minForce / ship.mass) * SAFETY_FACTOR);

    ship._maxLateralDecelCache = result;
    ship._maxLateralDecelCacheThrusters = ship.thrusters;
    return result;
  },

  // -----------------------------------------------------------
  // v09: 角速度ベクトルを「このdtでオーバーシュートせずに止める」
  // ブレーキ用トルク方向・強さに変換する。
  //
  // 従来は角速度の大きさに比例した0..1のbrakeStrengthを出力比に
  // 直接使っていたが、これは「艦がその強さでどれだけ角加速度を
  // 出せるか」を一切考慮しておらず、
  //   - 重い艦（巡洋艦・戦艦級）: 角加速度の絶対量が足りず、
  //     brakeStrength=1.0でも1フレームで角速度を打ち消しきれず
  //     目標を行き過ぎる（オーバーシュート／振り切れ）
  //   - 軽い艦（ロケット級）: 逆に角加速度が過剰で、1フレームで
  //     角速度を追い越して反転→また逆向きにブレーキ、の振動
  // という艦種依存の不具合を生んでいた。
  //
  // 対策: 各軸ごとに「このdtで角速度をぴったりゼロにするために
  // 必要な角加速度」(=angVel/dt) を求め、_estimateMaxAngularAccel()
  // で概算した艦の最大角加速度に対する比率をbrakeStrengthとする。
  // 比率が1を超える（＝艦の最大角加速度でも1フレームで止めきれない
  // ほど角速度が大きい）場合のみ1.0（フル制動）にクランプする。
  // これにより「艦の実力に対して必要な分だけ」出力するため、
  // 重い艦でも軽い艦でも行き過ぎない制動になる。
  // -----------------------------------------------------------
  _computeOvershootSafeBrakeTorque(ship, angularVelocity, dt) {
    const maxAccel = this._estimateMaxAngularAccel(ship);
    const safeDt = Math.max(dt, 1 / 240); // dtが極端に小さい/0の場合の保険

    const brake = { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z']) {
      const w = angularVelocity[axis];
      if (Math.abs(w) < 1e-9) continue;

      const neededAccel = Math.abs(w) / safeDt; // このdtでゼロにするために必要な角加速度
      const available = Math.max(maxAccel[axis], 1e-9);
      const strength = clamp(neededAccel / available, 0, 1);
      brake[axis] = -Math.sign(w) * strength;
    }
    return brake;
  },

  // -----------------------------------------------------------
  // v09: 船首方向と目標方向の角度差がHEADING_LOCK_TOLERANCE_DEG未満
  // まで収束した際、そのまま残ってしまう微小な角速度を「なかった
  // ことにする」ための強制ロック。
  //
  // 従来はAUTO_DAMPING_MIN_ANGULAR_SPEED未満の角速度を単に無視する
  // （ブレーキをかけない）だけだったため、目標角度のすぐ近くに
  // 極小の角速度で漂着すると、その残留角速度自体は消えないまま
  // 「補正不要」と判定され続け、結果としてわずかに目標角度から
  // ズレたままRCSが低出力で吹き続ける、というユーザー報告の不具合
  // （「その誤差を治すためにずっとスラスターが吹きっぱなしになる」）
  // の原因になっていた。
  //
  // 対策: 角度差が許容範囲内に入った時点でship.angularVelocityの
  // 該当軸成分を直接ゼロに落とす（トルクではなく状態への直接介入）。
  // これは他の物理法則とは独立した「オートパイロットの補助機能」
  // として明示的に許容する（現実のドッキング操船でも最終定点保持は
  // スラスタ制御ではなくロック機構に頼ることが多い）。
  // -----------------------------------------------------------
  _lockHeadingIfWithinTolerance(ship, angleRad) {
    const toleranceRad = this.HEADING_LOCK_TOLERANCE_DEG * (Math.PI / 180);
    if (angleRad < toleranceRad) {
      ship.angularVelocity.x = 0;
      ship.angularVelocity.y = 0;
      return true;
    }
    return false;
  },

  // v22: _lockHeadingIfWithinToleranceのroll版。roll誤差(_computeRollErrorAngle
  // が返すangle)は符号付きなので、絶対値で許容範囲を判定する。
  _lockRollIfWithinTolerance(ship, signedAngleRad) {
    const toleranceRad = this.HEADING_LOCK_TOLERANCE_DEG * (Math.PI / 180);
    if (Math.abs(signedAngleRad) < toleranceRad) {
      ship.angularVelocity.z = 0;
      return true;
    }
    return false;
  },

  // -----------------------------------------------------------
  // 艦の姿勢と目的地の保存済み姿勢(target.quaternion)を比較し、
  // roll誤差角を返す。target.quaternionが定める「上ベクトル」を
  // ローカル座標へ変換し、艦の現在のローカルZ軸（船首-方向の
  // 逆＝ローカル+Z）まわりに見て、艦のローカルY軸からどれだけ
  // ズレているかをroll誤差角として返す。
  //
  // 単純に「目標の上ベクトルと艦の上ベクトルのなす角」を使うと、
  // 艦がまだ目標方向を向ききっていない（pitch/yawが大きくズレて
  // いる）間はそのズレ自体がroll誤差に混入し、不要なroll回転を
  // 誘発してしまう。それを避けるため、艦のローカルZ軸（現在の
  // 船首軸）を基準にした平面へ目標の上ベクトルを投影してから
  // 角度を測る＝「今向いている方向を軸として、上方向だけがどれだけ
  // 傾いているか」を見る形にしている。
  //
  // 戻り値: { angle, axis } のうちaxisはローカルpitch/yaw成分を
  // 含まない純粋なroll軸（0,0,±1相当）方向で、符号がそのまま
  // 回頭すべき向きを表す。
  // -----------------------------------------------------------
  _computeRollErrorAngle(ship, target) {
    const targetUpWorld = rotateVecByQuat({ x: 0, y: 1, z: 0 }, target.quaternion);
    const targetUpLocal = rotateVecByQuat(targetUpWorld, conjugateQuat(ship.quaternion));

    // 艦のローカルZ軸（船首軸）成分を取り除き、Z軸まわりの平面へ投影
    const projected = { x: targetUpLocal.x, y: targetUpLocal.y, z: 0 };
    const projLen = vecLength(projected);
    if (projLen < 1e-6) {
      // 目標の上方向がほぼ艦の船首軸と一致（＝roll軸として不定）。
      // 極めて稀（目的地姿勢が艦の現在の船首方向と同じ軸を向いて
      // いる場合）で、この場合はroll誤差を評価できないため0を返す。
      return { angle: 0, axis: { x: 0, y: 0, z: 1 } };
    }
    const currentUpLocal = { x: 0, y: 1, z: 0 };
    const projNorm = vecScale(projected, 1 / projLen);

    // currentUpLocal(0,1,0)からprojNormへの回転角・向きをZ軸まわりで求める。
    // 2D外積(x1*y2 - y1*x2)で符号、内積でcos角を得る（atan2で安定に）。
    const cross = currentUpLocal.x * projNorm.y - currentUpLocal.y * projNorm.x;
    const dot = currentUpLocal.x * projNorm.x + currentUpLocal.y * projNorm.y;
    const angle = Math.atan2(cross, dot);
    // axisは(0,0,1)固定。angleの符号がそのまま「艦のローカル+Z軸周り
    // にangleだけ回せば目標に一致する」向きに対応する。
    return { angle, axis: { x: 0, y: 0, z: 1 } };
  },

  // -----------------------------------------------------------
  // 艦の船首方向(noseLocal)から目標方向(dirLocal)へ向けるための
  // 回転角・回転軸を求める。ほぼ真後ろ（180°近く）を向きたい場合の
  // 外積縮退（sin(θ)がθ=90°を軸に対称なため、外積の長さだけでは
  // 「ほぼ正面」と「ほぼ真後ろ」を区別できない）に対応するため、
  // atan2(|cross|, dot)で0..πの全域について正しい角度を求める。
  // ちょうど180°付近で回転軸が数学的に不定になる場合は、仮の
  // 回転軸（艦のローカルX軸）で旋回のきっかけを作る。
  // -----------------------------------------------------------
  _computeHeadingAngleAndAxis(noseLocal, dirLocal) {
    const axis = vecCross(noseLocal, dirLocal);
    const crossLen = vecLength(axis);
    const dot = clamp(vecDot(noseLocal, dirLocal), -1, 1);
    const angle = Math.atan2(crossLen, dot); // 0..π（180°付近も含め正確）

    let axisNorm;
    if (crossLen > 1e-6) {
      axisNorm = vecScale(axis, 1 / crossLen);
    } else if (angle > Math.PI / 2) {
      // 外積が縮退する特異点（ほぼ真後ろ）。回転軸は数学的に不定
      // なので、仮の軸（艦のローカルX軸）で旋回のきっかけを作る。
      axisNorm = { x: 1, y: 0, z: 0 };
    } else {
      axisNorm = { x: 0, y: 0, z: 0 };
    }

    return { angle, axis: axisNorm };
  },

  // v08: 自動操船（入港）関連の調整値
  // v15: 「目的地が遠くてもまず姿勢合わせのRCSばかり吹いて主機が
  // 働かない」という報告を受け、フルトルクになる角度閾値を約3倍に
  // 緩和（0.35rad≈20° → 1.05rad≈60°）。同じ角度差でもトルクが弱く
  // 出るようになり、姿勢合わせがより穏やかになる。その代わり、
  // 目的方向にヘディングが収束した際は_lockHeadingIfWithinTolerance()
  // が残留角速度を強制的に切り捨てて即座に完全静止させるため、
  // 「弱めた分だけいつまでも微調整し続ける」ことにはならない。
  // v46: 姿勢制御（heading/roll）の比例トルク用の角度閾値。
  // 遠方（cruise/approach/adjust）では緩め、brake300/brake250/
  // final_approach/tunnel直前では厳しめにして「近づくほど姿勢を
  // きっちり合わせる」挙動にする。_computeHeadingFullTorqueAngleで
  // 距離に応じて両者を線形補間する。
  DOCKING_HEADING_FULL_TORQUE_ANGLE: 1.05, // 船首と目的方向のなす角(rad)がこれ以上でフルトルク、未満は比例して弱める（約60°）
  // これ未満の角度差は補正不要（微小振動防止）。約0.006°で、
  // HEADING_LOCK_TOLERANCE_DEG(0.01°)より厳しい値にしてある。
  // 入港基準ARRIVAL_HEADING_ERROR_DEG(0.1°)より緩い値にすると、
  // 「まだ入港基準を満たしていないのに補正不要と判定されて
  // 収束が止まる」デッドゾーンができてしまうため、ロック判定
  // よりさらに小さい値を選ぶ必要がある。
  DOCKING_HEADING_MIN_ANGLE: 0.0001,
  DOCKING_ROLL_FULL_TORQUE_ANGLE: 1.05, // roll誤差(rad)がこれ以上でフルトルク（pitch/yawの遠方用と同じ緩さ、約60°）
  DOCKING_ROLL_MIN_ANGLE: 0.0001, // これ未満のroll誤差は補正不要（DOCKING_HEADING_MIN_ANGLEと同じ理由）

  // v58: _runApproachPhaseの船首目標(steerTarget)が艦の現在位置に
  // 極端に近づいた（distanceがVIRTUAL_WAYPOINT_OFFSETに近く、
  // virtualWPの進入軸方向の位置が艦とほぼ一致する）場合に、
  // toSteerの向きをlateral由来のノイズに支配されるままにせず、
  // approachAxisWorld方向へブレンドして安定させるための閾値半径。
  // AVOIDANCE_RADIUS(250)より十分小さく、実測ログで暴れていた
  // lateralの振動幅(0.02〜0.24)より大きい値にしてある。
  HEADING_STEER_STABILIZE_RADIUS: 5.0,

  // v58-fix2: _runApproachPhaseで、安定化済みのheadingTargetWorld
  // 方向へ艦の位置から仮の目標点を置く際に使う距離。_applyApproachForce
  // 側の速度上限・制動距離判定はstoppingBasisDistance（実距離ベース）
  // で別途行われるため、この値自体は減速プロファイルに影響しない
  // （方向を安定させるためだけの仮想的な距離）。HEADING_STEER_
  // STABILIZE_RADIUSより大きければ値自体に強い意味はないが、
  // 極端に小さいと浮動小数点誤差の影響を受けやすくなるため、
  // 十分な大きさ（AVOIDANCE_RADIUS程度）にしてある。
  FORCE_AIM_POINT_DISTANCE: 250,

  // brake300/brake250/final_approach専用のフルトルク角度閾値。
  // 通常フェーズ用（約60°、遠方でも主機が働くよう緩めた値）より
  // 厳しくし、「近距離ではまず姿勢をきっちり合わせる」動きを
  // 優先させる（約20°）。
  DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE: 0.35,

  // brake300/brake250での横方向位置ずれ補正（並進）の比例ゲイン。
  // 目的地の直線進入軸からどれだけ横にずれているかに応じて、その
  // ずれを消す方向の並進力を追加する。
  DOCKING_LATERAL_CORRECTION_FULL_THRUST_OFFSET: 15.0, // 横ずれがこれ以上でフル横方向推力
  DOCKING_POSITION_MIN_DISTANCE: 0.15, // これ未満の距離は接近推力を止める（振動防止、あとは速度制動のみで静止させる）

  // v50-fix6: 一度tunnelに入った後、brake250側の位置収束の余韻による
  // わずかな揺り戻しでdistanceが250をわずかに超えて押し戻されても
  // tunnelを維持するための許容マージン。実測ログで確認された揺り戻し
  // 幅（±0.01オーダー）に十分な余裕を持たせた値。
  TUNNEL_REENTRY_TOLERANCE: 1.0,

  // v52-fix2: brake250側で既に入港基準(_meetsArrivalCriteria)を
  // 満たした後、前後方向の緩やかな減衰振動でdistanceが250をわずかに
  // 超えて揺り戻しても、final_approachへ差し戻さずbrake250を維持
  // するための許容マージン。TUNNEL_REENTRY_TOLERANCEと同じ考え方。
  BRAKE250_REENTRY_TOLERANCE: 1.0,

  // v57: approachフェーズがdistance=ZONE_ADJUST_STARTへ収束しようと
  // する過程で境界をわずかに上下し、adjustへなかなか進めない
  // デッドロックを避けるための許容マージン。TUNNEL_REENTRY_TOLERANCE/
  // BRAKE250_REENTRY_TOLERANCEと同種だが、こちらは「静止」ではなく
  // 「速度上限区間の終端」での収束のため揺り戻し幅がやや大きく
  // （実測ログで最大7程度）出ていたため、その2つより大きめの値にする。
  APPROACH_ADJUST_HYSTERESIS: 8.0,

  buildDesiredFromInput(input, ship, dt) {
    const boostMult = input.boost ? 1.6 : 1.0;
    const autoDampingOn = ship && (State.settings.autoDampingEnabled ?? true);
    // v10: 並進制動（逆噴射でのX/Y慣性キャンセル）は、回転ダンピングの
    // autoDampingEnabledから独立したretroDampingEnabledで制御する
    // （「逆噴射用のSRCを独立させたい」という要望対応）。
    const retroDampingOn = ship && (State.settings.retroDampingEnabled ?? true);
    // v08: 自動操船（入港）が有効か。有効かつ目的地が設定済みの場合のみ
    // 自動操船ロジックへ分岐する（目的地未設定なら自動操船フラグが
    // 立っていても通常の手動ロジックにフォールバックする）。
    const autoDockingOn = ship && ship.autoDockingEnabled && State.dockingTarget;

    if (autoDockingOn) {
      return this._buildDesiredForAutoDocking(input, ship, dt);
    }

    // v58: 手動操船中もログに1行残す（要望「ログに…手動操船のステータスを
    // 追加して」対応）。従来はこのデバッグログが_buildDesiredForAutoDocking
    // 内でしか書かれておらず、自動操船が実際に動いている間の行しか
    // 存在しなかったため、「艦がグルグルしたのは自動操船中だったのか
    // 手動操船中だったのか」がログだけからは判別できなかった。ここでは
    // phase/distance/alongDist/lateralなど自動操船固有の物理量を
    // 意味もなく埋めることはせず、manualControl:trueと目的地の有無・
    // 現在の艦の位置・速度・角速度だけを記録する（自動操船中の行との
    // 判別はmanualControl列で行う）。
    if (ship) {
      this._logDockingFrame({
        t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
        phase: null,
        prevPhase: ship._dockingPhasePrevForLog || null,
        distance: null,
        alongDist: null,
        lateral: null,
        speed: vecLength(ship.velocity),
        maxLinearDecel: this._estimateMaxLinearDecel(ship),
        posX: ship.position.x,
        posY: ship.position.y,
        posZ: ship.position.z,
        velX: ship.velocity.x,
        velY: ship.velocity.y,
        velZ: ship.velocity.z,
        returnTargetAlong: null,
        returnTargetDist: null,
        closingSpeedToReturnTarget: null,
        dockingBrake300Done: !!ship._dockingBrake300Done,
        meetsArrivalCriteria: false,
        angSpeed: vecLength(ship.angularVelocity),
        manualControl: true,
        targetPosX: State.dockingTarget ? State.dockingTarget.position.x : null,
        targetPosY: State.dockingTarget ? State.dockingTarget.position.y : null,
        targetPosZ: State.dockingTarget ? State.dockingTarget.position.z : null,
      });
      ship._dockingPhasePrevForLog = null;
    }

    // 並進: ローカル座標系（前方=-Z、右=+X、上=+Y）
    const desiredForce = {
      x: input.thrustStrafeX,
      y: input.thrustStrafeY,
      z: 0, // 下記の速度追従ロジックで設定する
    };

    // --- 前後方向(Z)の速度追従: スロットル値を「目標ローカルZ速度」
    //     として扱う（-1..1 → -maxSpeed..maxSpeedにスケール、boost
    //     時はboostMult倍）。現在のローカルZ速度との差分を比例制御で
    //     埋め、目標に近づくほど推力を弱める。shipが無い場合（テスト等）
    //     は従来通りスロットル値をそのまま推力として使う後方互換。
    if (ship) {
      const targetZSpeed = -input.thrustForward * ship.maxSpeed * boostMult;
      const localVelForZ = rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion));
      const zError = targetZSpeed - localVelForZ.z;
      const thrustStrength = Math.min(1, Math.abs(zError) / this.FORWARD_VELOCITY_FULL_THROTTLE_ERROR);
      desiredForce.z = Math.sign(zError) * thrustStrength;
    } else {
      desiredForce.z = -input.thrustForward * boostMult;
    }

    // --- 並進制動(機首方向への慣性キャンセル、逆噴射用SRC): 左右/上下
    //     入力が無い間、その方向のローカル速度成分だけを打ち消す。
    //     回転トルクは生成しない（純粋な並進力のみ）。
    //     v10: autoDampingEnabled（回転ダンピング）とは独立の
    //     retroDampingEnabledで制御する。
    const hasStrafeXInput = Math.abs(input.thrustStrafeX) >= this.STRAFE_INPUT_DEADZONE;
    const hasStrafeYInput = Math.abs(input.thrustStrafeY) >= this.STRAFE_INPUT_DEADZONE;

    if (retroDampingOn && ship && (!hasStrafeXInput || !hasStrafeYInput)) {
      const localVel = rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion));

      if (!hasStrafeXInput && Math.abs(localVel.x) > this.STRAFE_DAMPING_MIN_SPEED) {
        const brakeStrength = Math.min(1, Math.abs(localVel.x) / this.STRAFE_DAMPING_FULL_BRAKE_SPEED);
        desiredForce.x = -Math.sign(localVel.x) * brakeStrength;
      }
      if (!hasStrafeYInput && Math.abs(localVel.y) > this.STRAFE_DAMPING_MIN_SPEED) {
        const brakeStrength = Math.min(1, Math.abs(localVel.y) / this.STRAFE_DAMPING_FULL_BRAKE_SPEED);
        desiredForce.y = -Math.sign(localVel.y) * brakeStrength;
      }
    }

    // 回転: pitch=X軸, yaw=Y軸, roll=Z軸まわりのトルク要求
    let desiredTorque = {
      x: input.rotatePitch,
      y: input.rotateYaw,
      z: input.rotateRoll,
    };

    const rotationInputMagnitude =
      Math.abs(input.rotatePitch) + Math.abs(input.rotateYaw) + Math.abs(input.rotateRoll);

    const hasNoRotationInput = rotationInputMagnitude < this.ROTATION_INPUT_DEADZONE;

    // 自動姿勢制動（ダンピング）: v06で進行方向整列トルクは廃止した
    // ため、ここは角速度打ち消しのみを行うシンプルな形に戻った。
    // ユーザーが回転入力（rotatePitch/Yaw/Roll）を離すと、抵抗ゼロの
    // 宇宙空間では角速度がそのまま残り続け「延々と回り続ける」体感
    // になるため、回転入力が実質ゼロの間はship.angularVelocityを
    // 打ち消す方向のトルク要求を代わりに発生させる。
    if (autoDampingOn && hasNoRotationInput) {
      const angSpeed = vecLength(ship.angularVelocity);
      if (angSpeed > this.AUTO_DAMPING_MIN_ANGULAR_SPEED) {
        // v09: 艦の実際の制動能力（慣性・スラスター配置から概算した
        // 最大角加速度）に基づき、このdtでオーバーシュートせず
        // ちょうど角速度をゼロにできる強さでブレーキをかける。
        // 従来の固定閾値(AUTO_DAMPING_FULL_BRAKE_THRESHOLD)による
        // 比例制御は艦種の慣性差を考慮しておらず、巡洋艦・戦艦級の
        // ような重い艦では制動が絶対的に不足して振り切れ続けていた。
        desiredTorque = this._computeOvershootSafeBrakeTorque(ship, ship.angularVelocity, dt);
      }
    }

    return { desiredForce, desiredTorque };
  },

  // =============================================================
  // v46: 自動ドッキング操縦 — ゼロベース再設計
  //
  // 経緯: v08〜v45の間、個別の不具合報告に対する継ぎ足し修正
  // （オーバーシュート対策、ヒステリシス、勢い殺しモード、ゴー
  // アラウンド、迂回ウェイポイント…）を重ねた結果、分岐同士が
  // 複雑に絡み合い、一つの修正が別の場面を壊す状態になっていた。
  // v46では要件を明示的なフェーズ（ship._dockingPhase）の
  // ステートマシンとして再設計し、各フェーズの制御則を独立して
  // 記述する。過去のバグ修正で得られた物理的な知見（艦の実際の
  // 制動能力から速度上限を逆算する、ローカル速度全体を一括で
  // ブレーキする等）は土台の_estimateMaxLinearDecel等を通じて
  // 引き継ぐが、フェーズ遷移そのものはこのステートマシンだけで
  // 完結させる。
  //
  // フェーズ一覧（ship._dockingPhase）:
  //   'cruise'         : 自由巡航。制約なし、仕想WPへ最短で向かう
  //   'approach'       : distance 800→500。最高速=braking(50)
  //   'adjust'         : distance 500→300。最高速=braking(25)
  //   'brake300'       : distance=300到達、一度完全静止→軸に乗せる
  //   'final_approach' : distance 300→250。姿勢を整え切る
  //   'brake250'       : distance=250、入港基準を満たすまで整える
  //   'tunnel'         : distance 250→0（実質200→0がトンネル内部）。
  //                      姿勢固定・直進のみ
  //   'overshoot'      : トンネル内で通り抜け、奥側へ抜けていく間
  //   'docked'         : 入港完了、完全固定
  //
  // 実際の遷移はdistance/alongDist/速度/姿勢誤差を毎フレーム見て
  // 決定される（enum自体は「今どのフェーズの制御則を使うか」の
  // 結果でしかなく、根拠となる生の物理量は都度計算し直す）。
  //
  // 目的地オブジェクト（State.dockingTarget）は将来「宇宙港の
  // モデル」ごとに寸法・速度・距離しきい値が変わることを見越し、
  // target.dockingParamsに一部または全部の項目を上書き指定できる
  // ようにする。未指定の項目はDOCKING_DEFAULTSの値を使う
  // （_getDockingParams参照）。
  // =============================================================

  // -----------------------------------------------------------
  // ドッキング関連の全パラメータのデフォルト値。
  //
  // 個々のtarget（宇宙港）がtarget.dockingParamsに同名のキーを
  // 持っていれば、そちらの値がこのデフォルトを上書きする
  // （_getDockingParams参照）。艦側の性能（maxSpeed、
  // _estimateMaxLinearDecel等）はship側の値をそのまま使うため
  // ここには含めない。
  // -----------------------------------------------------------
  DOCKING_DEFAULTS: {
    // --- ゾーン境界（すべてtarget.positionからの直線距離） ---
    ZONE_CRUISE_START: 800,        // これ以上遠いと自由巡航（無制限）
    ZONE_APPROACH_START: 800,      // アプローチ開始距離
    ZONE_ADJUST_START: 500,        // 調整フェーズ開始距離（仕想WPの距離でもある）
    ZONE_BRAKE300: 300,            // 距離300ブレーキポイント
    ZONE_BRAKE250: 250,            // 距離250ブレーキポイント（同時に半径250の迂回判定基準）
    ZONE_FINAL_APPROACH: 200,      // トンネル入り口（最終進入距離）

    // --- 侵入禁止・迂回 ---
    NO_ENTRY_RADIUS: 200,          // 半径200以内は最終進入(トンネル内)以外での進入禁止
    AVOIDANCE_RADIUS: 250,         // 半径250以上でまだ軸上でなければ仕想WP経由へ迂回

    // --- 仕想ウェイポイント ---
    VIRTUAL_WAYPOINT_OFFSET: 500,  // target.positionから進入軸上手前のオフセット距離

    // --- 速度上限（「制動距離Nの速度」という形で指定） ---
    APPROACH_MAX_BRAKING_DISTANCE: 50, // アプローチ〜調整フェーズの最高速度(制動距離50相当)
    ADJUST_MAX_BRAKING_DISTANCE: 25,   // 調整フェーズの最高速度(制動距離25相当)　※ADJUST開始時にAPPROACHから引き継ぐ

    // --- 最終進入（トンネル内） ---
    // v47: FINAL_APPROACH_ENTRY_SPEEDが旧ARRIVAL_SPEED(0.5)と同値
    // だったため、トンネルに入った瞬間（まだ距離200付近）に速度条件
    // だけで入港基準を満たしてしまい、距離200からdistance=0へ
    // 一瞬でワープする不具合があった。エントリー速度をARRIVAL_SPEED
    // より十分高くし、トンネル内できちんと前進・減速する区間を確保する。
    // v52-fix3: 旧FINAL_APPROACH_BRAKING_DISTANCE(10)は削除。
    // 減速プロファイルの基準距離にはZONE_FINAL_APPROACH
    // （トンネル全長=200）をそのまま使うようにした（_runTunnelPhase
    // 参照）。旧定数は「トンネル突入直後の190分は速度上限なしで
    // 巡航し、残り10でのみ急減速する」という意図しない駆け込み
    // ブレーキを生んでいたため。
    // v60: 「最終進入が設計通りだが遅い」という要望を受け、固定値の
    // FINAL_APPROACH_ENTRY_SPEEDは廃止。代わりに、艦の実際の制動
    // 能力から「残り距離FINAL_APPROACH_STOPPING_DISTANCEで止まりきれる
    // 速度」を毎フレーム逆算する方式にした（_runTunnelPhase参照）。
    // 艦種（重さ）によって自動的に速度が変わり、軽い艦ほど速く、
    // 重い艦ほど（安全に停船できる範囲で）遅くなる。
    FINAL_APPROACH_STOPPING_DISTANCE: 50, // 距離200地点でのエントリー速度の基準: 「残りこの距離で止まりきれる速度」を上限にする
    // v60-fix1: 上記の逆算値だけだと、制動能力の高い艦種では
    // エントリー速度が理論上かなり大きくなりうる（例: maxLinearDecel
    // ≈16.25の艦で約37）ため、絶対上限として追加。
    FINAL_APPROACH_ENTRY_SPEED_CAP: 20,

    // --- 入港（固定）判定基準 ---
    ARRIVAL_SPEED: 0.5,
    ARRIVAL_HEADING_ERROR_DEG: 0.1,   // 各軸（pitch/yaw由来のheading, roll）誤差の許容(度)
    ARRIVAL_ANGULAR_SPEED: 0.01,      // これ未満で角速度を強制的に0へスナップ
    // v53: 速度条件(ARRIVAL_SPEED)だけで入港固定すると、戦艦級のような
    // 重い艦は制動距離が長いため、目的地までまだ距離が残っている状態で
    // 速度だけ0.5を切って停止（固定）してしまう不具合があった。速度に
    // 加えて、目的地までの直線距離が十分小さいことも必須にする。
    ARRIVAL_DISTANCE: 0.1,

    // --- オーバーシュート・再アプローチ ---
    OVERSHOOT_REAPPROACH_DISTANCE: 300, // 奥側でこの距離離れたら再アプローチ（=通常アプローチへ合流）発動

    // --- 停止判定（brake300/brake250の「完全静止」の基準） ---
    STOP_SPEED_EPSILON: 0.05,
  },

  // docked状態を維持する際の距離許容誤差（距離の単位。艦種・宇宙港の
  // 寸法に依らない固定値でよいため、DOCKING_DEFAULTSには含めない）。
  DOCKED_STATE_DISTANCE_EPSILON: 1.0,

  // -----------------------------------------------------------
  // target.dockingParamsの値があれば優先し、無い項目はデフォルトで
  // 埋めたパラメータセットを返す。宇宙港モデルごとの寸法差（将来
  // 実装予定）を、このオブジェクトを介して自動ドッキングロジック
  // 全体へ伝播させる。呼び出しごとに毎回マージするが、キー数は
  // 少ないためコスト上問題にならない。
  // -----------------------------------------------------------
  _getDockingParams(target) {
    const overrides = (target && target.dockingParams) || {};
    const params = {};
    for (const key in this.DOCKING_DEFAULTS) {
      params[key] = overrides[key] !== undefined ? overrides[key] : this.DOCKING_DEFAULTS[key];
    }
    return params;
  },

  // -----------------------------------------------------------
  // 「距離dで速度がちょうど0になる」よう安全側に見積もった目標
  // 速度を、艦の実際の制動能力(decel)から逆算する。
  //   v = sqrt(2 * decel * max(0, d) * margin)
  // marginは理論値ぎりぎりを避けるための安全係数（<1）。
  // -----------------------------------------------------------
  BRAKE_SAFETY_MARGIN: 0.85,

  _speedForBrakingDistance(decel, distance) {
    const d = Math.max(0, distance);
    return Math.sqrt(2 * Math.max(decel, 1e-6) * d * this.BRAKE_SAFETY_MARGIN);
  },

  // -----------------------------------------------------------
  // 仕想ウェイポイント: target.positionから進入軸上手前
  // VIRTUAL_WAYPOINT_OFFSETの固定点。艦とtarget.positionの間に
  // 収まるよう、target.positionまでの実距離でクランプする
  // （距離がオフセット未満なら仕想WPはtarget.positionそのものに
  //近づき、艦の後方へ回り込むことはない）。
  //
  // v54: approachAxisWorldは「艦(手前側)から目的地へ向かう方向」
  // （v52で確定した符号規約）なので、「手前」の点を得るには
  // target.positionからapproachAxisWorldの逆方向（-approachAxisWorld）
  // へオフセットする必要がある。以前は+approachAxisWorldのまま
  // 加算しており、進入軸を目的地からさらに奥へ延長した点（艦から見て
  // 目的地の向こう側）を仕想WPにしてしまっていた。実ログでyaw=80°の
  // targetに対し、艦が一度target.positionのz座標(-4000)を超えて
  // z=-4534付近まで飛んでから戻ってくる異常な軌道を確認して特定した。
  // 同じ考え方の_computeAvoidanceWaypoint（直後の関数）は元々
  // 正しく減算していたため、そちらを基準に符号を合わせた。
  // -----------------------------------------------------------
  _computeVirtualWaypoint(target, approachAxisWorld, distance, params) {
    const offset = Math.min(params.VIRTUAL_WAYPOINT_OFFSET, distance);
    return {
      x: target.position.x - approachAxisWorld.x * offset,
      y: target.position.y - approachAxisWorld.y * offset,
      z: target.position.z - approachAxisWorld.z * offset,
    };
  },

  // -----------------------------------------------------------
  // 半径AVOIDANCE_RADIUS以上、かつまだ進入軸上に乗っていない
  // （lateralが大きい）場合に経由させる、固定の中間地点。
  //
  // 進入軸上、target.positionから手前側（-approachAxisWorld方向）
  // にVIRTUAL_WAYPOINT_OFFSET+AVOIDANCE_RADIUS（固定距離）だけ
  // 離れた、横方向オフセットを持たない点を返す。艦の現在位置に
  // 応じて動的に変えず、常にこの固定点を経由させることで、
  // 「艦が既に迂回点を追い越していて逆走を指示してしまう」
  // ような相互作用を避ける（過去に実際発生した不具合）。
  //
  // 使う側（_runApproachPhase/_runReturnToAxisPhase）は、艦が
  // まだこの中間地点に対して十分な距離がある間はこれを目標にし、
  // 十分近づいたら通常の目標（仕想WP/target.position）に切り替える
  // 二段階方式を取る。
  // -----------------------------------------------------------
  _computeAvoidanceWaypoint(ship, target, approachAxisWorld, params) {
    const safeAlong = params.VIRTUAL_WAYPOINT_OFFSET + params.AVOIDANCE_RADIUS;
    return {
      x: target.position.x - approachAxisWorld.x * safeAlong,
      y: target.position.y - approachAxisWorld.y * safeAlong,
      z: target.position.z - approachAxisWorld.z * safeAlong,
    };
  },

  // -----------------------------------------------------------
  // 艦の姿勢を、ワールド方向ベクトルheadingTargetWorldへ向ける
  // トルク要求を desiredTorque(x,y=pitch/yaw) に書き込む。
  // fullTorqueAngle未満の角度差では比例して弱める。角度差が
  // HEADING_LOCK_TOLERANCE_DEG未満ならロックして角速度を0に吸収。
  // 戻り値: headingLocked (bool)
  // -----------------------------------------------------------
  _applyHeadingTorque(ship, headingTargetWorld, fullTorqueAngle, desiredTorque) {
    const targetDirLocal = rotateVecByQuat(headingTargetWorld, conjugateQuat(ship.quaternion));
    const noseLocal = { x: 0, y: 0, z: -1 };
    const { angle, axis: axisNorm } = this._computeHeadingAngleAndAxis(noseLocal, targetDirLocal);

    const headingLocked = this._lockHeadingIfWithinTolerance(ship, angle);
    if (!headingLocked && angle > this.DOCKING_HEADING_MIN_ANGLE) {
      const torqueStrength = Math.min(1, angle / fullTorqueAngle);
      desiredTorque.x = axisNorm.x * torqueStrength;
      desiredTorque.y = axisNorm.y * torqueStrength;
    }
    return headingLocked;
  },

  // -----------------------------------------------------------
  // 艦のrollを、target.quaternionが定めるroll角へ向けるトルク要求を
  // desiredTorque.zに書き込む。戻り値: rollLocked (bool)
  //
  // v64-fix2: fullTorqueAngleを省略可能な引数として追加。従来は
  // 常にDOCKING_ROLL_FULL_TORQUE_ANGLE(1.05rad、約60°)固定で、
  // headingTorque側（_computeHeadingFullTorqueAngleでdistance=
  // ZONE_APPROACH_START(800)→ZONE_BRAKE300(300)の間に1.05rad→
  // 0.35radへ補間、brake300以降は0.35rad固定）のように近づくほど
  // 小さい誤差でもフルトルクになる、という厳格化が一切効いておらず、
  // headingは距離が縮むほど速く追従するのにrollだけ常に緩いまま、
  // という非対称な挙動になっていた（「距離250での姿勢制御が遅い、
  // 特にロールが遅い」の直接原因）。呼び出し側からheadingと同じ
  // fullTorqueAngleを渡すことで、rollもheadingと同じ厳格化
  // プロファイルに揃える。省略時は従来通りDOCKING_ROLL_FULL_TORQUE_
  // ANGLEを使う（後方互換のためのデフォルト）。
  // -----------------------------------------------------------
  _applyRollTorque(ship, target, desiredTorque, fullTorqueAngle) {
    const effectiveFullTorqueAngle = fullTorqueAngle !== undefined ? fullTorqueAngle : this.DOCKING_ROLL_FULL_TORQUE_ANGLE;
    const rollError = this._computeRollErrorAngle(ship, target);
    const rollLocked = this._lockRollIfWithinTolerance(ship, rollError.angle);
    if (!rollLocked && Math.abs(rollError.angle) > this.DOCKING_ROLL_MIN_ANGLE) {
      const rollTorqueStrength = clamp(rollError.angle / effectiveFullTorqueAngle, -1, 1);
      desiredTorque.z = rollError.axis.z * rollTorqueStrength;
    }
    return rollLocked;
  },

  // -----------------------------------------------------------
  // 角速度ダンピング: 各軸、上でトルクを既に発生させていない
  // （|desiredTorque[axis]|が1未満の）分だけブレーキトルクを
  // 上乗せする。角速度がARRIVAL_ANGULAR_SPEED未満に落ちている軸は
  // 「スラスターの限界で完全に0にしきれない」問題への対策として
  // 直接0にスナップする。
  // -----------------------------------------------------------
  _applyAngularDamping(ship, desiredTorque, dt, snapEpsilon) {
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(ship.angularVelocity[axis]) < snapEpsilon) {
        ship.angularVelocity[axis] = 0;
      }
    }
    const angSpeed = vecLength(ship.angularVelocity);
    if (angSpeed > this.AUTO_DAMPING_MIN_ANGULAR_SPEED) {
      const brakeDir = this._computeOvershootSafeBrakeTorque(ship, ship.angularVelocity, dt);
      desiredTorque.x += brakeDir.x * (1 - Math.abs(desiredTorque.x));
      desiredTorque.y += brakeDir.y * (1 - Math.abs(desiredTorque.y));
      desiredTorque.z += brakeDir.z * (1 - Math.abs(desiredTorque.z));
      desiredTorque.x = clamp(desiredTorque.x, -1, 1);
      desiredTorque.y = clamp(desiredTorque.y, -1, 1);
      desiredTorque.z = clamp(desiredTorque.z, -1, 1);
    }
  },

  // -----------------------------------------------------------
  // 艦のローカル速度全体を、目標速度ベクトル(ワールド座標)へ
  // 一致させる並進力を desiredForce(x,y,z) に書き込む（全方位、
  // 姿勢を問わず効く汎用ブレーキ/追従。headingHold/tunnel/
  // brakeポイントなど「船首の向きに関わらず特定のワールド速度に
  // したい」場面で使う）。
  //   targetVelWorld: 目標のワールド速度ベクトル（静止させたいなら
  //                   {0,0,0}）
  // -----------------------------------------------------------
  _applyVelocityMatch(ship, targetVelWorld, desiredForce) {
    const targetVelLocal = rotateVecByQuat(targetVelWorld, conjugateQuat(ship.quaternion));
    const localVel = rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion));
    const errLocal = {
      x: targetVelLocal.x - localVel.x,
      y: targetVelLocal.y - localVel.y,
      z: targetVelLocal.z - localVel.z,
    };
    const errMag = vecLength(errLocal);
    if (errMag < 1e-4) return;
    const dir = vecScale(errLocal, 1 / errMag);
    const strength = Math.min(1, errMag / this.FORWARD_VELOCITY_FULL_THROTTLE_ERROR);
    desiredForce.x = dir.x * strength;
    desiredForce.y = dir.y * strength;
    desiredForce.z = dir.z * strength;
  },

  // -----------------------------------------------------------
  // 艦の現在位置から目標位置(ワールド)へ向かう並進力を desiredForce
  // に書き込む。距離に応じた比例接近力と、艦の実際の制動能力から
  // 逆算した速度上限（maxBrakingDistanceで指定）を合成する。
  // 「制動距離ベースの速度上限を超えないよう」ブレーキを主として
  // 解き、接近力はブレーキが余らせた分だけ上乗せする
  // （v17以来の知見: 単純加算だと打ち消し合って通り過ぎる）。
  //
  //   maxBrakingDistanceOverride: 呼び出し側が明示的に速度上限を
  //     「制動距離Nの速度」として指定したい場合の距離N。
  //     nullなら艦の制動距離そのまま（実質無制限、自由巡航用）。
  // -----------------------------------------------------------
  DOCKING_POSITION_FULL_THRUST_DISTANCE_DEFAULT: 300,

  // targetPosWorldへ向かう並進力を desiredForce に書き込む。
  //   maxBrakingDistanceOverride: 速度上限を「制動距離N」として
  //     明示指定したい場合の距離N。nullなら無制限（cruise用）。
  //   stoppingDistanceForCapOverride: 「目的地への物理的な制動距離」
  //     を計算する際に使う距離を、実際の操舵目標(targetPosWorld)への
  //     距離ではなく、これで明示的に上書きする。省略時（undefined）
  //     はtargetPosWorldへの距離をそのまま使う。
  //     用途: approach/adjustフェーズでは、艦の操舵目標は仕想WPや
  //     迂回点だが、「目的地に近づくと自然に減速する」という効果は
  //     あくまでtarget.positionまでの実距離に基づくべきで、仕想WPの
  //     手前で完全停止してしまうと（＝仕想WPまでの距離を基準にすると）
  //     approachが仕想WP付近で停止・再加速を繰り返す不安定な挙動を
  //     招く。この引数でtarget.positionまでの実距離を渡すことで、
  //     「操舵方向は仕想WPへ、減速の基準はtarget.positionへの実距離」
  //     を両立させる。
  //   params: ARRIVAL_SPEED（境界付近の不感帯マージンに使用、v64-fix2）
  //     など、港ごとにオーバーライド可能なドッキングパラメータ一式。
  _applyApproachForce(ship, targetPosWorld, maxBrakingDistanceOverride, desiredForce, stoppingDistanceForCapOverride, params, stoppingTargetSpeedOverride) {
    const toTargetWorld = {
      x: targetPosWorld.x - ship.position.x,
      y: targetPosWorld.y - ship.position.y,
      z: targetPosWorld.z - ship.position.z,
    };
    const distance = vecLength(toTargetWorld);
    if (distance <= 1e-4) return;

    const dirWorld = vecScale(toTargetWorld, 1 / distance);
    const dirLocal = rotateVecByQuat(dirWorld, conjugateQuat(ship.quaternion));
    const localVel = rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion));

    // 現在速度のうち、目標方向成分(closingSpeed)とそれ以外(lateral)を分離。
    const closingSpeed = vecDot(localVel, dirLocal);
    const lateralVel = {
      x: localVel.x - dirLocal.x * closingSpeed,
      y: localVel.y - dirLocal.y * closingSpeed,
      z: localVel.z - dirLocal.z * closingSpeed,
    };
    const lateralSpeed = vecLength(lateralVel);

    // 横滑り成分は常にRCSでフルブレーキ（艦の姿勢に関わらず横方向は
    // 常に消してよい）。
    if (lateralSpeed > 1e-4) {
      const lateralBrakeDir = vecScale(lateralVel, -1 / lateralSpeed);
      const maxLateralDecel = this._estimateMaxLateralDecel(ship);
      const lateralBrakeStrength = Math.min(1, lateralSpeed / (maxLateralDecel * 2));
      desiredForce.x += lateralBrakeDir.x * lateralBrakeStrength;
      desiredForce.y += lateralBrakeDir.y * lateralBrakeStrength;
      desiredForce.z += lateralBrakeDir.z * lateralBrakeStrength;
    }

    // 進行方向(closingSpeed)の速度上限を、maxBrakingDistanceOverride
    // （指定があれば）から決める。速度上限は「常に適用される上限」
    // であり、下回っている間は自由（無理に加速する必要はない）。
    const maxDecel = this._estimateMaxLinearDecel(ship);
    let speedCap = Infinity;
    if (maxBrakingDistanceOverride !== null) {
      speedCap = this._speedForBrakingDistance(maxDecel, maxBrakingDistanceOverride);
    }
    // 目的地への物理的な制動距離（この距離で止まりきれる速度）も
    // 上限として効かせる（速度上限区間内でも、目的地に近づけば
    // 自然に減速していく）。基準距離はstoppingDistanceForCapOverride
    // があればそちらを、なければtargetPosWorldへのdistanceを使う。
    //
    // v65-fix: 従来はこの制動距離ベースの上限が常に「終端で速度0」を
    // 狙う計算(v=sqrt(2*decel*d))だった。cruiseフェーズがdistance=
    // ZONE_APPROACH_START(800)までの残り距離をこの基準distanceとして
    // 渡すと、境界到達時にちょうど速度0まで減速してしまい、直後の
    // approachフェーズで再加速するまで実質停止する不具合になっていた
    // （speedCap自体は無制限のままでも、この停止狙いの制動距離キャップ
    // の方がより厳しく効いてしまうため）。stoppingTargetSpeedOverride
    // （省略時は従来通り0）を指定すると、終端で目指す速度を0以外に
    // できるようにした。v(d)² = target² + 2*decel*d*margin の形に
    // 一般化（target=0のときは従来の_speedForBrakingDistanceと同一）。
    const stoppingBasisDistance =
      stoppingDistanceForCapOverride !== undefined ? stoppingDistanceForCapOverride : distance;
    const stoppingTargetSpeed = stoppingTargetSpeedOverride !== undefined ? stoppingTargetSpeedOverride : 0;
    const stoppingSpeedCap = Math.sqrt(
      stoppingTargetSpeed * stoppingTargetSpeed +
        2 * Math.max(maxDecel, 1e-6) * Math.max(0, stoppingBasisDistance) * this.BRAKE_SAFETY_MARGIN
    );
    const effectiveCap = Math.min(speedCap, stoppingSpeedCap);

    if (closingSpeed > effectiveCap) {
      // 上限超過: ブレーキを主として解く。
      //
      // v50-fix4: stoppingSpeedCap（目的地・境界までの物理的な制動
      // 限界）を超過している場合は、超過量に関わらず問答無用で
      // フルブレーキにする。従来はspeedCap由来かstoppingSpeedCap由来
      // かを区別せず一律「over/FORWARD_VELOCITY_FULL_THROTTLE_ERROR」
      // という緩やかな比例ブレーキにしていたため、cruise終盤のように
      // 大きな超過（over>>40）でもbrakeStrengthはmin(1,...)で頭打ち
      // される一方、超過が40未満の間はブレーキが弱く、結果として
      // 「本当は今すぐ全力で止まらないと次のゾーン境界に間に合わない」
      // 状況でも十分な減速が得られなかった（実測ログで、艦の最高速度
      // 267.8がcruise→approach境界(distance=800)到達時点でも216.1
      // までしか落ちておらず、その後approach/adjustでも大幅な速度
      // 超過を引きずったままオーバーシュートしていたことを確認済み）。
      // stoppingSpeedCap超過は「間に合わなくなる」物理的な制約なので、
      // 超過量に関わらず即フルブレーキにする。speedCap
      // （maxBrakingDistanceOverride由来、cruiseの先読みやapproach/
      // adjustの巡航速度目安）側の超過は、引き続き緩やかな比例
      // ブレーキのままでよい（巡航速度の目安に過ぎず、間に合わなく
      // なる性質のものではないため）。
      //
      // v64-fix2: 上のoverStoppingCapのオン・オフ的な即フルブレーキが、
      // stopAtDistance境界（distance≒stopAtDistance、stoppingSpeedCap
      // ≒0）のごく近傍で振動を引き起こしていた。closingSpeedが
      // stoppingSpeedCapをわずか（ARRIVAL_SPEED未満程度）に超えた
      // だけでも即フルブレーキ(brakeStrength=1)になり、艦が境界の
      // 内側へわずかに押し戻される→内側ではapproachStrengthによる
      // 前進推力が働く→再び境界を超えてまたフルブレーキ、という
      // オン・オフの繰り返しで「主機関と逆噴射の凄い勢いでの往復」に
      // なっていた（実測ログdocking-log-2026-08-31T05-17-30-407Zで
      // 確認: adjustフェーズでdistance=300.01〜301.1の間を主機関・
      // 逆噴射を切り替えながら20往復以上し続けていた）。
      // closingSpeedの超過量自体がARRIVAL_SPEED未満の小さい間は、
      // 間に合わなくなる速度超過ではなく単なる整定誤差なので、
      // 即フルブレーキにせず緩やかな比例ブレーキ側へ回すことで
      // 境界付近に不感帯を持たせ、振動を抑える。
      const stoppingCapOver = closingSpeed - stoppingSpeedCap;
      const arrivalSpeed = (params && params.ARRIVAL_SPEED !== undefined) ? params.ARRIVAL_SPEED : this.DOCKING_DEFAULTS.ARRIVAL_SPEED;
      const overStoppingCap = stoppingCapOver > arrivalSpeed;
      const over = closingSpeed - effectiveCap;
      const brakeStrength = overStoppingCap ? 1 : Math.min(1, over / this.FORWARD_VELOCITY_FULL_THROTTLE_ERROR);
      desiredForce.x += -dirLocal.x * brakeStrength;
      desiredForce.y += -dirLocal.y * brakeStrength;
      desiredForce.z += -dirLocal.z * brakeStrength;
    } else {
      // 上限内: 残り余力の範囲で接近力を出す。基準距離は
      // stoppingBasisDistance（target.positionへの実距離、cruiseでは
      // 操舵目標そのもの）を使う。仕想WPまでの距離(distance)を
      // 使うと、approach/adjustが仕想WP付近で不要に加速を弱めて
      // しまう。
      const usedByBrake = Math.max(Math.abs(desiredForce.x), Math.abs(desiredForce.y), Math.abs(desiredForce.z));
      const approachStrength = Math.min(1 - usedByBrake, stoppingBasisDistance / this.DOCKING_POSITION_FULL_THRUST_DISTANCE_DEFAULT);
      if (approachStrength > 0) {
        desiredForce.x += dirLocal.x * approachStrength;
        desiredForce.y += dirLocal.y * approachStrength;
        desiredForce.z += dirLocal.z * approachStrength;
      }
    }

    desiredForce.x = clamp(desiredForce.x, -1, 1);
    desiredForce.y = clamp(desiredForce.y, -1, 1);
    desiredForce.z = clamp(desiredForce.z, -1, 1);
  },

  // -----------------------------------------------------------
  // 入港判定基準（速度/姿勢誤差/角速度）を満たすか判定。
  // 設計書「入港判定基準（共通）」：位置が軸上・姿勢誤差各軸0.1°
  // 以内・角速度0.01未満。位置(軸上)は呼び出し側でlateralを別途
  // チェックする（brake250→tunnel遷移、tunnel内固定判定の両方で
  // 「_meetsArrivalCriteria && lateral <= 許容値」の形で使う）。
  //
  // v47でここにdistance条件（FINAL_APPROACH_BRAKING_DISTANCE以下）
  // を追加していたが、この関数はbrake250→tunnel遷移判定でも共用
  // されており、brake250にいる艦のdistanceは常に200〜250なので
  // 条件が常にfalseになり「姿勢・位置が整っているのにtunnelへ
  // 進まない」不具合を生んでいた。設計書の入港判定基準はdistanceを
  // 含まないため撤去する。tunnel入口でのワープ対策（v47の本来の
  // 目的）はFINAL_APPROACH_ENTRY_SPEEDをARRIVAL_SPEEDより十分
  // 高くする対応のみで十分であり、そちらは維持する。
  // -----------------------------------------------------------
  _meetsArrivalCriteria(ship, target, params) {
    const speed = vecLength(ship.velocity);
    if (speed >= params.ARRIVAL_SPEED) return false;

    const approachAxisWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    const approachAxisLocal = rotateVecByQuat(approachAxisWorld, conjugateQuat(ship.quaternion));
    const headingErrorRad = Math.acos(clamp(-approachAxisLocal.z, -1, 1));
    const toleranceRad = params.ARRIVAL_HEADING_ERROR_DEG * (Math.PI / 180);
    if (headingErrorRad > toleranceRad) return false;

    const rollError = this._computeRollErrorAngle(ship, target);
    if (Math.abs(rollError.angle) > toleranceRad) return false;

    const angSpeed = vecLength(ship.angularVelocity);
    if (angSpeed >= params.ARRIVAL_ANGULAR_SPEED) return false;

    return true;
  },

  // -----------------------------------------------------------
  // 艦を目的地の位置・姿勢へ完全固定する（速度・角速度もゼロ）。
  // -----------------------------------------------------------
  _lockShipAtTarget(ship, target) {
    ship.position.x = target.position.x;
    ship.position.y = target.position.y;
    ship.position.z = target.position.z;
    ship.quaternion.x = target.quaternion.x;
    ship.quaternion.y = target.quaternion.y;
    ship.quaternion.z = target.quaternion.z;
    ship.quaternion.w = target.quaternion.w;
    ship.velocity.x = 0;
    ship.velocity.y = 0;
    ship.velocity.z = 0;
    ship.angularVelocity.x = 0;
    ship.angularVelocity.y = 0;
    ship.angularVelocity.z = 0;
    // スラスター側の表示・演出もゼロに揃える（旧
    // FlightPhysics._tryLockAtDockingArrivalから引き継いだ処理）。
    if (ship.thrusters && ship.thrusterOutputRatios) {
      for (const t of ship.thrusters) {
        ship.thrusterOutputRatios[t.id] = 0;
      }
    }
    ship.isAtMaxSpeed = false;
    ship._dockingPhase = 'docked';
  },

  // =============================================================
  // フェーズ判定: 現在のdistance/alongDist/lateral/フェーズ履歴から
  // 今フレームのship._dockingPhaseを決定する。
  // =============================================================
  _resolveDockingPhase(ship, target, distance, alongDist, lateral, params) {
    const prevPhase = ship._dockingPhase || 'cruise';

    // --- docked状態の維持: 一度固定されたら、艦がその場から動く
    //     要因はこのゲーム内には存在しないため、目的地が変わらない
    //     限りdockedのまま維持する。_lockShipAtTargetが位置・姿勢を
    //     直接target側へ揃えているため、通常はdistance≈0のまま。
    //     何らかの理由でdistanceが動いてしまった場合のみ、安全側に
    //     倒して通常のゾーン判定へ復帰させる。 ---
    if (prevPhase === 'docked' && distance < this.DOCKED_STATE_DISTANCE_EPSILON) {
      return 'docked';
    }
    // v47: docked状態から実際に離脱した（distanceがEPSILON以上に
    // なった）場合、_dockingBrake300Doneがtrueのまま残っていると
    // 再アプローチ時にbrake300を一度もスキップしてしまう
    // （距離300での正規の停止・軸合わせ手順を踏まなくなる）ため、
    // ここでリセットして次回入港でも正規の手順を踏ませる。
    if (prevPhase === 'docked') {
      ship._dockingBrake300Done = false;
    }

    // --- 奥側(alongDist<0)からの回り込み ---
    // tunnel/overshoot（トンネル内部・オーバーシュート中）以外の
    // 状況で艦が奥側にいる場合は、cruise/approach/adjustのような
    // 「target.positionへの直線距離(distance)」だけを見るロジックを
    // 使わせない。これらは艦が手前側にいる前提で組まれており、
    // 奥側にいるまま使うと目的地に正面から向かい合う形になり、
    // 「進入軸を逆走して入る」形になりかねない（要件で禁止されている）。
    // 奥側にいる間は専用のreturn_to_axisフェーズで、まず手前側の
    // 安全な位置まで回り込ませる。
    // tunnel/overshoot自身の遷移ロジックは下のブロックで別途扱うため
    // ここでは対象外とする。
    //
    // v64-fix1: 発動条件がalongDist<0（進入軸に対して奥側かどうかの
    // 符号）だけだったため、遠方（例: distance=5000）で単に横方向・
    // 角度的に離れているだけのケースでも、alongDistがわずかでも
    // 負ならいきなりreturn_to_axisに入ってしまっていた（実測ログ
    // docking-log-2026-08-30T14-34-58-478Zで確認: distance=5000,
    // lateral=4698というほぼ真横の位置から、開始直後にreturn_to_axis
    // へ入り、approachへ合流するまでの間ずっと大回り込みを続けて
    // いた）。return_to_axisは本来「このまま直進するとNO_ENTRY_RADIUS
    // の円柱（トンネル）を横切ってしまう」場合の回避策であり、
    // lateralが円柱半径より大きければ直進しても円柱に触れないため
    // 迂回は不要。lateral < NO_ENTRY_RADIUSの場合（実際に円柱を
    // 横切りうる位置関係にある場合）のみ発動するよう条件を追加した。
    const inTunnelHandling = prevPhase === 'tunnel' || prevPhase === 'overshoot';
    if (
      !inTunnelHandling &&
      alongDist < 0 &&
      distance >= params.NO_ENTRY_RADIUS &&
      lateral < params.NO_ENTRY_RADIUS
    ) {
      return 'return_to_axis';
    }
    // 一度return_to_axisに入ったら、alongDistがわずかに0を超えた
    // だけで即座に抜けさせない。中間地点（進入軸上、手前側
    // VIRTUAL_WAYPOINT_OFFSET+AVOIDANCE_RADIUS距離）に向けて加速して
    // きた勢いのまま通常フェーズへ戻すと、まだ大きな速度を持った
    // ままapproach/adjustに合流し、再び行き過ぎてしまう（実際に
    // 発生した不具合）。alongDistが中間地点の距離に近い水準まで
    // 達するまではreturn_to_axisを維持し、十分に手前側へ戻り
    // 切ってから通常フェーズへ合流させる。
    if (!inTunnelHandling && prevPhase === 'return_to_axis') {
      const midpointAlong = params.VIRTUAL_WAYPOINT_OFFSET + params.AVOIDANCE_RADIUS;
      if (alongDist < midpointAlong) {
        return 'return_to_axis';
      }
    }

    // --- オーバーシュート/再アプローチ系の継続判定を先に見る ---
    // トンネル内(旧distance<=NO_ENTRY_RADIUS)でalongDistが負に
    // 転じたら奥側へ抜けている＝overshoot。
    if (prevPhase === 'overshoot' || prevPhase === 'tunnel') {
      if (alongDist < 0) {
        // 奥側にいる間はovershoot継続。distanceがOVERSHOOT_REAPPROACH_
        // DISTANCEを超えたら再アプローチへ切り替える。まだalongDistが
        // 負(奥側)であればreturn_to_axisへ、既にalongDist>=0まで
        // 戻れていればcruise/approachへ直接合流する。
        if (distance >= params.OVERSHOOT_REAPPROACH_DISTANCE) {
          // 再アプローチ発動: brake300/brake250のワンショット状態を
          // リセットし、以降のアプローチで再度distance<=300/250の
          // ブレーキポイントを正規の手順通りに踏ませる。
          ship._dockingBrake300Done = false;
          return 'return_to_axis';
        }
        return 'overshoot';
      }
      // v50-fix4: alongDist>=0に戻った（トンネル内に留まったまま
      // 通過しなかった）場合は通常通りtunnelとして扱う——という
      // このコメントの意図が実装されておらず、ここで何もreturnせずに
      // 下の通常ゾーン判定へ素通りしていた。
      //
      // v50-fix5: 直前の修正でtunnel継続の条件を
      // 「distance<=ZONE_FINAL_APPROACH(200)」としていたが、設計上
      // tunnelはdistance<=ZONE_BRAKE250(250)から始まるフェーズであり
      // （brake250→tunnel遷移はdistance>200かつ<=250の範囲で起こる）、
      // 200という閾値は「トンネル内をさらに200まで進んだら入港」と
      // いう入港達成の目安に過ぎない。200を継続条件に使うと、tunnel
      // 突入直後（distance 250〜200の間）に本条件を満たせず下の通常
      // ゾーン判定（distance>250ならfinal_approach）に落ちてしまい、
      // 「tunnel→final_approach」への逆戻りが発生していた（実測ログで
      // 確認済み。final_approach側の事前減速がdistance=250ちょうどで
      // 速度をほぼ使い切る設計のため、一度押し戻されると再びtunnelへ
      // 進む速度が出せなくなっていた）。
      //
      // v50-fix6: fix5の「distance>200」ガードにも同種の欠陥が
      // 残っていた。tunnel突入直後、brake250側の位置収束の余韻
      // （わずかな慣性の揺り戻し）でdistanceがtunnel侵入の瞬間の
      // 250.0000から一瞬だけ250をわずかに超えて押し戻されることが
      // 実測ログで確認された（例: 249.995→250.002のような±0.01
      // オーダーの揺り戻し）。このとき「distance<=ZONE_BRAKE250」の
      // 条件が真になれず下の通常ゾーン判定（distance>250なら
      // final_approach）に落ち、tunnelでの前進プロファイルがリセット
      // される→final_approachの事前減速でまた速度を失う→再度brake250
      // →tunnelへ、を繰り返す振動が発生していた（実測ログで6サイクル
      // 以上、速度がわずかずつ増加しながら往復し続けるのを確認済み）。
      // 一度tunnelに入った後の「250を超えたかどうか」の判定に、実際の
      // 揺り戻し幅を上回る許容マージンTUNNEL_REENTRY_TOLERANCEを設け、
      // 250+マージンまではtunnel継続とみなすことで往復振動を防止する。
      //
      // ただし単純にdistance<=250全体で無条件にtunnelを継続すると、
      // 今度は下のdistance<=ZONE_FINAL_APPROACH(200)ブロックにある
      // 「lateralが大きければbrake250へ差し戻す」チェック（トンネル内は
      // 横方向の力を出さないため、横ズレが残ったまま入ると永久に
      // 直らない、という安全策）を迂回してしまう。そこでdistance>200
      // （tunnel突入直後、まだ本来のtunnel判定ブロックの対象外の区間）
      // に限って無条件でtunnelを継続し、distance<=200になったら
      // 下のブロックの詳細判定（lateralチェック込み）にそのまま委ねる。
      if (distance <= params.ZONE_BRAKE250 + this.TUNNEL_REENTRY_TOLERANCE && distance > params.ZONE_FINAL_APPROACH) {
        return 'tunnel';
      }
      // distance<=ZONE_FINAL_APPROACH(200)の場合は下の詳細判定
      // （lateralチェック含む）にフォールスルーする。マージンを含めても
      // なお250を超えて戻ってしまった場合（想定外の外力等）も同様に
      // 下の通常ゾーン判定に委ねる。
    }

    // --- brake300のワンショット継続判定（NO_ENTRY_RADIUSチェックより
    //     優先する） ---
    // brake300は「一度完全停止して軸に乗せる」フェーズ。停止・軸
    // 合わせが完了する(_dockingBrake300Done=true)まで、ブレーキ中に
    // distanceがNO_ENTRY_RADIUS未満まで多少沈み込んでも
    // brake300自身を継続する。v50-fix3でbrake300の前後方向にも
    // distance=ZONE_BRAKE300への位置収束制御を追加したが、収束の
    // 過程で行き過ぎ・戻りのわずかなオーバーシュートが起こりうる
    // ため、それを「正規の手順を踏まない侵入」として弾いてしまうと、
    // NO_ENTRY_RADIUS付近でadjustとbrake300を永遠に往復してしまう。
    // 完了(_dockingBrake300Done=true)した時点で初めて、以降は通常の
    // ゾーン判定（NO_ENTRY_RADIUSチェック含む）に従う。
    if (prevPhase === 'brake300' && !ship._dockingBrake300Done) {
      return 'brake300';
    }

    // --- 侵入禁止半径のチェック: 半径NO_ENTRY_RADIUS以内は最終進入
    //     (tunnel/overshoot)以外からの進入を禁止。まだtunnelに
    //     入っていないのに何らかの理由でdistanceがNO_ENTRY_RADIUSを
    //     下回った場合は、迂回のやり直しに送り返す（adjustへ）。
    //     brake300/brake300完了直後は、既に正規の手順（停止して軸に
    //     乗せる）を踏んだ上でdistanceがNO_ENTRY_RADIUS未満まで沈み
    //     込んでいるだけなので、この弾き返しの対象に含めない
    //     （含めてしまうと、_dockingBrake300Done完了直後にadjustへ
    //     押し戻され、そこから再びbrake300へ戻って…を繰り返す）。 ---
    const cameFromTunnel = prevPhase === 'tunnel' || prevPhase === 'overshoot' || prevPhase === 'docked'
      || prevPhase === 'brake250' || prevPhase === 'final_approach' || prevPhase === 'brake300';
    if (distance < params.NO_ENTRY_RADIUS && !cameFromTunnel) {
      // 正規のフェーズ順序を踏まずに半径200以内へ入ってしまった
      // （例: 外力、手動操縦からの切替直後）。迂回径として
      // AVOIDANCE_RADIUSまで一旦引き戻す意味でadjustに送る。
      return 'adjust';
    }

    // --- 通常のゾーン順序による遷移 ---
    if (distance > params.ZONE_APPROACH_START) {
      return 'cruise';
    }
    // v57: approach→adjust境界(ZONE_ADJUST_START)にヒステリシスを
    // 設ける。approachフェーズは「distance=ZONE_ADJUST_STARTでほぼ
    // 停止する」設計（_runApproachPhaseのstopAtDistance引数）だが、
    // 遷移条件がちょうど同じ距離(distance>500ならapproach継続)だと、
    // 艦がdistance=500へ収束しようとする過程で境界をわずかに
    // 上下するたびにapproachへ押し戻され、なかなかadjustへ進めない
    // デッドロックになっていた。実測ログでは、艦がdistance≈500〜503
    // の狭い範囲に長時間（十万msオーダー）留まり続け、v55で仮想WPの
    // 位置自体は正しくなった一方、そこにちょうど収束してしまうが
    // 故にこの境界デッドロックが顕在化していた（symbol修正前は仮想WP
    // の位置がずれていたため、境界を素通りしていて問題が隠れていた）。
    // 対応: 既にapproachまたはadjustにいる場合、ZONE_ADJUST_START+
    // APPROACH_ADJUST_HYSTERESIS（境界より少し内側=cruise寄り）までの
    // 範囲では現在のフェーズを維持する（TUNNEL_REENTRY_TOLERANCE等と
    // 同種のヒステリシス、両方向対称）。cruiseから直接この範囲に
    // 入ってきた場合の判定には影響しない。
    if (
      prevPhase === 'approach' &&
      distance > params.ZONE_ADJUST_START &&
      distance <= params.ZONE_ADJUST_START + this.APPROACH_ADJUST_HYSTERESIS
    ) {
      return 'adjust';
    }
    // v57: 逆方向（一度adjustに入った後、横方向補正等の余韻で
    // distanceがわずかにZONE_ADJUST_STARTを超えて戻るケース）も、
    // 同じマージン内ならadjustを維持する。対称にしておかないと
    // 「adjust→approach→(ヒステリシスで)adjust→…」という別の往復を
    // 生みかねないため。
    if (
      prevPhase === 'adjust' &&
      distance > params.ZONE_ADJUST_START &&
      distance <= params.ZONE_ADJUST_START + this.APPROACH_ADJUST_HYSTERESIS
    ) {
      return 'adjust';
    }
    if (distance > params.ZONE_ADJUST_START) {
      return 'approach';
    }
    if (distance > params.ZONE_BRAKE300) {
      return 'adjust';
    }

    // distance <= ZONE_BRAKE300 の範囲。brake300は「一度完全停止して
    // 軸に乗せる」ワンショットのブレーキポイント。停止・軸合わせが
    // 完了する(_dockingBrake300Done=true)まで、慣性で距離が250を
    // 割り込んでもbrake300の制御を継続する（distance帯だけで
    // 判定すると、停止し切る前にdistanceがZONE_BRAKE250を通過して
    // しまい、一度も止まらないままbrake250/final_approachへ抜けて
    // しまう）。
    if (!ship._dockingBrake300Done) {
      return 'brake300';
    }

    if (distance > params.ZONE_BRAKE250) {
      // v52-fix2: prevPhaseがbrake250で、既に入港基準
      // (_meetsArrivalCriteria)を満たしている場合は、多少
      // distanceが250を超えて揺り戻しても無条件にfinal_approachへ
      // 差し戻さない。
      //
      // 症状: distance=250付近で艦の前後方向がわずかに振動
      // （_applySettlingForceによる減衰振動）している間、姿勢・
      // 速度・角速度は既に入港基準を満たしているのに、distanceが
      // 250をわずかに超えるたびにfinal_approachへ差し戻され、
      // brake250側の「基準を満たすまで留まる」ロジック
      // （下のブロック、prevPhase==='brake250'時のtunnel遷移判定）
      // に一度も辿り着けないまま、実質的にfinal_approach⇄brake250
      // を永久に往復し続けていた。アップロードされた操縦ログ
      // (docking-log-2026-08-30T07-21-13-972Z.csv)で、
      // meetsArrivalCriteriaがtrueになった後もdistanceが250付近を
      // 緩やかに往復し続け、250を割り込むまで長時間（実測で
      // 100万msのオーダー）brake250へ進めなかった様子を確認して
      // 特定した。tunnel継続判定(TUNNEL_REENTRY_TOLERANCE)と同種の
      // 対策として、brake250からの基準充足時のみ許容マージンを
      // 設ける。
      if (
        prevPhase === 'brake250' &&
        distance <= params.ZONE_BRAKE250 + this.BRAKE250_REENTRY_TOLERANCE &&
        this._meetsArrivalCriteria(ship, target, params)
      ) {
        return 'brake250';
      }
      return 'final_approach';
    }

    // distance <= ZONE_BRAKE250。brake250も同様のワンショット判定だが、
    // 「入港基準を満たすまでその場に留まる」ため、一度入ったら
    // 基準を満たすまでbrake250のまま。基準を満たしたらtunnelへ。
    if (distance > params.ZONE_FINAL_APPROACH) {
      if (prevPhase === 'brake250') {
        // tunnelへ進む条件は入港基準（速度・姿勢誤差・角速度）に
        // 加えて、横ズレ(lateral)が十分小さいことも必須とする。
        // _meetsArrivalCriteriaは横方向を見ないため、これを含めないと
        // 「速度・姿勢だけ収まったが軸上には乗っていない」状態のまま
        // トンネルに突入してしまう（トンネル内は横方向の力を一切
        // 出さないため、一度入るとそのズレは永久に残ってしまう）。
        //
        // v50-fix4: 従来はここで_dockingBrake300Doneをfalseに
        // リセットしていたが、これはまだ実際の入港(docked)が
        // 完了していない、tunnel突入の瞬間に行われる時期尚早な
        // リセットだった。tunnel内で一時的にbrake250へ差し戻される
        // （lateralの微小な再発等）ことがあり、その状態で万一
        // distance<=ZONE_BRAKE300の判定に落ちると、リセット済みの
        // _dockingBrake300Doneのせいで無条件にbrake300へ引き戻され、
        // 「tunnel→brake300→brake250→tunnel→…」を永久に繰り返して
        // しまっていた。リセットは実際にdockedへ到達した時点
        // （このファイル内、docked状態から離脱する箇所）でのみ
        // 行うようにし、ここでは行わない。
        if (this._meetsArrivalCriteria(ship, target, params) && lateral <= this.DOCKING_POSITION_MIN_DISTANCE) {
          return 'tunnel';
        }
        return 'brake250';
      }
      return 'brake250';
    }

    // distance <= ZONE_FINAL_APPROACH（トンネル内部）。
    if (alongDist < 0) {
      return 'overshoot';
    }
    // 横ズレ(lateral)が十分小さいことを確認できていない場合は
    // tunnelへ入れない（トンネル内は横方向の力を出さないため、
    // 一度入ると横ズレが永久に残ってしまう）。brake250へ送り、
    // 横方向・姿勢・速度をきっちり合わせ直させる。
    if (lateral > this.DOCKING_POSITION_MIN_DISTANCE) {
      return 'brake250';
    }
    return 'tunnel';
  },

  // =============================================================
  // メインエントリ: 自動ドッキング用のdesiredForce/desiredTorqueを
  // 組み立てる。
  // =============================================================
  _buildDesiredForAutoDocking(input, ship, dt) {
    // v61: State.dockingTargetは「艦の接舷面(dockingFace)が最終的に
    // 一致すべき港側の位置・姿勢」を表す。艦に接舷面が設定されている
    // 場合、以降のフェーズ判定・接近制御は全て「艦の重心が実際に
    // 目指すべき実効目標」（接舷面オフセット分だけ引いた位置・姿勢）
    // を使う。この置き換え一箇所だけで、以下の巨大な自動操船ロジック
    // 本体は変更なしに接舷面へ対応する（01-state-and-config.js
    // computeEffectiveShipDockingTarget()参照）。dockingFace未設定なら
    // 従来通りState.dockingTargetがそのまま使われる。
    const target = computeEffectiveShipDockingTarget(State.dockingTarget, ship);
    const params = this._getDockingParams(target);

    const toTargetWorld = {
      x: target.position.x - ship.position.x,
      y: target.position.y - ship.position.y,
      z: target.position.z - ship.position.z,
    };
    const distance = vecLength(toTargetWorld);
    const approachAxisWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    // v50-fix2: 上のv50-fixコメントの前提（rawAlongが手前側でマイナスに
    // なる）は誤りだった。実際に検証すると、艦が手前側（approachAxisWorld
    // の逆方向）にいるとき toTargetWorld は +approachAxisWorld 方向を
    // 向くため、rawAlong = dot(toTargetWorld, approachAxisWorld) は
    // 手前側でプラスになる。v50-fixで追加した `-rawAlong` はこれを
    // 再び反転させてしまい、結果として「手前側にいるほどalongDistが
    // マイナスに振れる」形になっていた。これがreturn_to_axisの離脱
    // 条件(alongDist >= 750)を艦がどれだけ目標点に近づいても満たせず、
    // 「進入軸へ回り込み中のまま点700(実際は-750)に張り付き続ける」
    // 不具合の原因だった（ログ実測で確認済み: 艦は目標点に物理的には
    // 到達していたが、alongDistは-749のまま推移していた）。
    // rawAlongをそのままalongDistとして使うのが正しい。
    const rawAlong = vecDot(toTargetWorld, approachAxisWorld);
    const alongDist = rawAlong; // 正=手前側, 負=奥側
    const lateralVec = {
      x: toTargetWorld.x - approachAxisWorld.x * rawAlong,
      y: toTargetWorld.y - approachAxisWorld.y * rawAlong,
      z: toTargetWorld.z - approachAxisWorld.z * rawAlong,
    };
    const lateral = vecLength(lateralVec);

    const phase = this._resolveDockingPhase(ship, target, distance, alongDist, lateral, params);
    ship._dockingPhase = phase;

    // デバッグ用ログ（一時調査コード）: フェーズ判定に使った生の
    // 物理量と、return_to_axis中はその目標点までの距離・速度成分も
    // あわせて記録する。
    {
      const speed = vecLength(ship.velocity);
      let returnTargetAlong = null;
      let returnTargetDist = null;
      let closingSpeedToReturnTarget = null;
      if (phase === 'return_to_axis') {
        const returnTarget = this._computeAvoidanceWaypoint(ship, target, approachAxisWorld, params);
        const toReturnTarget = {
          x: returnTarget.x - ship.position.x,
          y: returnTarget.y - ship.position.y,
          z: returnTarget.z - ship.position.z,
        };
        returnTargetDist = vecLength(toReturnTarget);
        returnTargetAlong = params.VIRTUAL_WAYPOINT_OFFSET + params.AVOIDANCE_RADIUS;
        if (returnTargetDist > 1e-4) {
          const dir = vecScale(toReturnTarget, 1 / returnTargetDist);
          closingSpeedToReturnTarget = vecDot(ship.velocity, dir);
        }
      }
      this._logDockingFrame({
        t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
        phase,
        prevPhase: ship._dockingPhasePrevForLog || null,
        distance,
        alongDist,
        lateral,
        speed,
        maxLinearDecel: this._estimateMaxLinearDecel(ship),
        posX: ship.position.x,
        posY: ship.position.y,
        posZ: ship.position.z,
        velX: ship.velocity.x,
        velY: ship.velocity.y,
        velZ: ship.velocity.z,
        returnTargetAlong,
        returnTargetDist,
        closingSpeedToReturnTarget,
        dockingBrake300Done: !!ship._dockingBrake300Done,
        meetsArrivalCriteria: this._meetsArrivalCriteria(ship, target, params),
        angSpeed: vecLength(ship.angularVelocity),
        // v58: 要望「ログに、自動航行開始の目的地と、手動操船の
        // ステータスを追加して」対応。manualControl:falseで自動操船
        // 中の行であることを示し、targetPos*で「この行の時点で
        // 自動航行が目指している目的地」を毎フレーム記録する。
        // 目的地を飛行中に変更した場合もその変化がログから追える
        // よう、開始時の一回きりではなく毎フレームの値を記録する
        // 方式にした。
        // v61: targetは接舷面オフセット適用後の実効目標（艦の重心が
        // 実際に目指す位置）。接舷面未設定ならState.dockingTargetと
        // 一致する。
        manualControl: false,
        targetPosX: target.position.x,
        targetPosY: target.position.y,
        targetPosZ: target.position.z,
      });
      ship._dockingPhasePrevForLog = phase;
    }

    // tunnelフェーズ中、入港判定基準（速度・姿勢誤差・角速度）を
    // 満たした時点で艦を目的地へ完全固定する（要望「速度0.5,角度は
    // それぞれの軸が誤差0.1度以下で、かつ角速度が0.01未満になったら
    // 固定してあげる」）。tunnel内は既に姿勢固定・直進のみなので、
    // 満たすのは基本的に前進速度がARRIVAL_SPEEDを下回った瞬間になる。
    //
    // v50: 設計書の「入港: distance <= ZONE_FINAL_APPROACHかつ入港
    // 判定達成」に合わせ、distance条件をここに追加する。従来は
    // _meetsArrivalCriteria（速度・姿勢誤差・角速度のみ、distanceは
    // 見ない）だけで判定していたため、brake250からtunnelへ切り替わった
    // 直後（distanceがまだ200〜250のどこか）に、brake250側で既に
    // 速度・姿勢を収束させきっていると、tunnel本来の前進スラスト
    // （distance=ZONE_FINAL_APPROACH地点でFINAL_APPROACH_ENTRY_SPEEDへ
    // 加速し直す設計）が一度も働く前の同一フレームで即座に固定されて
    // しまい、「最終進入(トンネル)の条件を飛ばして距離200〜250の
    // どこかで入港・固定される」不具合になっていた。distance <=
    // ZONE_FINAL_APPROACHを追加することで、実際にトンネルを通過して
    // distanceが200以下になるまでは固定されず、_runTunnelPhaseの
    // 前進プロファイルが必ず一度は働くようになる。_meetsArrivalCriteria
    // 自体にdistanceを含めない理由は同関数のコメント参照（brake250→
    // tunnel遷移判定とも共用しており、あちらにdistance条件を混ぜると
    // 別の不具合が再発する）。
    // v53: ARRIVAL_SPEED（速度条件）だけでなく、目的地までの実距離が
    // ARRIVAL_DISTANCE未満であることも必須にする。戦艦級などの重い艦は
    // 制動距離が長く、distance<=ZONE_FINAL_APPROACH（トンネル内）の
    // どこかで速度だけ先に0.5を切ってしまい、まだ距離が残っている
    // 位置で固定されてしまう不具合があったため。_meetsArrivalCriteria
    // 自体にはdistanceを混ぜない（brake250→tunnel遷移判定と共用のため、
    // 同関数のコメント参照）。
    if (
      phase === 'tunnel' &&
      distance <= params.ZONE_FINAL_APPROACH &&
      distance <= params.ARRIVAL_DISTANCE &&
      this._meetsArrivalCriteria(ship, target, params)
    ) {
      this._lockShipAtTarget(ship, target);
      return { desiredForce: { x: 0, y: 0, z: 0 }, desiredTorque: { x: 0, y: 0, z: 0 } };
    }

    const desiredForce = { x: 0, y: 0, z: 0 };
    const desiredTorque = { x: 0, y: 0, z: 0 };

    switch (phase) {
      case 'cruise':
        this._runCruisePhase(ship, target, approachAxisWorld, distance, params, desiredForce, desiredTorque, dt);
        break;
      case 'approach':
        // v50-fix4: distance=ZONE_ADJUST_START(500)でほぼ速度上限
        // (APPROACH_MAX_BRAKING_DISTANCE相当)まで減速し切っておく。
        // 従来はstopAtDistance未指定（target.position基準の緩い
        // 減速）だったため、cruiseから大きな速度を持ち込んだ場合に
        // approach区間(800→500)だけでは減速しきれず、adjust以降へ
        // 速度超過を引きずってオーバーシュートの一因になっていた。
        this._runApproachPhase(ship, target, approachAxisWorld, distance, lateral, params, desiredForce, desiredTorque, dt, params.APPROACH_MAX_BRAKING_DISTANCE, params.ZONE_ADJUST_START);
        break;
      case 'adjust':
        // v50: distance=ZONE_BRAKE300でほぼ停止させておく
        // （brake300が「そこからブレーキ開始」ではなく「軸合わせの
        // 微調整だけ」で済むようにする設計要件。_runApproachPhase側の
        // stopAtDistanceコメント参照）。
        this._runApproachPhase(ship, target, approachAxisWorld, distance, lateral, params, desiredForce, desiredTorque, dt, params.ADJUST_MAX_BRAKING_DISTANCE, params.ZONE_BRAKE300);
        break;
      case 'brake300':
        this._runBrakePhase(ship, target, approachAxisWorld, params, desiredForce, desiredTorque, dt, 'brake300', params.ZONE_BRAKE300, () => {
          ship._dockingBrake300Done = true;
        });
        break;
      case 'final_approach':
        this._runFinalApproachAdjustPhase(ship, target, approachAxisWorld, distance, params, desiredForce, desiredTorque, dt);
        break;
      case 'brake250':
        this._runBrakePhase(ship, target, approachAxisWorld, params, desiredForce, desiredTorque, dt, 'brake250', params.ZONE_BRAKE250, null);
        break;
      case 'tunnel':
        this._runTunnelPhase(ship, target, approachAxisWorld, distance, params, desiredForce, desiredTorque, dt);
        break;
      case 'overshoot':
        this._runOvershootPhase(ship, target, approachAxisWorld, params, desiredForce, desiredTorque, dt);
        break;
      case 'return_to_axis':
        this._runReturnToAxisPhase(ship, target, approachAxisWorld, distance, lateral, params, desiredForce, desiredTorque, dt);
        break;
      case 'docked':
        // 既に_lockShipAtTargetで位置・姿勢・速度を固定済み。維持の
        // ためフォース・トルクは常に0（何もしない）。
        break;
      default:
        break;
    }

    return { desiredForce, desiredTorque };
  },

  // cruiseフェーズの速度設計（v66時点）:
  // - 自由航行中(speedCap)は無制限。艦の最高速度まで自由に加速してよい。
  // - distance=ZONE_APPROACH_START(800)までの残り距離を制動距離の基準
  //   (stoppingDistanceForCapOverride)にし、その終端で目指す速度
  //   (stoppingTargetSpeedOverride)をapproachフェーズの巡航速度上限
  //   (APPROACH_MAX_BRAKING_DISTANCE相当)にする。これにより境界より
  //   十分遠い間は減速の必要がなく最高速度で巡航でき、境界に近づくに
  //   つれ「境界到達時にちょうどapproachフェーズの巡航速度まで（0には
  //   ならず）滑らかに減速し切る」曲線になる。
  //
  // 経緯: v64以前はこの制動距離ベースの上限が常に「終端で速度0」を
  // 狙う計算だったため、境界到達時に速度がほぼ0まで落ち、そこから
  // approachフェーズの再加速を待つ間ほぼ静止してしまう不具合があった
  // （実測ログdocking-log-2026-08-31T05-15-20-415Zで確認）。v65は
  // これを「speedCap自体をAPPROACH_MAX_BRAKING_DISTANCE相当に固定する」
  // 形で対応したが、今度はcruise開始直後からその低い上限に張り付いて
  // しまい、「自由航行中は最高速度まで出してよい」という要件を壊して
  // いた（実測ログdocking-log-2026-08-31T06-21-00-245Zで確認）。v66で
  // は_applyApproachForceに終端目標速度を指定できる引数を追加し、
  // speedCapは無制限のまま・制動距離ベースの上限だけが0以外の値へ
  // 収束するようにして両方の要件を同時に満たす形にした。
  //
  // -----------------------------------------------------------
  // cruise: 自由巡航。仕想WPへの最短ベクトルへ向け、加速・上記の速度
  // プロファイルに従って巡航する単純なボング＝ボング制御。
  // 姿勢もできれば早めに整えたいが強制はしない
  // （DOCKING_HEADING_FULL_TORQUE_ANGLEの緩い閾値のまま）。
  // -----------------------------------------------------------
  _runCruisePhase(ship, target, approachAxisWorld, distance, params, desiredForce, desiredTorque, dt) {
    const virtualWP = this._computeVirtualWaypoint(target, approachAxisWorld, distance, params);
    const toWP = {
      x: virtualWP.x - ship.position.x,
      y: virtualWP.y - ship.position.y,
      z: virtualWP.z - ship.position.z,
    };
    const wpDist = vecLength(toWP);
    const headingTargetWorld = wpDist > 1e-4 ? vecScale(toWP, 1 / wpDist) : approachAxisWorld;

    this._applyHeadingTorque(ship, headingTargetWorld, this.DOCKING_HEADING_FULL_TORQUE_ANGLE, desiredTorque);
    this._applyRollTorque(ship, target, desiredTorque, this.DOCKING_HEADING_FULL_TORQUE_ANGLE);
    this._applyAngularDamping(ship, desiredTorque, dt, params.ARRIVAL_ANGULAR_SPEED);

    // v65-fix2: cruise中のspeedCap自体は無制限（艦の最高速度まで自由に
    // 巡航してよい）に戻す。distance=ZONE_APPROACH_START(800)までの
    // 残り距離を制動距離の基準にしつつ、その終端で目指す速度を0では
    // なくAPPROACH_MAX_BRAKING_DISTANCE相当のapproachフェーズ巡航速度
    // にすることで、「境界到達時に速度0で停止」ではなく「境界到達時に
    // approachフェーズの上限速度まで滑らかに減速し、そのままapproachへ
    // 合流する」という本来の意図通りの挙動にする。
    const stoppingBasisDistance = Math.max(0, distance - params.ZONE_APPROACH_START);
    const approachCapSpeed = this._speedForBrakingDistance(
      this._estimateMaxLinearDecel(ship),
      params.APPROACH_MAX_BRAKING_DISTANCE
    );
    this._applyApproachForce(ship, virtualWP, null, desiredForce, stoppingBasisDistance, params, approachCapSpeed);
  },

  // -----------------------------------------------------------
  // approach / adjust: 共通ロジック。maxBrakingDistanceで指定された
  // 速度上限を守りつつ、仕想WPへ向かう。並進・旋回・逆噴射すべて可。
  // 半径AVOIDANCE_RADIUS以上かつまだ軸上に乗っていない場合は、
  // 仕想WPそのものではなく、進入軸上の固定中間地点
  // （_computeAvoidanceWaypoint）を経由する。
  //
  // 二段階方式: 艦が中間地点よりtargetから見て遠い側にいる間は
  // 中間地点そのものを目指す。艦が既に中間地点よりtargetに近い
  // 位置まで進んでいる場合は、中間地点を目指す意味がない（それは
  // 「もう通り過ぎた地点まで戻れ」という逆走の指示になってしまう
  // ため、過去に実際に不具合として発生した）ので、通常の仕想WPを
  // 目指す。
  //
  // v50: stopAtDistance（省略可）。approachフェーズはtarget.position
  // （distance=0）へ向けて自然に減速する挙動でよいが、adjustフェーズ
  // には「distance=300（ZONE_BRAKE300）到達時にほぼ停止させておき、
  // brake300では最後の微調整だけで済ませる」という設計要件がある。
  // 従来は両フェーズともdistanceそのもの（＝distance=0基準）を
  // 減速の基準にしていたため、adjust中はdistance=300を跨ぐ時点でも
  // まだ「そこまでの制動距離」に余裕があり速度が落ちきらず、結果
  // 「距離300から止まろうとする」（＝300地点でようやく本格的な
  // 停止動作を始める）体感になっていた。stopAtDistanceを指定すると
  // 減速の基準を「そこまでの残り距離(distance-stopAtDistance)」に
  // 置き換え、ちょうどdistance=stopAtDistanceで速度が0へ収束する
  // ようにする。
  // -----------------------------------------------------------
  _runApproachPhase(ship, target, approachAxisWorld, distance, lateral, params, desiredForce, desiredTorque, dt, maxBrakingDistance, stopAtDistance) {
    const virtualWP = this._computeVirtualWaypoint(target, approachAxisWorld, distance, params);

    const avoidanceWP = this._computeAvoidanceWaypoint(ship, target, approachAxisWorld, params);
    // 艦から見て中間地点がまだ「target方向」にある（＝艦がまだ
    // 中間地点を通り過ぎていない）かどうかを、進入軸方向の位置
    // 関係で判定する。
    const toShip = {
      x: ship.position.x - target.position.x,
      y: ship.position.y - target.position.y,
      z: ship.position.z - target.position.z,
    };
    // v50-fix2: v50-fixのshipAlong修正は方向としては正しかったが、
    // 上のalongDist側の修正(-rawAlongへの反転)と符号規約がズレて
    // いた。shipAlongはこのままで正しい（艦が手前側にいるとtoShipは
    // -approachAxisWorld方向を向くため、内積は負になる想定だったが、
    // 実際にはtoShip = ship.position - target.positionで、艦が手前
    // 側にいれば ship.position は target.position + approachAxisWorld*
    // 手前距離 の逆側、すなわちtoShipはapproachAxisWorldの逆方向。
    // よってvecDot(toShip, approachAxisWorld)は手前側で負になるため、
    // 「正なら手前側」というコメントは誤りで、実際は符号を反転する
    // 必要がある）。alongDist側と統一し、-1を掛けて「正=手前側」に
    // 揃える。
    const shipAlong = -vecDot(toShip, approachAxisWorld); // 艦の「手前距離」(正なら手前側)
    const avoidanceAlong = params.VIRTUAL_WAYPOINT_OFFSET + params.AVOIDANCE_RADIUS; // 中間地点の「手前距離」(固定)
    const shipStillBehindAvoidance = shipAlong > avoidanceAlong + 1e-3;

    const needsAvoidance = lateral > 1e-3 && shipStillBehindAvoidance;
    const steerTarget = needsAvoidance ? avoidanceWP : virtualWP;

    const toSteer = {
      x: steerTarget.x - ship.position.x,
      y: steerTarget.y - ship.position.y,
      z: steerTarget.z - ship.position.z,
    };
    const steerDist = vecLength(toSteer);
    // v58: steerDistがHEADING_STEER_STABILIZE_RADIUS未満のときは、
    // toSteerの向きをそのまま船首目標にしない。virtualWPは
    // 「target.positionからapproachAxisWorld方向にoffset=min(
    // VIRTUAL_WAYPOINT_OFFSET, distance)だけ引いた点」であり、
    // distanceがVIRTUAL_WAYPOINT_OFFSET(500)に近いadjust突入直後は
    // offset≈distanceとなって、virtualWPの進入軸方向の位置が艦の
    // 現在位置とほぼ一致してしまう。この状態でtoSteerを取ると、
    // 進入軸方向の成分がほぼ相殺され、残るのはlateral（横ズレ）に
    // 由来するサブメートル単位の微小成分だけになる。lateralはこの
    // 距離帯で0.02〜0.24程度の範囲を絶えず揺らいでおり、その向きは
    // ほぼノイズなので、toSteerの向き（＝船首目標）がフレームごとに
    // 大きく暴れ、姿勢制御が実際には存在しない「方向の変化」を
    // 追いかけて艦がグルグル回り続ける不具合になっていた（実測ログで
    // distance/alongDistが473.3〜473.8にほぼ張り付いたまま、lateralは
    // 0.02〜0.24の間で振動し続け、angSpeedが1〜3.5rad/sの高い値で
    // 張り付いていたことを確認した）。
    // 対応: steerDistがHEADING_STEER_STABILIZE_RADIUS未満の間は、
    // 船首目標をapproachAxisWorld（進入軸方向）とtoSteerの向きとで
    // steerDistに応じて線形ブレンドする。steerDist=0でapproachAxisWorld
    // 100%、steerDist=HEADING_STEER_STABILIZE_RADIUSでtoSteerの向き
    // 100%になり、境界での不連続なジャンプを避けつつ、目標点に
    // 極端に近い（＝方向がノイズ支配になる）場面でだけ安定した
    // 進入軸方向を優先させる。
    // ※ここで安定化するのは船首方向(headingTargetWorld)のみ。
    // 並進側（_applyApproachForceに渡す目標点）は同じ問題を抱えた
    // ままだったため、後日v58-fix2で別途対応した
    // （headingTargetWorld算出直後のコメント参照）。
    let headingTargetWorld;
    if (steerDist > this.HEADING_STEER_STABILIZE_RADIUS) {
      headingTargetWorld = vecScale(toSteer, 1 / steerDist);
    } else if (steerDist > 1e-4) {
      const steerDirRaw = vecScale(toSteer, 1 / steerDist);
      const blend = steerDist / this.HEADING_STEER_STABILIZE_RADIUS; // 0..1, toSteerの向きの寄与
      const blended = {
        x: approachAxisWorld.x * (1 - blend) + steerDirRaw.x * blend,
        y: approachAxisWorld.y * (1 - blend) + steerDirRaw.y * blend,
        z: approachAxisWorld.z * (1 - blend) + steerDirRaw.z * blend,
      };
      const blendedLen = vecLength(blended);
      headingTargetWorld = blendedLen > 1e-6 ? vecScale(blended, 1 / blendedLen) : approachAxisWorld;
    } else {
      headingTargetWorld = approachAxisWorld;
    }

    const fullTorqueAngle = this._computeHeadingFullTorqueAngle(distance, params);
    this._applyHeadingTorque(ship, headingTargetWorld, fullTorqueAngle, desiredTorque);
    this._applyRollTorque(ship, target, desiredTorque, fullTorqueAngle);
    this._applyAngularDamping(ship, desiredTorque, dt, params.ARRIVAL_ANGULAR_SPEED);

    // v58-fix2: 上のheadingTargetWorldと同じ理由で、_applyApproachForce
    // に渡す並進の目標点もsteerTargetをそのまま渡してはいけなかった。
    // _applyApproachForceは内部で`targetPosWorld - ship.position`から
    // 方向を再計算するため、steerTargetが艦の現在位置とほぼ一致する
    // 場面（distance≈VIRTUAL_WAYPOINT_OFFSET直後）では、その方向も
    // lateral由来のノイズに支配される。姿勢だけを安定させても、
    // 並進の推力方向がノイズのままではスラストが実質ランダムな
    // 向きに出続け、閉じるはずの距離が閉じず、かえって奥へ流れて
    // しまう（実測ログで、adjust突入直後は正常にdistanceが508→
    // 493.79まで縮んだのに、その後velZの符号が数十msごとに反転する
    // 微小振動に転じ、さらに長時間（数十万ms）かけてdistanceが
    // 493.79→497.5超までじわじわ後退し続けていたことを確認した）。
    // 対応: _applyApproachForceに渡す目標点は、steerTargetそのもの
    // ではなく、既に安定化済みのheadingTargetWorld方向へ艦の位置から
    // 十分離れた点（FORCE_AIM_POINT_DISTANCE）を新たに置いたものに
    // する。_applyApproachForceの速度上限・制動距離判定は
    // steerTarget自体への距離ではなくstoppingBasisDistance（引数で
    // 別途渡す実距離ベースの値）を基準にしているため、この置き換えは
    // 減速プロファイルには影響せず、推力の「向き」だけを
    // headingTargetWorldに揃える効果に限定される。
    const forceAimPoint = {
      x: ship.position.x + headingTargetWorld.x * this.FORCE_AIM_POINT_DISTANCE,
      y: ship.position.y + headingTargetWorld.y * this.FORCE_AIM_POINT_DISTANCE,
      z: ship.position.z + headingTargetWorld.z * this.FORCE_AIM_POINT_DISTANCE,
    };

    // 減速の基準はtarget.positionへの実距離(distance)を使う
    // （操舵方向は仕想WP/迂回点だが、停止の基準は実際の目的地への
    // 距離であるべき。_applyApproachForceのコメント参照）。
    // v50: stopAtDistance指定時は、target.positionではなくそこまでの
    // 残り距離を基準にする（adjustフェーズをdistance=ZONE_BRAKE300で
    // ほぼ停止させるため。距離が既にstopAtDistanceを下回っていても
    // 0未満にはしない — _speedForBrakingDistance側でも安全側にクランプ
    // されるが、ここでも明示しておく）。
    const stoppingBasisDistance =
      stopAtDistance !== undefined ? Math.max(0, distance - stopAtDistance) : distance;
    this._applyApproachForce(ship, forceAimPoint, maxBrakingDistance, desiredForce, stoppingBasisDistance, params);

    // v56: _applyApproachForceの横滑りブレーキ(lateralVel成分の除去)
    // だけでは、進入軸に対する横方向の「位置ズレ」自体を縮める力には
    // ならない（艦が既にsteerTarget方向へまっすぐ飛んでいれば
    // lateralSpeedはほぼ0になり、ブレーキは何もしないため）。この
    // ため従来はapproach/adjust中、横方向の位置ズレ(lateral)がほぼ
    // 縮まらず、brake300へ到達してdistanceが止まった後になって
    // ようやく_applySettlingForce（brake300/250専用の横方向収束制御）
    // が効き出す、という「distance=ZONE_BRAKE300の停止位置にいないと
    // 軸合わせがほとんど進まない」不具合になっていた（実測ログで、
    // adjust中はdistanceが500→300まで進む間にlateralが10.7→8.4程度
    // までしか縮まらず、brake300に入った直後の短時間でほぼ0まで
    // 収束していたことを確認した）。
    // 対応: 進入軸上、艦の現在alongDist位置に対応する点を横方向のみの
    // 目標点とし、_applySettlingForceと同じ収束制御を弱めのゲインで
    // 常時かける。前後方向はstoppingBasisDistance側の速度制御が
    // 別途握っているため、ここでは横方向成分のみを目的とする
    // （_applySettlingForce自体はローカル速度の全軸を対象にするが、
    // 目標点を「艦の現在along位置・横方向だけtargetに寄せた点」に
    // することで、前後方向の目標速度は艦の現在位置=0付近になり、
    // 前後方向制御への干渉は小さい）。
    const toShipForLateral = {
      x: ship.position.x - target.position.x,
      y: ship.position.y - target.position.y,
      z: ship.position.z - target.position.z,
    };
    const shipAlongForLateral = vecDot(toShipForLateral, approachAxisWorld);
    const lateralOnlyTargetWorld = {
      x: ship.position.x - (toShipForLateral.x - approachAxisWorld.x * shipAlongForLateral),
      y: ship.position.y - (toShipForLateral.y - approachAxisWorld.y * shipAlongForLateral),
      z: ship.position.z - (toShipForLateral.z - approachAxisWorld.z * shipAlongForLateral),
    };
    this._applySettlingForce(ship, lateralOnlyTargetWorld, desiredForce, this.ADJUST_LATERAL_SETTLE_GAIN);

    desiredForce.x = clamp(desiredForce.x, -1, 1);
    desiredForce.y = clamp(desiredForce.y, -1, 1);
    desiredForce.z = clamp(desiredForce.z, -1, 1);
  },

  // フルトルクになる角度閾値を、ZONE_APPROACH_START→ZONE_BRAKE300の
  // 間で緩め(DOCKING_HEADING_FULL_TORQUE_ANGLE)から厳しめ
  // (DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE)へ線形補間する。
  _computeHeadingFullTorqueAngle(distance, params) {
    const start = params.ZONE_APPROACH_START;
    const end = params.ZONE_BRAKE300;
    const blendRange = Math.max(1e-6, start - end);
    const t = clamp((start - distance) / blendRange, 0, 1);
    return (
      this.DOCKING_HEADING_FULL_TORQUE_ANGLE +
      (this.DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE - this.DOCKING_HEADING_FULL_TORQUE_ANGLE) * t
    );
  },

  // -----------------------------------------------------------
  // 位置合わせ専用の並進力を desiredForce に加算する。目標位置
  // (targetPosWorld)への距離に比例した目標速度（近いほど遅く、
  // DOCKING_POSITION_MIN_DISTANCE以下では0）を立て、実際の速度を
  // その目標速度に一致させる速度フィードバック制御。
  //
  // _applyApproachForceとの違い: _applyApproachForceは「制動距離
  // ベースの速度上限」を守りつつ自由に加速することを許す（cruise/
  // approach/adjustのような、まだ大きく移動する必要があるフェーズ
  // 向け）。対してこちらは「最終的に位置誤差ゼロ・速度ゼロで静止
  // させる」ことだけを目的にした収束制御で、距離に比例した目標
  // 速度を必ず下回らせるため、位置誤差が小さければ速度も必ず
  // 小さくなることが保証される（brake300/brake250のような、
  // その場でピタリと止めたいフェーズ向け）。
  //
  // v49: strengthの計算にFORWARD_VELOCITY_FULL_THROTTLE_ERROR(40.0)
  // を流用していたが、これはcruise/approachのような数十単位の
  // 速度域向けの分母であり、brake300/brake250のような「距離0.数～
  // 数十、目標速度も0.数～数」という微速域の収束制御でこれを使うと
  // 常にstrengthが極端に低く（例: 誤差0.5でもstrength=0.0125）
  // なり、横方向のRCS推力がただでさえ主機より弱いこととも相まって
  // 「いつまで経っても軸に乗り切らない」不具合の原因になっていた。
  // 専用の小さい分母(DOCKING_SETTLE_FULL_THRUST_ERROR)を使い、
  // 微速域でも十分な推力が出るようにする。
  // -----------------------------------------------------------
  DOCKING_SETTLE_APPROACH_GAIN: 0.5, // 距離に対する目標速度の比例ゲイン(1/s)
  DOCKING_SETTLE_MAX_SPEED: 15.0,    // 目標速度の上限（遠距離でも暴走しないため）
  DOCKING_SETTLE_FULL_THRUST_ERROR: 1.0, // 速度誤差がこれ以上でフル推力（微速域用の分母）
  // v56: approach/adjustフェーズで横方向の位置ズレを常時弱く補正する
  // 際に使うゲイン。DOCKING_SETTLE_APPROACH_GAIN(brake300/250の
  // 「完全静止」用、強め)より弱くし、cruise/approach/adjustの主目的
  // である前後方向の巡航・減速制御を横方向の補正で乱さないようにする。
  ADJUST_LATERAL_SETTLE_GAIN: 0.15,

  _applySettlingForce(ship, targetPosWorld, desiredForce, gainOverride) {
    const toTargetWorld = {
      x: targetPosWorld.x - ship.position.x,
      y: targetPosWorld.y - ship.position.y,
      z: targetPosWorld.z - ship.position.z,
    };
    const distance = vecLength(toTargetWorld);
    if (distance <= this.DOCKING_POSITION_MIN_DISTANCE) return;

    const dirWorld = vecScale(toTargetWorld, 1 / distance);
    const gain = gainOverride !== undefined ? gainOverride : this.DOCKING_SETTLE_APPROACH_GAIN;
    const targetSpeed = Math.min(this.DOCKING_SETTLE_MAX_SPEED, distance * gain);
    const targetVelWorld = vecScale(dirWorld, targetSpeed);

    const targetVelLocal = rotateVecByQuat(targetVelWorld, conjugateQuat(ship.quaternion));
    const localVel = rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion));
    const errLocal = {
      x: targetVelLocal.x - localVel.x,
      y: targetVelLocal.y - localVel.y,
      z: targetVelLocal.z - localVel.z,
    };
    const errMag = vecLength(errLocal);
    if (errMag < 1e-4) return;
    const dir = vecScale(errLocal, 1 / errMag);
    const strength = Math.min(1, errMag / this.DOCKING_SETTLE_FULL_THRUST_ERROR);
    desiredForce.x += dir.x * strength;
    desiredForce.y += dir.y * strength;
    desiredForce.z += dir.z * strength;
  },

  // -----------------------------------------------------------
  // brake300 / brake250: 完全静止してから、軸上への位置合わせ・
  // 姿勢合わせを行う。
  //
  // 並進は前後方向(Z、進入軸方向)と横方向(X/Y、進入軸に垂直)を
  // 分離して制御する:
  //   - 前後方向: ワールド速度のうち進入軸方向の成分だけを0へ
  //     ブレーキする（distanceそのものは変えない）。
  //   - 横方向: 進入軸への垂線距離(lateralDist)を0へ詰める収束制御
  //     （_applySettlingForce。距離に比例した目標速度に確実に
  //     追従させ、位置・速度とも0へ収束することを保証する）。
  // 前後・横方向を分離するのは、艦によって前後方向(主機)と横方向
  // (RCS)の推力が大きく異なるため（横方向が主機よりずっと弱い艦は
  // 珍しくない）、「全方位まとめて完全停止するまで待ってから横方向を
  // 直す」という二段階方式だと、横方向の速度がなかなか完全な0へ
  // 収束せず横方向補正が実質発火しない膠着を起こしうるため。
  // 前後・横方向とも常時・独立に制御することで、この膠着を避ける。
  //
  //   phaseKind: 'brake300' | 'brake250'（ログ・将来拡張用、現状は
  //              挙動は共通）
  //   targetDistance: このフェーズで艦を静止させたい、target.position
  //     までの距離（brake300ならZONE_BRAKE300=300、brake250なら
  //     ZONE_BRAKE250=250）。進入軸上のこの距離の点を目標位置とする。
  //   onSettled: 前後方向速度・横方向位置誤差とも十分収まった際に
  //              一度だけ呼ぶコールバック（brake300が「完了済み」
  //              フラグを立てるために使う）
  //
  // v50-fix3: 従来は前後方向を「今の速度を0にする」ブレーキだけで
  // 処理しており、目標distance（300/250）への位置補正が一切
  // なかった。直前のadjust/final_approachフェーズの事前減速だけでは
  // フレーム単位の誤差や安全マージンの影響でdistanceがぴったり
  // targetDistanceに一致した瞬間に速度0になるとは限らず、わずかに
  // 行き過ぎた（または届く前で速度が残っている）位置でbrake300/250に
  // 切り替わると、前後方向はその位置のままの速度を0にするだけ
  // だったため、行き過ぎた位置に居座り続けてしまっていた
  // （「-300、-250でブレーキをかけ始めている」という報告の原因）。
  // 横方向で既に使っている_applySettlingForce（位置誤差に比例した
  // 目標速度を作り、位置・速度とも0へ収束させる関数）を前後方向にも
  // 使うことで、多少の行き過ぎがあっても最終的にdistance=
  // targetDistanceへ正確に収束するようにする。
  // -----------------------------------------------------------
  _runBrakePhase(ship, target, approachAxisWorld, params, desiredForce, desiredTorque, dt, phaseKind, targetDistance, onSettled) {
    // 姿勢は常にtarget.quaternion方向へ合わせにいく（厳しめ角度）。
    const headingTargetWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    this._applyHeadingTorque(ship, headingTargetWorld, this.DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE, desiredTorque);
    this._applyRollTorque(ship, target, desiredTorque, this.DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE);
    this._applyAngularDamping(ship, desiredTorque, dt, params.ARRIVAL_ANGULAR_SPEED);

    const toTargetWorld = {
      x: target.position.x - ship.position.x,
      y: target.position.y - ship.position.y,
      z: target.position.z - ship.position.z,
    };
    const rawAlong = vecDot(toTargetWorld, approachAxisWorld);
    const alongDist = rawAlong; // 正=手前側, 負=奥側
    const lateralVec = {
      x: toTargetWorld.x - approachAxisWorld.x * rawAlong,
      y: toTargetWorld.y - approachAxisWorld.y * rawAlong,
      z: toTargetWorld.z - approachAxisWorld.z * rawAlong,
    };
    const lateralDist = vecLength(lateralVec);

    // --- 前後方向(進入軸方向): distance=targetDistanceの点へ ---
    // 進入軸上、target.positionからtargetDistanceだけ手前
    // （-approachAxisWorld方向）の点を目標位置とし、_applySettlingForce
    // で位置・速度とも0へ収束させる。alongDistがtargetDistanceより
    // 大きい（まだ手前すぎる）場合は前進、小さい（行き過ぎ・奥寄り）
    // 場合は後退方向の力が自動的に出る。
    // 横方向にはズレさせたくないので、目標点の横方向成分は艦の現在の
    // 横ズレ(lateralVec)に置き換える（横方向は下の_applySettlingForce
    // で別途扱うため、ここでは前後方向だけを動かす目標点にする）。
    const alongOnlyTargetWorld = {
      x: ship.position.x + lateralVec.x + approachAxisWorld.x * (alongDist - targetDistance),
      y: ship.position.y + lateralVec.y + approachAxisWorld.y * (alongDist - targetDistance),
      z: ship.position.z + lateralVec.z + approachAxisWorld.z * (alongDist - targetDistance),
    };
    this._applySettlingForce(ship, alongOnlyTargetWorld, desiredForce);

    // --- 横方向(進入軸に垂直)は位置・速度とも0へ収束する制御 ---
    // 「進入軸上、艦の現在のalongDistと同じ位置」を横方向の目標点
    // とすることで、前後方向には影響を与えず横ズレだけを縮める。
    const lateralTargetWorld = {
      x: ship.position.x + lateralVec.x,
      y: ship.position.y + lateralVec.y,
      z: ship.position.z + lateralVec.z,
    };
    this._applySettlingForce(ship, lateralTargetWorld, desiredForce);

    desiredForce.x = clamp(desiredForce.x, -1, 1);
    desiredForce.y = clamp(desiredForce.y, -1, 1);
    desiredForce.z = clamp(desiredForce.z, -1, 1);

    // 完了判定: 前後方向の位置誤差・速度・横方向位置誤差とも十分小さいこと。
    const alongPosError = Math.abs(targetDistance - alongDist);
    const alongSpeedWorld = vecDot(ship.velocity, approachAxisWorld);
    const alongSpeed = Math.abs(alongSpeedWorld);
    const settled =
      alongSpeed < params.STOP_SPEED_EPSILON &&
      alongPosError <= this.DOCKING_POSITION_MIN_DISTANCE &&
      lateralDist <= this.DOCKING_POSITION_MIN_DISTANCE;
    if (settled && onSettled) {
      onSettled();
    }
  },


  // -----------------------------------------------------------
  // final_approach: distance 300→250。並進・旋回・逆噴射可、
  // 停止はしない。姿勢をtarget.quaternionへ整え続ける。距離250へ
  // 到達した時点でまだ入港基準を満たしていなければbrake250へ
  // 遷移する（_resolveDockingPhase側で処理済み、ここでは通常の
  // 前進+姿勢合わせのみ行えばよい）。
  //
  // v50-fix3: 従来はtarget.position（distance=0）を減速基準にして
  // いたため、distance=250に到達する時点ではまだ「制動距離の余裕」
  // が残っており、速度が十分落ちきらないままbrake250へ切り替わって
  // いた（brake300のときと同じ理由の不具合）。adjustフェーズの
  // stopAtDistanceと同じ考え方で、減速基準を「distance=ZONE_BRAKE250
  // までの残り距離」に変更し、distance=250でほぼ速度0になるよう
  // 事前減速する。
  // -----------------------------------------------------------
  _runFinalApproachAdjustPhase(ship, target, approachAxisWorld, distance, params, desiredForce, desiredTorque, dt) {
    const headingTargetWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    this._applyHeadingTorque(ship, headingTargetWorld, this.DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE, desiredTorque);
    this._applyRollTorque(ship, target, desiredTorque, this.DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE);
    this._applyAngularDamping(ship, desiredTorque, dt, params.ARRIVAL_ANGULAR_SPEED);

    // 並進: target.positionへ、ADJUST_MAX_BRAKING_DISTANCE程度の
    // 控えめな速度上限で進む。横方向はフルで補正、前後は緩やかに。
    // 減速の基準はdistance=ZONE_BRAKE250までの残り距離
    // （stoppingDistanceForCapOverride）にする。
    const stoppingBasisDistance = Math.max(0, distance - params.ZONE_BRAKE250);
    this._applyApproachForce(ship, target.position, params.ADJUST_MAX_BRAKING_DISTANCE, desiredForce, stoppingBasisDistance, params);
  },

  // -----------------------------------------------------------
  // tunnel: 最終進入（トンネル内部）。旋回・並進・逆噴射すべて禁止。
  // 姿勢はtarget.quaternionへ完全固定（トルク要求を出さず、角速度も
  // 強制的にゼロへ吸収する — トンネル内は物理的に旋回不可という
  // 前提のため、通常の比例トルクではなく直接ロックする）。
  // 前後方向のみ、distance=ZONE_FINAL_APPROACH地点でFINAL_APPROACH_
  // ENTRY_SPEED、そこからトンネル全長を使って徐々に速度0へ収束する
  // プロファイルで前進する（v52-fix3、詳細は関数内コメント参照）。
  // -----------------------------------------------------------
  _runTunnelPhase(ship, target, approachAxisWorld, distance, params, desiredForce, desiredTorque, dt) {
    // 姿勢: 常に目的地姿勢へ強制固定（旋回禁止のため、通常の比例
    // トルクは使わず角速度そのものを毎フレーム0にする）。
    ship.quaternion.x = target.quaternion.x;
    ship.quaternion.y = target.quaternion.y;
    ship.quaternion.z = target.quaternion.z;
    ship.quaternion.w = target.quaternion.w;
    ship.angularVelocity.x = 0;
    ship.angularVelocity.y = 0;
    ship.angularVelocity.z = 0;
    // desiredTorqueは0のまま（トルク要求そのものを出さない）。

    // 並進: 横方向(X/Y、進入軸に垂直)は完全に禁止（並進0を維持する
    // ため何もしない＝横方向の力は一切出さない）。前後方向(Z、
    // 進入軸方向)のみ、目標速度プロファイルへ追従する。
    const maxDecel = this._estimateMaxLinearDecel(ship);
    // v52-fix3: 減速プロファイルの基準距離を修正。
    // 従来はFINAL_APPROACH_BRAKING_DISTANCE(10)を使っており、
    // distance=ZONE_FINAL_APPROACH(200)からdistance=10までの190分は
    // 目標速度が常にFINAL_APPROACH_ENTRY_SPEED(3.0)のまま（速度上限
    // なしで巡航）、残り10の区間でのみ0まで急減速する「駆け込み
    // ブレーキ」になっていた。「距離200から徐々に減速していく」という
    // コメントの本来の意図（トンネル全体を使った滑らかな減速曲線）と
    // 実装が食い違っていた。トンネル全長(ZONE_FINAL_APPROACH)を
    // 減速基準距離として使うことで、トンネル突入直後から停止点まで
    // 一貫して減速し続けるプロファイルにする。
    // v(d) = ENTRY_SPEED * sqrt(d / ZONE_FINAL_APPROACH) （d: 残り距離）
    //
    // v60: 「最終進入が設計通りだが遅い、距離50の範囲で停船しきれる
    // 速度にしたい（船の重さで変わってよい）」という要望を受け、
    // ENTRY_SPEEDを固定値(3.0)ではなく、艦の実際の制動能力
    // (maxDecel)から「残り距離FINAL_APPROACH_STOPPING_DISTANCE(50)
    // で止まりきれる速度」として毎フレーム動的に算出する方式に変更。
    // _speedForBrakingDistanceは既存のBRAKE_SAFETY_MARGIN(0.85)を
    // 内部で適用しているため、艦種によらず「距離50で確実に止まれる
    // 範囲でできるだけ速く」という要件をそのまま満たす。艦が重く
    // maxDecelが小さいほどentrySpeedも自動的に低くなり、軽い艦は
    // 自動的に速くなる。
    const brakingBasisDistance = Math.max(1e-6, params.ZONE_FINAL_APPROACH);
    // v60-fix1: 「decel=16.25の艦だとentrySpeedが約37まで出るのは
    // 速すぎる、20を絶対上限にしたい」との要望を受け、理論上の
    // entrySpeed（制動能力からの逆算値）にFINAL_APPROACH_ENTRY_SPEED_CAP
    // (20)による上限を追加。重い艦（maxDecelが小さい艦）はこれまで
    // 通りFINAL_APPROACH_STOPPING_DISTANCEベースの逆算値がそのまま
    // 効く一方、軽い艦・高出力な艦種で逆算値が20を超える場合は
    // 20で頭打ちにする。
    const entrySpeed = Math.min(
      this._speedForBrakingDistance(maxDecel, params.FINAL_APPROACH_STOPPING_DISTANCE),
      params.FINAL_APPROACH_ENTRY_SPEED_CAP
    );
    const profileSpeed = entrySpeed * Math.sqrt(Math.min(1, distance / brakingBasisDistance));
    // 単純な線形減速でもよいが、艦の実際の制動能力を無視して間に
    // 合わない可能性を避けるため、艦の制動距離から出せる速度と、
    // 要求プロファイルの小さい方を採用する。
    // v60: entrySpeed自体が既にmaxDecelから逆算した「距離50で止まれる
    // 速度」なので、この安全側キャップ(physicalSafeSpeed、残り距離
    // distanceそのものを基準に同じ式で計算)と理論上は近い値になるが、
    // distance>50の区間（トンネル入口付近）ではphysicalSafeSpeedの
    // 方が大きくなるため、実際にprofileSpeed側が効くようになる。
    // 両者を残しておくことで、万一maxDecelがフレームごとに変動する
    // 場合でも安全側が優先される構造は維持する。
    const physicalSafeSpeed = this._speedForBrakingDistance(maxDecel, distance);
    const targetSpeed = Math.max(0, Math.min(profileSpeed, physicalSafeSpeed));

    // v51-fix1: 符号バグを修正。approachAxisWorldは
    // 「艦(手前側)からtarget.positionへ向かう方向」（
    // _buildDesiredForAutoDockingのalongDist計算、および
    // _runOvershootPhaseの「奥方向(-approachAxisWorld方向)」という
    // コメントの双方から裏付けられる符号規約）。よって目的地へ
    // 向かう速度は approachAxisWorld * (+targetSpeed) であるべきところ、
    // 従来はここに -targetSpeed を掛けており、tunnel突入直後から
    // 一貫して目的地とは逆方向（進入軸の手前側）へ加速し続ける
    // バグになっていた。アップロードされた操縦ログ
    // (docking-log-2026-08-30T06-26-24-181Z.csv) で、tunnel突入後
    // velZ/alongDistが単調に増加し続け（艦の実際の変位ベクトルが
    // toTargetWorldと正反対）、最終的にdistanceが250→251超まで
    // 押し戻されてfinal_approachへ逆戻りする様子を確認して特定した。
    const targetVelWorld = vecScale(approachAxisWorld, targetSpeed); // 進入軸のプラス方向＝目的地へ向かう方向
    // 実際に使うのは目標「速度」ではなく目標「速度との差」を前後
    // 方向だけに使う（横方向はそもそも力を出さない）ので、専用に
    // Z成分だけ処理する。
    const localVel = rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion));
    const targetVelLocal = rotateVecByQuat(targetVelWorld, conjugateQuat(ship.quaternion));
    const zError = targetVelLocal.z - localVel.z;
    // v61-fix1: 「逆噴射が速度プロファイルに全く追いつかない」不具合を修正。
    // targetSpeed自体はmaxDecelから正しく逆算されているが、それを実現する
    // 推力側がFORWARD_VELOCITY_FULL_THROTTLE_ERROR(40.0)という汎用の
    // マニュアル操作向け分母を流用しており、tunnel区間で生じる速度誤差
    // (実測ログでは最大でも18前後)はこの40に対して常に小さく、
    // thrustStrengthが0.5以下に頭打ちになって艦の実際の制動能力
    // (maxDecel)を全く使い切れていなかった（v49で同種の問題が
    // brake300/brake250側で見つかり専用分母に切り替えた経緯があるのと
    // 同じ原因）。ここも艦の実際の制動能力(maxDecel)を基準にした専用の
    // 分母に切り替える：1フレーム(dt)でmaxDecel分の速度差を埋めきる
    // 量の誤差でフルスロットルになるようにし、それ未満は比例して弱める。
    const tunnelFullThrottleError = Math.max(1e-6, maxDecel * dt);
    const thrustStrength = Math.min(1, Math.abs(zError) / tunnelFullThrottleError);
    desiredForce.z = Math.sign(zError) * thrustStrength;
    // desiredForce.x/yは0のまま（並進禁止）。
  },

  // -----------------------------------------------------------
  // overshoot: トンネル内でオーバーシュートし、奥側へ抜けていく間。
  // 姿勢は目的地姿勢に固定（tunnelと同じ強制ロック）、直進のみ。
  //
  // 「進入軸の逆走禁止」は「手前側へ戻る方向（approachAxisWorld
  // 方向、艦が入港時に向く方向とは逆）への推力」の禁止であり、
  // 奥へ進む方向（-approachAxisWorld方向、既存の前進の続き）への
  // 推力までは禁止しない。トンネル内の通常の減速プロセスの結果、
  // 奥方向速度がほぼ0まで落ちた状態でわずかに奥側に入り込んだ
  // ケースでは、慣性だけに頼ると永久に立ち往生してしまうため、
  // 主機（奥方向への推力）を使ってOVERSHOOT_REAPPROACH_DISTANCEまで
  // 確実に進めるようにする。
  // -----------------------------------------------------------
  DOCKING_OVERSHOOT_MIN_SPEED: 20.0, // 奥方向速度がこれ未満なら主機で下限速度まで押し出す

  _runOvershootPhase(ship, target, approachAxisWorld, params, desiredForce, desiredTorque, dt) {
    ship.quaternion.x = target.quaternion.x;
    ship.quaternion.y = target.quaternion.y;
    ship.quaternion.z = target.quaternion.z;
    ship.quaternion.w = target.quaternion.w;
    ship.angularVelocity.x = 0;
    ship.angularVelocity.y = 0;
    ship.angularVelocity.z = 0;

    // v52-fix1: 「奥方向」の符号を修正。approachAxisWorldは艦(手前側)
    // から目的地へ向かう方向を指す（tunnelフェーズの符号バグ修正
    // (v52)で確定した規約と同じ）。オーバーシュートは目的地を通過
    // して「さらに奥（進行方向の延長線上）」へ進むことなので、奥方向
    // は approachAxisWorld と同じ向き（+方向）であり、このコメントに
    // あった「-approachAxisWorld方向」は誤りだった。
    // アップロードされた操縦ログ(docking-log-2026-08-30T07-21-13-972Z.csv)
    // で、オーバーシュート突入直後から速度が単調に減少し続け（本来は
    // 主機で下限速度まで押し出すはずが、実際には逆方向へブレーキが
    // かかっていた）、艦の実際の変位方向がapproachAxisWorldと同じ
    // 向きになっていることを直接確認して特定した。
    const outwardSpeed = vecDot(ship.velocity, approachAxisWorld);
    if (outwardSpeed < this.DOCKING_OVERSHOOT_MIN_SPEED) {
      // 奥方向速度が下限を割っている＝慣性だけでは通過完了まで
      // 進みきれない可能性があるため、主機で奥方向へ押し出す。
      // （手前方向=-approachAxisWorld方向への推力は一切出さない
      // ＝逆走禁止を維持する。）
      const outwardDirWorld = approachAxisWorld;
      const outwardDirLocal = rotateVecByQuat(outwardDirWorld, conjugateQuat(ship.quaternion));
      const speedErr = this.DOCKING_OVERSHOOT_MIN_SPEED - outwardSpeed;
      const thrustStrength = Math.min(1, speedErr / this.FORWARD_VELOCITY_FULL_THROTTLE_ERROR);
      desiredForce.x = outwardDirLocal.x * thrustStrength;
      desiredForce.y = outwardDirLocal.y * thrustStrength;
      desiredForce.z = outwardDirLocal.z * thrustStrength;
    }
    // 奥方向速度が既に下限以上なら、desiredForceは0のまま
    // （既存の慣性のみで通過させる）。
  },

  // -----------------------------------------------------------
  // return_to_axis: 艦が進入軸の奥側(alongDist<0)にいる場合の回り込み
  // フェーズ。cruise/approach/adjustはdistance（target.positionへの
  // 直線距離）だけを見ており艦が手前側にいる前提で組まれているため、
  // 奥側にいるままこれらを使うと目的地に正面から向かい合う形になり、
  // 「進入軸を逆走して入る」形になりかねない。
  //
  // 回り込み先は、進入軸上の固定中間地点（_computeAvoidanceWaypoint、
  // target.positionから手前側にVIRTUAL_WAYPOINT_OFFSET+
  // AVOIDANCE_RADIUS離れた、横方向オフセットを持たない点）。
  // これを目指すことで、艦はNO_ENTRY_RADIUS圏内を横切らずに軸の
  // 手前側へ戻る。
  //
  // v48: 従来は速度上限なし(null)で中間地点(target.positionから
  // 750も離れた点)へ全力加速していた。これはapproach中に軸を
  // 横切るように進入軸をオーバーシュートしてreturn_to_axisへ
  // 切り替わった際、艦がまだ高速でtarget.position付近にいるのに
  // 「750先の点へ向けフル加速」してしまい、軸から大きく離れながら
  // 目的地の奥側の点を目指して突っ走る不具合の原因になっていた。
  // このフェーズに入った時点の艦の速度自体をまず制動距離ベースで
  // 抑える（RETURN_TO_AXIS_MAX_BRAKING_DISTANCE）ことで、
  // 「まず今の勢いを殺してから回り込む」挙動にする。
  // -----------------------------------------------------------
  RETURN_TO_AXIS_MAX_BRAKING_DISTANCE: 150,

  _runReturnToAxisPhase(ship, target, approachAxisWorld, distance, lateral, params, desiredForce, desiredTorque, dt) {
    const returnTarget = this._computeAvoidanceWaypoint(ship, target, approachAxisWorld, params);

    const toReturnTarget = {
      x: returnTarget.x - ship.position.x,
      y: returnTarget.y - ship.position.y,
      z: returnTarget.z - ship.position.z,
    };
    const steerDist = vecLength(toReturnTarget);
    const headingTargetWorld = steerDist > 1e-4 ? vecScale(toReturnTarget, 1 / steerDist) : approachAxisWorld;

    this._applyHeadingTorque(ship, headingTargetWorld, this.DOCKING_HEADING_FULL_TORQUE_ANGLE, desiredTorque);
    this._applyRollTorque(ship, target, desiredTorque, this.DOCKING_HEADING_FULL_TORQUE_ANGLE);
    this._applyAngularDamping(ship, desiredTorque, dt, params.ARRIVAL_ANGULAR_SPEED);

    // 制動距離ベースの速度上限を設け、「まず勢いを殺してから
    // 回り込む」挙動にする。速度上限なしだと、target.position付近を
    // 高速で横切った直後にこのフェーズへ入った場合、そのままの
    // 速度で750先の中間地点へ全力加速してしまい大きく軸から
    // 離れてしまう。
    this._applyApproachForce(ship, returnTarget, this.RETURN_TO_AXIS_MAX_BRAKING_DISTANCE, desiredForce, undefined, params);
  },
};
