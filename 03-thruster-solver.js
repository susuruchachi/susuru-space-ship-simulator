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

  // v08: 自動操船（入港）関連の調整値
  // v15: 「目的地が遠くてもまず姿勢合わせのRCSばかり吹いて主機が
  // 働かない」という報告を受け、フルトルクになる角度閾値を約3倍に
  // 緩和（0.35rad≈20° → 1.05rad≈60°）。同じ角度差でもトルクが弱く
  // 出るようになり、姿勢合わせがより穏やかになる。その代わり、
  // 目的方向にヘディングが収束した際は_lockHeadingIfWithinTolerance()
  // が残留角速度を強制的に切り捨てて即座に完全静止させるため、
  // 「弱めた分だけいつまでも微調整し続ける」ことにはならない。
  DOCKING_HEADING_FULL_TORQUE_ANGLE: 1.05, // 船首と目的方向のなす角(rad)がこれ以上でフルトルク、未満は比例して弱める（約60°）
  DOCKING_HEADING_MIN_ANGLE: 0.005, // これ未満の角度差は補正不要（微小振動防止、HEADING_LOCK_TOLERANCE_DEGより粗い一次判定として残置）
  // v22: 「自動操船中、rollは目標(0)へは収束するが、目的地に保存
  // されたroll角そのものへは合わせにいかない」という報告への対応。
  // 従来はrollの手動入力を拒否して角速度ダンピングで止めるだけで、
  // 目的地のroll角を追いかけるトルクを一切発生させていなかった。
  // ここからはautoRollLockActive中（距離800以内）、pitch/yawと
  // 同じ比例制御スキームでroll角も目的地の保存済み姿勢へ揃える
  // （_computeRollErrorAngle参照）。
  DOCKING_ROLL_FULL_TORQUE_ANGLE: 1.05, // roll誤差(rad)がこれ以上でフルトルク（pitch/yawの遠方用と同じ緩さ、約60°）
  DOCKING_ROLL_MIN_ANGLE: 0.005, // これ未満のroll誤差は補正不要（微小振動防止）
  // v23: 「進入軸から大きく横にズレた位置から入港すると、姿勢が
  // 一瞬で揃った状態から目的地の方角へ急変し、往復することもある」
  // という報告への対応。
  //
  // 原因: onApproachSide（艦が進入軸上の手前側にいるか）は
  // alongDistWorld（艦から目的地への方向ベクトルと進入軸の内積）の
  // 符号だけで判定していた。艦が進入軸から大きく横にズレた位置に
  // いると、実際にはまだ十分手前にいても、艦が進入軸方向へわずか
  // 前後に動くだけでこの内積が0付近を跨ぎ、onApproachSideが
  // true/falseを頻繁に反転してしまう（横ズレが150あるのにZが
  // ±10程度動いただけで符号が変わる、というシミュレーションで
  // 確認済み）。onApproachSide=falseになると最終進入の姿勢固定
  // ロジック全体（_computeHeadingTargetDirWorld、inFinalApproachZone
  // 判定）が無効化され、姿勢目標が一気に「目的地の方角」へ
  // ジャンプする。
  //
  // 対策: ヒステリシス化する。一度「手前側」と判定されたら、
  // alongDistWorldがこのマージンを下回る（＝明確に奥まで通り越す）
  // までは「手前側」の判定を維持する（_computeOnApproachSideWithHysteresis
  // 参照、判定結果はship._dockingOnApproachSideにキャッシュする）。
  DOCKING_APPROACH_SIDE_EXIT_MARGIN: -20.0, // この値(alongDistWorld)を下回って初めて「奥側に出た」と判定する

  // v27: 「オーバーシュートすると最終進入から通常の接近中フェーズへ
  // 戻ってしまい、そのまま目的地の方角へ突っ込むだけで、きちんと
  // 再アプローチ（進入軸まで戻って向き直してから入り直す）してくれ
  // ない」という報告への対応。
  //
  // 従来の挙動: onApproachSide=falseになると、_computeHeadingTargetDirWorld
  // が単純に「目的地の方角」を返すだけだった。これだと目的地の
  // 真後ろ側から突っ込んだ場合、進入軸を無視して目的地へ直進
  // →また逆側へ抜ける、を繰り返しかねない。
  //
  // 対策: 再アプローチ専用のウェイポイントを進入軸の手前側
  // （target.position + approachAxisWorld * REAPPROACH_WAYPOINT_DISTANCE、
  // 通常の入口とほぼ同じ位置）に置き、オーバーシュートを検知した
  // 瞬間からship._dockingReapproachingをtrueにする。この間は
  // 目的地そのものではなくこのウェイポイントへ向けて飛ばすことで、
  // 一旦進入軸の手前まで戻ってから改めて正規の進入コースに乗り
  // 直す（＝ベジエ接近ロジックがまた効くようになる）形にする。
  // ウェイポイントに十分近づき、かつ進入軸に沿う向きまで戻れたら
  // （＝onApproachSideが再びtrueに戻ったら）通常の接近ロジックへ
  // 復帰する。
  //
  // v29: 「再アプローチが最終進入からのオーバーシュート以外
  // （通常接近フェーズでのはみ出しなど）でも発動してしまう」との
  // 報告を受け、発動条件を「直前フレームまで実際に最終進入フェーズ
  // (inFinalApproach)にいた場合に限る」よう
  // _computeOnApproachSideWithHysteresis側で絞った
  // （ship._dockingWasInFinalApproach参照）。それ以外での
  // onApproachSide=false（例: 遠方でのはみ出し）は、従来通り
  // 「目的地の方角」を向く単純なフォールバック(v17)のみで対応する。
  DOCKING_REAPPROACH_WAYPOINT_DISTANCE: 250.0, // 進入軸手前側、目的地からこの距離のウェイポイントへ一旦戻る

  // v30: 「再アプローチを、目的地の方角へ機首を素早く向け直す動きでは
  // なく、飛行機のゴーアラウンドのように進行方向を保ったままヨーだけで
  // 円軌道を描いて反転させたい」という要望への対応。
  //
  // オーバーシュートを検知した瞬間（ship._dockingReapproachingが
  // falseからtrueへ切り替わる瞬間）の艦の位置と水平面（艦のワールド
  // 上方向に垂直な面）内の進行方向から、水平面内の円（旋回円）を
  // 一度だけ構築してship._dockingGoAroundにキャッシュする
  // （_startGoAroundTurn参照）。円の中心は進行方向から見て進入軸
  // （approachAxisWorldの逆方向、＝再アプローチウェイポイント側）に
  // 近い側へ90°の位置に置くことで、旋回が自然に「進入軸の手前側へ
  // 戻ってくる」向きになる。
  //
  // 以後は_computeGoAroundHeadingDirWorldが、艦から見て円周上を
  // DOCKING_BEZIER_LOOKAHEAD_DISTANCE相当だけ先読みした点を姿勢の
  // 目標方向として返す（ベジエの先読み点方式と同じPure Pursuit的な
  // 考え方）。円弧上を半周（180°）進むか、再アプローチウェイポイント
  // に十分近づいたら通常のウェイポイント追従（_computeReapproachWaypointDirWorld）
  // に引き継ぐ（_isGoAroundComplete参照）。
  DOCKING_GO_AROUND_RADIUS: 220.0, // ゴーアラウンド旋回円の半径
  // 円弧に沿った先読み距離。ベジエと同じ値を既定にして曲がり方の
  // 体感速度を揃える。
  DOCKING_GO_AROUND_LOOKAHEAD_DISTANCE: 150.0,
  // 円弧をどこまで辿ったら通常の再アプローチウェイポイント追従へ
  // 引き継ぐか（ラジアン、Math.PIで半周＝180°）。180°より少し手前で
  // 切り上げることで、円弧の終端とウェイポイント方向のなめらかな
  // 接続を確保する。
  DOCKING_GO_AROUND_MAX_ARC: 2.8, // 約160°
  DOCKING_POSITION_FULL_THRUST_DISTANCE: 60.0, // 目的地までの距離がこれ以上でフル推力、未満は比例して弱める
  DOCKING_POSITION_MIN_DISTANCE: 0.15, // これ未満の距離は接近推力を止める（振動防止、あとは速度制動のみで静止させる）
  // v15: 「目的地が10万離れていても速度4で頭打ちになり、主機出力が
  // 0%に張り付く」という報告への対応。
  //
  // 原因: DOCKING_APPROACH_SPEED_FULL_BRAKE（速度ブレーキがフルに
  // なる速度）が距離を一切考慮しない固定値だったため、目的地が
  // どれだけ遠くても「速度がこの値に達したら全力ブレーキ」が働き、
  // 接近力とブレーキ力がほぼ相殺してdesiredForce.zが実質ゼロに
  // なっていた（本来このブレーキは接近末期のオーバーシュート防止用）。
  //
  // 対策: ブレーキの基準速度（この速度でフルブレーキになる）を、
  // 距離に応じて動的に伸縮させる。
  //   - 距離が DOCKING_POSITION_FULL_THRUST_DISTANCE 以内: 従来通り
  //     DOCKING_APPROACH_SPEED_FULL_BRAKE（近接時の基準）に絞る。
  //   - 距離が DOCKING_APPROACH_SPEED_TAPER_DISTANCE 以上: 艦の
  //     maxSpeedまで基準を引き上げる（＝実質ブレーキがかからず
  //     加速し続けられる）。
  //   - その間は距離に応じて線形補間する。
  // これにより「遠方ではフル加速、目的地に近づくにつれ従来通り
  // 穏やかに減速」という自然な挙動になる。
  DOCKING_APPROACH_SPEED_FULL_BRAKE: 4.0, // 目的地付近（近接時）でのオーバーシュート防止用ブレーキが最大になる速度の基準値
  DOCKING_APPROACH_SPEED_TAPER_DISTANCE: 600.0, // この距離以上では速度上限をship.maxSpeedまで緩める（近接時基準からの遷移距離）

  // v17: 「オートドッキングが目的地を通り越しがち」「距離200を
  // 切ったら姿勢を整えてまっすぐ入港してほしい」という要望対応。
  //
  // 最終進入フェーズ: 目的地までの距離がこの値以下になったら、
  //   - 船首の向きを「現在位置→目的地」ではなく「目的地の保存済み
  //     姿勢（State.dockingTarget.quaternion）そのもの」に合わせる。
  //     これにより最終進入軸が固定され、目的地に着くまで機体が
  //     ふらつかず、常に同じ直線上をまっすぐ進入する形になる。
  //   - 横方向（ローカルX/Y）の速度・位置ずれを強めに制動し、
  //     ふらつきを早めに消し込む。
  //   - 前後方向は_computeDockingStoppingDistance()による制動距離
  //     ベースのブレーキに切り替え、「通り越す」オーバーシュートを
  //     防ぐ。
  DOCKING_FINAL_APPROACH_DISTANCE: 200.0,

  // v30: 「最終進入(距離200)に入る前から、目的地そのものではなく
  // 進入軸上の手前側にある仮想ウェイポイントを目指してほしい。
  // 距離200に入る時点で既に位置・姿勢とも進入軸にきっちり乗って
  // いれば、そこから先はほぼ直進(並進スラスターにほぼ頼らない)
  // だけで入港できるはず」という要望への対応。
  //
  // 従来のベジエ接近(_buildApproachBezier)はP3(終点)を常に
  // target.positionそのものに置いていた。曲線終端が本物の目的地に
  // 向かって収束するため、距離200へ近づくにつれ曲線の接線が
  // 「目的地そのものへの直線」に寄っていき、進入軸への収束が
  // 十分な余裕をもって完了しないことがあった。
  //
  // 対策: 通常フェーズ（最終進入に入るまで）の間、姿勢・並進の
  // 両方が目指す先をtarget.positionではなく、進入軸上でtarget.
  // positionからapproachAxisWorldの逆方向へこのDISTANCE分だけ
  // 戻った仮想ウェイポイント（_computeVirtualApproachTarget参照）に
  // 差し替える。艦はこの仮想ウェイポイントに向けてベジエ曲線・
  // 通常接近ロジックを解くため、距離200へ到達する頃には自然と
  // 「進入軸上、姿勢も揃った状態」に収束している。
  //
  // 距離200を切って本物の最終進入フェーズ(inFinalApproach)に入って
  // からは、従来通り_buildFinalApproachForceが本物のtarget.position
  // （toTargetWorldは実距離）を見て直進・制動を行う。
  //
  // v36: 「姿勢だけ揃えて200圏内で停止しても、位置が進入軸から
  // 大きくずれていると最終進入に入れない（＝そのまま入港できない）」
  // という報告への対応。従来はこの値がDOCKING_FINAL_APPROACH_
  // DISTANCE（200）と同じで、仮想ウェイポイント到達＝実距離400
  // 付近というタイミングしか位置合わせの猶予がなかった。
  //
  // v38: 当初はDOCKING_HEADING_BLEND_END_DISTANCEと同じ500に
  // 揃えていたが、これだと実距離500付近で「艦が実際に狙っている
  // 仮想ウェイポイントまでの残り距離」がほぼ0になり、ベジエの
  // ハンドル長・先読み点が潰れて姿勢目標が不安定になる（「距離500で
  // 船の向きがおかしくなる」「何度も500に戻ろうとする」不具合の
  // 原因）。通常フェーズの並進制御は仮想ウェイポイント（＝実距離
  // 500の点）そのものへブレーキ＋接近力をかけ続けるため、そこを
  // 行き過ぎても姿勢が整うまで何度でも押し戻されていた。
  // 対策: DOCKING_HEADING_BLEND_END_DISTANCEを300へ引き下げ、姿勢
  // ブレンドが確定する距離と仮想ウェイポイントの位置(500)をあえて
  // ずらした。実距離500の時点ではまだブレンド中（仮想ウェイポイント
  // までまだ十分距離がある）でベジエが安定し、300で位置・姿勢とも
  // 収束させたあと、300→200の100の区間を回頭の遅れを吸収する猶予に
  // 充てる。
  DOCKING_VIRTUAL_TARGET_OFFSET: 500.0,

  // v20: 「距離200に入った瞬間に姿勢が目的地方向→進入軸方向へ
  // 一気に切り替わり、大きく旋回してしまう」という報告への対応。
  // 従来は距離200を境に姿勢の目標方向を瞬時に切り替えていたが、
  // 進入コースから外れた位置にいるほどこの境界での方向転換が
  // 急になっていた。
  //
  // 対策: この距離（DOCKING_HEADING_BLEND_START_DISTANCE）から
  // DOCKING_HEADING_BLEND_END_DISTANCEに至るまでの間で、
  // 「目的地の方角」から「目的地の進入軸方向」へ姿勢の目標方向を
  // 徐々に線形補間する（_computeHeadingTargetDirWorld参照）。
  // 飛行機の着陸アプローチが遠方から少しずつ機首をファイナル
  // コースへ合わせていくのに似せた形。
  DOCKING_HEADING_BLEND_START_DISTANCE: 800.0,

  // v25: 「進入コースが折れ線的（目的地方向→進入軸方向の線形補間）
  // ではなく、1本の滑らかな曲線をたどるようにしてほしい」という
  // 要望への対応。_computeHeadingTargetDirWorldを、3次ベジエ曲線上の
  // 先読み点（look-ahead point）を追いかけるパスフォロー方式に
  // 置き換えた（_buildApproachBezier / _lookAheadPointOnBezier参照）。
  //
  // 曲線の出口側ハンドル（目的地の手前・進入軸に沿ってどれだけ
  // 手綱を伸ばすか）の長さ。長いほど最終進入軸へ早めに、かつ
  // なだらかに乗る。
  DOCKING_BEZIER_EXIT_HANDLE_LENGTH: 260.0,
  // 曲線上を先読みする距離（艦から見てこの分だけ曲線の先にある点を
  // 姿勢の目標方向にする）。短すぎると曲線への追従が唐突（角ばる）に、
  // 長すぎるとショートカットして曲線から外れがちになる。
  DOCKING_BEZIER_LOOKAHEAD_DISTANCE: 150.0,

  // v37: 「距離500付近でもヨーが反転したまま抜け出せない」という
  // 報告への対応。_buildApproachBezierの始点ハンドル(p1)は艦の
  // 「現在の船首方向」を接線として曲線を作るため、船首が目的地方向と
  // 大きく（特に90°以上）ズレていると、曲線がその乱れた向きへ
  // 一旦伸びてから目的地へ戻る歪な形になり、先読み点が艦の後方・
  // 横に来ることがあった。目標方向（先読み点）が「今向いている方向の
  // 延長線上」になるため、船首が大きくズレているほど収束せず
  // 同じ向きを追認し続ける悪循環（アトラクター）になっていた
  // （_computeHeadingTargetDirWorld参照）。
  //
  // 対策: 船首と目的地方向のなす角がこの閾値(rad)以上の間は、
  // ベジエ曲線を使わず単純に「目的地の方角」（targetDirWorld）へ
  // 向ける（v17以前の単純フォールバックと同じ）。これは循環構造を
  // 持たないため、船首の向きに関わらず必ず目的地方向へ収束する。
  // 角度がこの閾値未満まで小さくなった（＝ある程度目的地方向を
  // 向けた）後で初めてベジエへ切り替え、そこから滑らかに進入軸へ
  // 乗せていく。DOCKING_HEADING_FULL_TORQUE_ANGLE（フルトルクに
  // なる角度、約60°）と同じ値を流用し、「フルトルクで向き直している
  // 間はベジエを使わない」という一貫した基準にする。
  // ヒステリシス（DOCKING_HEADING_BEZIER_ENTER_MARGIN）を設け、
  // 境界付近で単純フォールバック⇔ベジエが毎フレーム切り替わる
  // チャタリングを防ぐ（一度ベジエに入ったら、角度がこのマージン分
  // 余計に開くまではベジエのまま維持する）。
  DOCKING_HEADING_BEZIER_ENTER_ANGLE: 1.05, // 約60°
  DOCKING_HEADING_BEZIER_ENTER_MARGIN: 0.17, // 約10°分のヒステリシス

  // v21: 「距離200(DOCKING_FINAL_APPROACH_DISTANCE)に着く前に
  // 姿勢を回り切っておいて、200以降はほぼ直進だけで入港したい」
  // という要望への対応。
  //
  // 従来はブレンド完了距離＝最終進入距離（どちらも200）だったため、
  // 「目標方向が動き続ける→船の回頭が追いつく前に200へ到達する」
  // というラグが常に発生していた。ブレンドの完了(t=1、目標方向が
  // 進入軸方向で確定する距離)をDOCKING_FINAL_APPROACH_DISTANCEより
  // 手前のここで済ませることで、そこから200に着くまでの区間を
  // 「回頭が実際に追いつくための猶予時間」として使う。
  //
  // v38: 一時DOCKING_VIRTUAL_TARGET_OFFSET（仮想ウェイポイントの
  // オフセット）と同じ500に揃えていたが、実距離500付近で仮想
  // ウェイポイントまでの残り距離が0に近づき、姿勢計算・並進の
  // 接近先が同じ一点に収束してしまい不安定になっていた
  // （DOCKING_VIRTUAL_TARGET_OFFSETのコメント参照）。300へ戻し、
  // 300→200の100の区間を回頭の遅れを吸収する猶予とする。
  DOCKING_HEADING_BLEND_END_DISTANCE: 300.0,

  // 最終進入フェーズ専用のフルトルク角度閾値。通常フェーズ用の
  // DOCKING_HEADING_FULL_TORQUE_ANGLE（約60°、遠方でも主機が
  // 働くよう緩めた値）より厳しくし、「距離200を切ったらまず
  // 姿勢をきっちり合わせる」動きを優先させる（約20°）。
  DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE: 0.35,

  // v21: 距離200(DOCKING_FINAL_APPROACH_DISTANCE)に到達した時点で
  // まだ姿勢誤差がこの角度(rad)を超えていた場合、直進主体の最終
  // 進入フェーズへは入らせず、その場に留まって（前進速度を絞り）
  // 姿勢だけを合わせ切ることを優先する
  // （_isHeadingReadyForFinalApproach参照、約8°）。
  DOCKING_FINAL_APPROACH_HEADING_READY_ANGLE: 0.14,
  // 上記の「その場で姿勢合わせ」中、前進をどこまで絞るか
  // （0=完全停止優先、1=絞らない）。
  // v34: 「最終進入以外は距離200以内に入らせない」方針への変更に伴い、
  // 呼び出し側（headingHold分岐）では常に0を直接渡すようになった
  // ため、この定数自体は現在未使用（値だけ残置）。
  DOCKING_HEADING_HOLD_FORWARD_DAMPING: 0.15,
  // 最終進入フェーズにおける横方向（ローカルX/Y）位置ずれ補正の
  // 比例ゲイン。目的地の直線進入軸からどれだけ横にずれているかに
  // 応じて、そのずれを消す方向の並進力を追加する（姿勢を目的地の
  // 姿勢に固定した結果、位置ずれの補正はもう「船首を目的地に
  // 向ける」トルクでは賄えなくなるため、並進側で明示的に補う）。
  DOCKING_LATERAL_CORRECTION_FULL_THRUST_OFFSET: 15.0, // 横ずれがこれ以上でフル横方向推力
  // v17: 制動距離ベースの接近ブレーキが「まだ制動距離に余裕がある」
  // と判定した際に許容する最大接近速度。ship.maxSpeedそのものだと
  // 最終進入フェーズに入った直後にフル加速してしまいかねないため、
  // 最終進入フェーズ用に別途頭打ちを設ける。
  // v25: 「最終進入が遅すぎる」報告への対応。フルブレーキ/フル前進の
  // ハードスイッチを廃止し常に物理的な安全速度まで詰められるように
  // なったため、巡航速度上限自体も0.5→0.75へ引き上げて体感速度を上げる
  // （安全速度側のクランプがあるので、これを上げても通り越しには
  // つながらない）。
  DOCKING_FINAL_APPROACH_MAX_SPEED_RATIO: 0.75, // ship.maxSpeedに対する比率
  // v25: 目標接近速度＝「残り距離でちょうど止まり切れる速度
  // sqrt(2*maxDecel*remainingDist)」に掛ける安全マージン係数
  // （1.0だと理論値ぎりぎりで、推力配分ソルバーの丸めや1フレーム分の
  // 遅れでわずかにオーバーシュートしうるため少し保守的に絞る）。
  DOCKING_FINAL_APPROACH_BRAKE_MARGIN: 0.85,

  // v28: 「最終進入の逆噴射/主機関の喧嘩(v25)を直したら、今度は
  // 最終進入に入った瞬間フル加速してオーバーシュートするだけに
  // なった」という報告への対応。
  //
  // 原因1: DOCKING_FINAL_APPROACH_MAX_SPEED_RATIO(0.75)をship.maxSpeed
  // （艦種プリセットにより140〜420と幅がある）にそのまま掛けていたため、
  // 距離200時点の巡航速度目標(cruiseSpeed)が艦種によっては100〜300超
  // にもなり得た。distanceベースのphysicalSafeSpeedがこれより小さければ
  // 通常は問題ないが、艦の減速性能(maxDecel)が高いほどphysicalSafeSpeedも
  // 大きく出るため、結果的に「距離200からの目標接近速度」自体が
  // 実際に安全に減速し切れる値より過大になりがちだった。
  // 対策: 距離ベースの上限とは別に、最終進入時の巡航速度に絶対値の
  // 上限を設ける（下記DOCKING_FINAL_APPROACH_MAX_SPEED_ABS）。
  //
  // 原因2（本命）: 目標接近速度との誤差(speedError)を推力へ変換する
  // 基準がFORWARD_VELOCITY_FULL_THROTTLE_ERROR(固定40)だった。これは
  // 手動操縦のスロットル追従用に決めた値で艦の性能を一切考慮しない
  // ため、上記のcruiseSpeedが100を超えるような艦では最終進入に入った
  // 瞬間のspeedErrorが軽く40を超え、即座にthrustStrength=1(フル主機関)
  // になっていた。フル加速で溜めた速度は同じ基準でしかブレーキも
  // かからず、結局止まり切れずオーバーシュートする、という2段階の
  // 不具合だった。
  // 対策: 最終進入専用のスロットル基準を、艦の実際の最大減速度
  // (maxDecel)から動的に算出する（_computeFinalApproachThrottleErrorRef
  // 参照）。減速力が強い艦ほど基準を大きく（＝多少速度差があっても
  // 緩やかに埋める）、弱い艦ほど基準を小さく（＝早めにフル出力へ
  // 入って足りない制動力を補う）取ることで、「フル加速一択」を防ぐ。
  DOCKING_FINAL_APPROACH_MAX_SPEED_ABS: 60.0, // 最終進入(距離200以下)の巡航速度自体の絶対上限（艦種によらず一律）
  // 基準となる減速度(m/s^2)。この減速度の艦であればFORWARD_VELOCITY_
  // FULL_THROTTLE_ERROR(40)相当のスロットル基準を使う、という
  // スケーリングの原点。艦の実際のmaxDecelがこれより大きければ
  // 基準を比例して緩め（速度差に寛容に）、小さければ厳しくする。
  DOCKING_FINAL_APPROACH_THROTTLE_REF_DECEL: 8.0,
  // スロットル基準のスケール自体を安全のためこの範囲にクランプする
  // （減速力が極端に強い/弱い艦でも暴れないようにする）。
  DOCKING_FINAL_APPROACH_THROTTLE_REF_MIN: 10.0,
  DOCKING_FINAL_APPROACH_THROTTLE_REF_MAX: 40.0,

  // v28: 上記のスロットル基準スケーリングだけでは根本原因を解決
  // できなかった。詳細な検証の結果判明した本当の原因は以下の通り。
  //
  // targetSpeed = min(cruiseSpeed, sqrt(2*maxDecel*remainingDist*margin))
  // という「残り距離が減るほど目標速度も連続的に絞る」設計(v25)では、
  // remainingDistが0に近づくとtargetSpeedも0に張り付く。すると
  // speedError(=targetSpeed - closingSpeed)が「現在速度の符号を反転
  // させただけの小さな値」になり、比例制御thrustStrength=speedError/refも
  // 比例して小さくなる。つまり本来「今すぐ全力で止まらないと間に合わない」
  // 場面であっても、目標速度側の絞り込みが先に効いてしまい、ブレーキが
  // 速度なりに弱まっていって制動距離の物理的保証（sqrt(2ad)の前提である
  // 「常に最大減速度でブレーキする」）が崩れ、間に合わずに通り越して
  // いた。v25のコメントにある「フルブレーキ分岐は不要になる」という
  // 想定が誤りだった。
  //
  // 対策: 速度超過側（speedError<0）に限り、比例制御とは別に
  // 「実際にこのまま等加速度maxDecelでブレーキした場合の制動距離
  // (stoppingDistance = closingSpeed^2 / (2*maxDecel*margin))」と
  // 「残り距離」を比較した緊急度(urgency)を計算し、
  //   urgency <= URGENCY_BLEND_START: 従来通りの弱い比例ブレーキのまま
  //   urgency >= URGENCY_BLEND_FULL : ほぼフルブレーキ(-1)
  //   その間は線形にブレンド
  // とする。urgencyは連続量なので、緊急度が低いうちは滑らかな比例
  // 制御のまま、間に合わなくなりそうになるにつれ滑らかにフルブレーキへ
  // 寄っていき、v25が警戒していた「閾値をまたいだ瞬間に1↔-1が
  // 交互に切り替わる」不連続は起きない（シミュレーションで、
  // フル加速からフルブレーキへ1.00→0.95→0.73→...→0.05→-1.00と
  // 連続的に推移し、その後止まり切るまでオーバーシュートしない
  // ことを確認済み）。
  DOCKING_FINAL_APPROACH_URGENCY_BLEND_START: 0.5, // 制動距離/残り距離がこの比率を超えたらブレーキ強化を開始
  DOCKING_FINAL_APPROACH_URGENCY_BLEND_FULL: 0.9, // この比率でほぼフルブレーキ(-1)に達する

  // v20: 「旋回で生じた横滑りの勢いを殺しきれず目的地を通り過ぎて
  // しまう」不具合対策（勢い殺しモード、_updateMomentumKillState参照）。
  MOMENTUM_KILL_MIN_LATERAL_SPEED: 2.0, // これ未満の横滑り速度は無視し、通常のRCS制動任せにする
  // v21: 「勢いキル→抜けた直後に接近力で再加速→また勢いキル」を
  // 繰り返してしまう報告への対応。
  //
  // 原因は2つあった:
  //   1) 退出マージンが緩く(0.5)、横滑りが半分程度収まっただけで
  //      通常フェーズへ戻っていた（＝まだ結構な横滑りが残っている
  //      状態で接近力が復帰し、それがまた横滑りを生む）。
  //   2) 通常フェーズに戻った瞬間、approachStrength（接近力）が
  //      距離だけで決まり全開に近い値へ即復帰していたため、
  //      「勢いキルで横滑りを削った意味」がすぐ再加速で相殺されて
  //      いた。
  //
  // 対策:
  //   1) 退出マージンを大幅に厳しくし(0.5→0.15)、横滑りがほぼ
  //      収まりきってから通常制御へ戻す。
  //   2) 退出直後はMOMENTUM_KILL_COOLDOWN_SECにわたり接近力を
  //      徐々にしか復帰させない（_momentumKillCooldownRemainingで
  //      管理、_buildDesiredForAutoDocking内でapproachStrengthに
  //      乗算する）。この間もRCSによる速度ブレーキ自体は普段通り
  //      効くので「できるだけ普通のRCSで減速する」という狙いに沿う。
  MOMENTUM_KILL_EXIT_MARGIN: 0.15, // 退出判定の余裕係数（制動距離が残り距離のこの倍率を下回るまで維持、チャタリング防止）
  MOMENTUM_KILL_COOLDOWN_SEC: 2.5, // 勢いキル退出直後、接近力をゆっくり戻すまでの時間(秒)

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

  // -----------------------------------------------------------
  // v08: 自動操船（入港）モード用の欲求力/トルクを組み立てる。
  //
  // 姿勢:
  //   船首（ローカル-Z軸）を「現在位置から目的地座標への方向」に
  //   常に向けるよう、pitch/yaw軸のトルクを自動生成する
  //   （目的地の"姿勢角"そのものに機体を合わせるのではなく、
  //   目的地の"方角"を向かせる一般的なオートパイロット方式）。
  //   roll軸は自動制御の対象外とし、ユーザーのrotateRoll入力を
  //   そのまま使う（要望通り、ロールだけ手動操作を受け付ける）。
  //
  //   角速度打ち消し（ダンピング）は自動操船中も常時有効にする
  //   （手を離した瞬間に船首が目的方向で止まってくれないと
  //   「常に目的地に向ける」が成立しないため、自動姿勢制動の
  //   ON/OFF設定とは独立に適用する）。
  //
  // 並進:
  //   目的地座標までのワールド方向ベクトルをローカル座標へ変換し、
  //   距離に応じた比例制御で「近づく」推力を生成した上で、
  //   目的地付近では現在の速度を打ち消すブレーキも加える
  //   （距離0・速度0の両方に収束させることで「その場に留まる」
  //   自動制御を維持する）。
  //   ユーザーの手動並進入力（thrustStrafeX/Y）はロールと同様に
  //   「自動制御力への上乗せ」として加算する。
  //
  //   v09: thrustForward（メインエンジンのスロットルレバー）は
  //   自動操船中は完全に無視する。以前はストレイフと同列に
  //   「自動制御力への上乗せ」として加算していたが、これだと
  //   レバーがニュートラル(0)以外の位置にあるだけでオートパイロットの
  //   接近/静止用の前後推力が意図せず歪められてしまい、「自動操縦中は
  //   メインエンジンもレバーを無視して自動で出力してほしい」という
  //   要望に反していた。ストレイフ・ロールは姿勢や横移動の微調整として
  //   残す一方、前後（メインエンジンが主に担う軸）は自動操船ロジックの
  //   接近距離・速度ブレーキ計算だけに委ねる。
  // -----------------------------------------------------------

  // -----------------------------------------------------------
  // v20: 「勢い殺しモード」の判定・状態更新。
  //
  // 目的地方向(targetDirWorld)から見て直交する速度成分（横滑り）を
  // 求め、それをRCS（_estimateMaxLateralDecel、非力）だけで打ち消す
  // 場合の制動距離（v^2/(2a)）を計算する。この制動距離が目的地までの
  // 残り距離を超えていたら「このままではRCSだけで横滑りを消しきれず
  // 通り過ぎてしまう」と判断し、勢い殺しモードへ入る。
  //
  // 一度入ったら、退出条件には余裕(MOMENTUM_KILL_EXIT_MARGIN)を
  // 持たせる。境界ぎりぎりで毎フレーム条件が反転するとON/OFFが
  // 高速に切り替わり姿勢が暴れる（チャタリング）ため、「まだ十分安全と
  // 言えるところまで横滑りが収まる」まで維持してから通常の
  // 目的地/進入軸への姿勢制御に戻す。
  //
  // 状態はship._momentumKillActiveにキャッシュする（06-hud.jsの
  // デバッグ表示からも参照する）。
  // -----------------------------------------------------------
  _updateMomentumKillState(ship, distance, targetDirWorld, dt) {
    const wasActive = ship._momentumKillActive === true;

    if (!targetDirWorld || distance <= 1e-4) {
      if (wasActive) this._startMomentumKillCooldown(ship);
      ship._momentumKillActive = false;
      return false;
    }

    const velWorld = ship.velocity;
    const alongSpeed = vecDot(velWorld, targetDirWorld);
    const alongVelWorld = vecScale(targetDirWorld, alongSpeed);
    const lateralVelWorld = {
      x: velWorld.x - alongVelWorld.x,
      y: velWorld.y - alongVelWorld.y,
      z: velWorld.z - alongVelWorld.z,
    };
    const lateralSpeed = vecLength(lateralVelWorld);

    if (lateralSpeed < this.MOMENTUM_KILL_MIN_LATERAL_SPEED) {
      if (wasActive) this._startMomentumKillCooldown(ship);
      ship._momentumKillActive = false;
      return false;
    }

    const maxLateralDecel = this._estimateMaxLateralDecel(ship);
    const lateralStoppingDistance = (lateralSpeed * lateralSpeed) / (2 * maxLateralDecel);

    const active = wasActive
      ? lateralStoppingDistance > distance * this.MOMENTUM_KILL_EXIT_MARGIN
      : lateralStoppingDistance > distance;

    if (wasActive && !active) this._startMomentumKillCooldown(ship);
    ship._momentumKillActive = active;
    return active;
  },

  // v21: 勢いキルモードを退出した瞬間に呼び、クールダウンタイマーを
  // セットする。以後MOMENTUM_KILL_COOLDOWN_SEC秒かけて接近力の
  // 上限を0→1へ線形に戻す（_getApproachCooldownMultiplier参照）。
  _startMomentumKillCooldown(ship) {
    ship._momentumKillCooldownRemaining = this.MOMENTUM_KILL_COOLDOWN_SEC;
  },

  // v21: 現在の接近力上限倍率(0..1)を返す。クールダウン中でなければ
  // 常に1。dtを渡した場合はタイマーを1フレーム分消費させる。
  _tickApproachCooldownMultiplier(ship, dt) {
    const remaining = ship._momentumKillCooldownRemaining || 0;
    if (remaining <= 0) return 1;
    const next = Math.max(0, remaining - (dt || 0));
    ship._momentumKillCooldownRemaining = next;
    // 残り時間からそのまま比率を出すのではなく、経過側（1 - 残り/合計）を
    // 使うことで「タイマーをセットした瞬間は0、満了で1」という
    // 直感通りの向きにする。
    const elapsedRatio = 1 - next / this.MOMENTUM_KILL_COOLDOWN_SEC;
    return clamp(elapsedRatio, 0, 1);
  },

  // -----------------------------------------------------------
  // v20: 通常フェーズ（勢い殺しモードでも最終進入フェーズでもない間）の
  // 姿勢目標方向を求める。
  //
  //   - 進入軸の手前側にいない場合（艦が目的地を通り越して奥に
  //     出てしまっている場合）は、従来通り「目的地の方角」を
  //     そのまま返す（ブレンドしない）。この場合にブレンドすると
  //     船首が進入軸方向に固定されたまま目的地から離れ続ける
  //     不具合（v17コメント参照）が再発するため。
  //   - それ以外は、DOCKING_HEADING_BLEND_START_DISTANCEから
  //     DOCKING_HEADING_BLEND_END_DISTANCEまでの間で「目的地の方角」から
  //     「進入軸方向」へ線形補間する。距離がDOCKING_HEADING_
  //     BLEND_START_DISTANCE以上ならt=0（純粋に目的地の方角）、
  //     DOCKING_HEADING_BLEND_END_DISTANCE以下ならt=1（純粋に進入軸方向）
  //     になる。v21よりEND_DISTANCE(v38現在300)はFINAL_APPROACH_
  //     DISTANCE(200)より手前に設定してあり、200へ着くまでの残り
  //     区間を実際の船体の回頭が目標に追いつくための猶予時間として
  //     使う。
  // -----------------------------------------------------------
  // v25: 艦の現在位置(ship.position)・現在の船首方向(ship.quaternionの-Z)・
  // 目的地位置(target.position)・目的地の進入軸(approachAxisWorld)から
  // 3次ベジエ曲線を構築する。
  //   P0 = 艦の現在位置（曲線の始点）
  //   P1 = P0から艦の現在の船首方向へ少し進めた点（始点側ハンドル。
  //        「今向いている方向へ滑らかに離陸する」接線を保証する）
  //   P2 = 目的地からapproachAxisWorldの逆方向（入口側、ゲートの
  //        手前）へDOCKING_BEZIER_EXIT_HANDLE_LENGTH分戻した点
  //        （終点側ハンドル。曲線の終端付近が自然と進入軸に沿う）
  //   P3 = 目的地位置（終点）
  // ハンドル長P0-P1はP0-P3間の距離に応じてスケールし、近距離では
  // 曲線が暴れないようにする。
  _buildApproachBezier(ship, target, approachAxisWorld, distance) {
    const noseWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion));
    const p0 = { x: ship.position.x, y: ship.position.y, z: ship.position.z };
    const p3 = { x: target.position.x, y: target.position.y, z: target.position.z };

    // 始点ハンドル長: 距離の1/3程度（極端に短い/長いを避けるため
    // exit handleとも同程度の範囲にクランプ）。
    const startHandleLen = clamp(distance / 3, 20, this.DOCKING_BEZIER_EXIT_HANDLE_LENGTH * 1.5);
    const p1 = {
      x: p0.x + noseWorld.x * startHandleLen,
      y: p0.y + noseWorld.y * startHandleLen,
      z: p0.z + noseWorld.z * startHandleLen,
    };

    const exitHandleLen = Math.min(this.DOCKING_BEZIER_EXIT_HANDLE_LENGTH, distance * 0.8);
    const p2 = {
      x: p3.x - approachAxisWorld.x * exitHandleLen,
      y: p3.y - approachAxisWorld.y * exitHandleLen,
      z: p3.z - approachAxisWorld.z * exitHandleLen,
    };

    return { p0, p1, p2, p3 };
  },

  // 3次ベジエ曲線上の点をパラメータt(0..1)で評価する
  _evalBezier(bezier, t) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * bezier.p0.x + b * bezier.p1.x + c * bezier.p2.x + d * bezier.p3.x,
      y: a * bezier.p0.y + b * bezier.p1.y + c * bezier.p2.y + d * bezier.p3.y,
      z: a * bezier.p0.z + b * bezier.p1.z + c * bezier.p2.z + d * bezier.p3.z,
    };
  },

  // 曲線をNセグメントの折れ線として近似し、艦の現在位置から
  // DOCKING_BEZIER_LOOKAHEAD_DISTANCEだけ曲線に沿って先にある点を
  // 返す（Pure Pursuit的な先読み点探索）。艦は常にP0上にいるので、
  // 弧長はP0からの累積距離をそのまま積算すればよい。
  _lookAheadPointOnBezier(bezier, lookAheadDistance) {
    const SEGMENTS = 24;
    let prev = bezier.p0;
    let accumulated = 0;
    for (let i = 1; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const point = this._evalBezier(bezier, t);
      const segLen = vecLength({
        x: point.x - prev.x,
        y: point.y - prev.y,
        z: point.z - prev.z,
      });
      if (accumulated + segLen >= lookAheadDistance) {
        // このセグメント内で先読み距離に到達する。セグメント内を
        // 線形補間して近似点を返す（曲率に対して十分細かい分割数
        // なので線形近似で問題ない）。
        const remain = lookAheadDistance - accumulated;
        const segT = segLen > 1e-6 ? remain / segLen : 0;
        return {
          x: prev.x + (point.x - prev.x) * segT,
          y: prev.y + (point.y - prev.y) * segT,
          z: prev.z + (point.z - prev.z) * segT,
        };
      }
      accumulated += segLen;
      prev = point;
    }
    // 曲線全長が先読み距離に満たない（＝目的地がかなり近い）場合は
    // 終点（目的地そのもの）を返す。
    return bezier.p3;
  },

  // -----------------------------------------------------------
  // v25: 通常フェーズ（勢い殺しモードでも最終進入フェーズでもない間）の
  // 姿勢目標方向を求める。
  //
  // 旧実装（v20〜v24）は「目的地の方角」から「進入軸方向」への単純な
  // 方向ベクトルの線形補間で、艦の実際の軌跡は考慮していなかった。
  // これは2本の直線区間を繋いだ折れ線に近い経路になり、「1本の
  // 滑らかな線をたどってほしい」という要望に対して曲がり角が
  // 目立っていた。
  //
  // 新実装: 艦の現在位置・現在の船首方向・目的地・目的地の進入軸から
  // 3次ベジエ曲線を毎フレーム再構築し、その曲線上の少し先（先読み点）
  // を目標方向にする（_buildApproachBezier / _lookAheadPointOnBezier）。
  // 艦が動くたびに曲線の始点・接線も追従して再計算されるので、
  // 見た目には「目的地までなめらかに湾曲する1本の軌道」を辿りながら、
  // 終端では自然に進入軸へ収束する。
  //   - 進入軸の手前側にいない場合（艦が目的地を通り越して奥に
  //     出てしまっている場合）は、従来通り「目的地の方角」を
  //     そのまま返す（曲線を組まない）。この場合に曲線追従すると
  //     船首が進入軸方向に固定されたまま目的地から離れ続ける
  //     不具合（v17コメント参照）が再発するため。
  // -----------------------------------------------------------
  // -----------------------------------------------------------
  // v27: 再アプローチウェイポイント（進入軸の手前側、目的地から
  // approachAxisWorld方向へDOCKING_REAPPROACH_WAYPOINT_DISTANCE分
  // 戻った位置）から見た「艦からウェイポイントへの単位方向ベクトル」
  // を返す。姿勢側（_computeHeadingTargetDirWorld）・並進側
  // （_buildDesiredForAutoDockingの並進ブロック）の両方から
  // 同じウェイポイント座標を参照させることで、向く方向と実際に
  // 進む方向を一致させる。
  // -----------------------------------------------------------
  // v28: 符号バグ修正。approachAxisWorldは「目的地の船首方向
  // （target.quaternionの-Z）」＝艦が最終進入で目的地へ向けて
  // 進む向きそのものである。艦が進入軸の手前側（正常な進入口側、
  // alongDistWorld>0）にいる時、艦の位置は
  // target.position - approachAxisWorld * distance
  // （＝進入軸の逆方向に離れた側）にある。したがって「進入軸の
  // 手前側に戻る」ウェイポイントも同じ符号（マイナス）で置く
  // 必要がある。
  //
  // 旧実装はtarget.position + approachAxisWorld * DISTANCEと
  // 符号を誤っており、これは手前側ではなく艦が通り越して出て
  // しまう奥側（進入軸のさらに先）にウェイポイントを置いていた。
  // このため艦が奥側に出た瞬間、再アプローチ先も同じ奥側（より
  // 遠く）に生成され、alongDistWorldが0以上（＝手前側）に戻る
  // 条件を満たせないまま船首だけがそちらを向き続け、実質的に
  // 「軸に戻ろうとして進めなくなる」不具合になっていた。
  // v30: 進入軸上、target.positionからapproachAxisWorldの逆方向へ
  // distance分だけ戻った点を返す汎用ヘルパー。再アプローチ
  // ウェイポイント（_computeReapproachWaypoint）と仮想ウェイポイント
  // （_computeVirtualApproachTarget）は「戻す距離」が違うだけで
  // 計算式は同一なので、ここに共通化する。
  _computeAxisOffsetPoint(target, approachAxisWorld, distance) {
    return {
      x: target.position.x - approachAxisWorld.x * distance,
      y: target.position.y - approachAxisWorld.y * distance,
      z: target.position.z - approachAxisWorld.z * distance,
    };
  },

  _computeReapproachWaypoint(target, approachAxisWorld) {
    return this._computeAxisOffsetPoint(
      target,
      approachAxisWorld,
      this.DOCKING_REAPPROACH_WAYPOINT_DISTANCE
    );
  },

  // v30: 通常フェーズ（最終進入に入るまで）が姿勢・並進の両方で
  // 実際に目指す先。進入軸上、target.positionの手前
  // DOCKING_VIRTUAL_TARGET_OFFSET分の位置に置く
  // （DOCKING_VIRTUAL_TARGET_OFFSET定数のコメント参照）。
  //
  // v39: 「実距離500付近で何度も押し戻される」不具合への対応。
  // 従来はオフセットを常にDOCKING_VIRTUAL_TARGET_OFFSET固定で
  // 使っていたため、この仮想ウェイポイントはtarget.positionから
  // 常に500手前の「空間上の固定点」だった。艦が(進入軸沿いに見て)
  // その固定点を一度通り過ぎると、点は艦から見て後方に来てしまい、
  // 並進側の接近方向(approachDirLocal)が後ろ向きに反転、艦を
  // その固定点（＝実距離500の場所）へ押し戻し続けていた。
  // 対策: オフセットの上限をalongDistWorld（艦から見た、進入軸に
  // 沿った目的地までの残り距離）でクランプする。艦が近づいて
  // alongDistWorldがDOCKING_VIRTUAL_TARGET_OFFSETを下回ったら、
  // 仮想ウェイポイントのオフセットもそれに合わせて縮め、常に
  // 「艦の現在位置とtarget.positionの間」に留める。これにより
  // 仮想ウェイポイントが艦の後方へ回り込むことがなくなり、
  // 距離が縮むにつれて滑らかに本物のtarget.positionへ収束する。
  _computeVirtualApproachTarget(target, approachAxisWorld, alongDistWorld) {
    const offset = clamp(alongDistWorld, 0, this.DOCKING_VIRTUAL_TARGET_OFFSET);
    return this._computeAxisOffsetPoint(target, approachAxisWorld, offset);
  },

  // -----------------------------------------------------------
  // v30: ゴーアラウンド旋回円を、オーバーシュート検知フレームの
  // 艦の位置・進行方向から一度だけ構築する。
  //
  //   平面: ワールド上方向{0,1,0}を法線とする水平面（＝ヨー旋回、
  //         pitch/rollは巻き込まない）。艦の進行方向をこの平面へ
  //         投影して旋回開始方向とする。
  //   中心: 進行方向に対して垂直な2方向のうち、「再アプローチ
  //         ウェイポイント（進入軸手前側）に近い側」を選び、艦の
  //         現在位置からDOCKING_GO_AROUND_RADIUS分だけそちらへ
  //         離れた点を中心にする。これにより、円の向こう半周が
  //         自然と進入軸の手前側を向く。
  //   回転方向: 中心を選んだ側と逆回り（艦から見て中心へ向く方向を
  //         軸に、進行方向から中心方向へ回る向き）に旋回すれば、
  //         進行方向を保ったまま滑らかに弧を描ける。
  //
  // 速度がほぼゼロ（静止に近い）場合は進行方向の代わりに艦の船首
  // 方向を使う。
  // -----------------------------------------------------------
  _startGoAroundTurn(ship) {
    const target = State.dockingTarget;
    if (!target) {
      ship._dockingGoAround = null;
      return;
    }
    const upWorld = { x: 0, y: 1, z: 0 };
    const speed = vecLength(ship.velocity);
    const rawHeading =
      speed > 1e-3
        ? vecScale(ship.velocity, 1 / speed)
        : vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion));

    // 進行方向を水平面へ投影（上下成分を捨てて水平のヨー旋回にする）
    const headingUpComp = vecDot(rawHeading, upWorld);
    const headingFlat = {
      x: rawHeading.x - upWorld.x * headingUpComp,
      y: rawHeading.y - upWorld.y * headingUpComp,
      z: rawHeading.z - upWorld.z * headingUpComp,
    };
    const headingFlatLen = vecLength(headingFlat);
    const headingDirWorld =
      headingFlatLen > 1e-6 ? vecScale(headingFlat, 1 / headingFlatLen) : { x: 0, y: 0, z: -1 };

    // 進行方向に直交する水平方向（右手系: up × heading）
    const rightWorld = vecNormalize(vecCross(upWorld, headingDirWorld));

    // 再アプローチウェイポイント（進入軸手前側）が、艦から見て
    // rightWorld側・-rightWorld側のどちらに近いかで中心側を選ぶ。
    const approachAxisWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    const waypoint = this._computeReapproachWaypoint(target, approachAxisWorld);
    const toWaypoint = {
      x: waypoint.x - ship.position.x,
      y: waypoint.y - ship.position.y,
      z: waypoint.z - ship.position.z,
    };
    const sideSign = vecDot(toWaypoint, rightWorld) >= 0 ? 1 : -1;

    const centerDirWorld = vecScale(rightWorld, sideSign);
    const center = {
      x: ship.position.x + centerDirWorld.x * this.DOCKING_GO_AROUND_RADIUS,
      y: ship.position.y + centerDirWorld.y * this.DOCKING_GO_AROUND_RADIUS,
      z: ship.position.z + centerDirWorld.z * this.DOCKING_GO_AROUND_RADIUS,
    };

    ship._dockingGoAround = {
      center,
      radius: this.DOCKING_GO_AROUND_RADIUS,
      // 円周上の「現在位置から中心への方向」の逆（＝艦から見た
      // 中心からの外向き方向）を角度0の基準にする。
      startOutward: vecScale(centerDirWorld, -1),
      // sideSign>0（中心が艦の右側）なら艦は中心の周りを反時計回り
      // （up軸から見て）に進む必要がある。詳細はコメント参照。
      sideSign,
      arcTraveled: 0,
    };
  },

  // ゴーアラウンド円弧上を、現在の弧長位置からlookAheadDistanceだけ
  // 進んだ点の座標を返す。円周上を移動するのでarcTraveled（既に
  // 辿った弧長）を角度に変換して回転させるだけでよい。
  _lookAheadPointOnGoAround(goAround, lookAheadDistance) {
    const totalAngle = goAround.arcTraveled / goAround.radius +
      lookAheadDistance / goAround.radius;
    // sideSign>0: 中心が右側 → 艦は中心から見て時計回りに外向きベクトル
    // を回転させる必要がある（進行方向が常に外向きベクトルの90°
    // 進行方向側になるように）。ロドリゲスの回転公式をup軸周りで使う。
    const upWorld = { x: 0, y: 1, z: 0 };
    const angle = -goAround.sideSign * totalAngle;
    const rotated = this._rotateAroundAxis(goAround.startOutward, upWorld, angle);
    return {
      x: goAround.center.x + rotated.x * goAround.radius,
      y: goAround.center.y + rotated.y * goAround.radius,
      z: goAround.center.z + rotated.z * goAround.radius,
    };
  },

  // 単位ベクトルaxisの周りにvecをangle(rad)だけ回転させる
  // （ロドリゲスの回転公式）。
  _rotateAroundAxis(vec, axis, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dot = vecDot(vec, axis);
    const cross = vecCross(axis, vec);
    return {
      x: vec.x * cos + cross.x * sin + axis.x * dot * (1 - cos),
      y: vec.y * cos + cross.y * sin + axis.y * dot * (1 - cos),
      z: vec.z * cos + cross.z * sin + axis.z * dot * (1 - cos),
    };
  },

  // v30: ゴーアラウンド中の姿勢目標方向。円弧上の先読み点（艦から
  // DOCKING_GO_AROUND_LOOKAHEAD_DISTANCEだけ先）を目指す。毎フレーム
  // 艦が実際に進んだ弧長をarcTraveledに積算し、円弧の総辿破角が
  // DOCKING_GO_AROUND_MAX_ARCへ達したら（＝ほぼ半周した）呼び出し側で
  // 通常の再アプローチウェイポイント追従へ引き継ぐ
  // （_isGoAroundComplete参照）。
  _computeGoAroundHeadingDirWorld(ship, goAround, dt) {
    // 艦の実際の速度（水平成分の速さ）を弧長の進み具合として積算する。
    // 停止に近い場合は円弧上を進まない（その場で頭だけ振らせない）。
    const speed = vecLength(ship.velocity);
    if (speed > 1e-3 && dt) {
      goAround.arcTraveled += speed * dt;
    }
    const lookAheadPoint = this._lookAheadPointOnGoAround(
      goAround,
      this.DOCKING_GO_AROUND_LOOKAHEAD_DISTANCE
    );
    const dir = {
      x: lookAheadPoint.x - ship.position.x,
      y: lookAheadPoint.y - ship.position.y,
      z: lookAheadPoint.z - ship.position.z,
    };
    const dirLen = vecLength(dir);
    return dirLen > 1e-6 ? vecScale(dir, 1 / dirLen) : null;
  },

  // 円弧の辿破角がDOCKING_GO_AROUND_MAX_ARCへ達したかどうか。
  _isGoAroundComplete(goAround) {
    if (!goAround) return true;
    const angleTraveled = goAround.arcTraveled / goAround.radius;
    return angleTraveled >= this.DOCKING_GO_AROUND_MAX_ARC;
  },

  _computeReapproachWaypointDirWorld(ship, target, approachAxisWorld) {
    const waypoint = this._computeReapproachWaypoint(target, approachAxisWorld);
    const dir = {
      x: waypoint.x - ship.position.x,
      y: waypoint.y - ship.position.y,
      z: waypoint.z - ship.position.z,
    };
    const dirLen = vecLength(dir);
    return dirLen > 1e-6 ? vecScale(dir, 1 / dirLen) : null;
  },

  _computeHeadingTargetDirWorld(ship, target, targetDirWorld, approachAxisWorld, distance, onApproachSide, dt) {
    if (!onApproachSide) {
      // v29: 「進入軸の手前側にいない(onApproachSide=false)」状態には
      // 2種類ある。(1)最終進入フェーズから実際にオーバーシュートした
      // 場合（ship._dockingReapproaching=true）と、(2)それ以外
      // （通常接近フェーズでたまたま進入軸をまたいで奥に出てしまった
      // 場合など、最終進入を一度も経験していない）。
      // 前者だけ再アプローチへ向け、後者は従来通り
      // 「目的地の方角」に向く単純なフォールバック(v17)のままにする
      // （再アプローチは"最終進入からのオーバーシュート"時専用の
      // 挙動にしたいという要望への対応。_computeOnApproachSideWithHysteresis
      // 側でship._dockingReapproachingの発動条件自体を絞っている）。
      //
      // v30: 再アプローチ中は、まず「ゴーアラウンド」（進行方向を
      // 保ったままヨーだけで円弧を描いて反転する、飛行機の
      // ゴーアラウンドのような動き）を優先する。円弧をひとしきり
      // （DOCKING_GO_AROUND_MAX_ARC分）辿り終えたら
      // （_isGoAroundComplete）、従来通りの再アプローチウェイポイント
      // への直線追従に引き継ぎ、進入軸手前側へ実際に戻ってこさせる。
      if (ship._dockingReapproaching) {
        if (!this._isGoAroundComplete(ship._dockingGoAround)) {
          const goAroundDirWorld = this._computeGoAroundHeadingDirWorld(ship, ship._dockingGoAround, dt);
          if (goAroundDirWorld) return goAroundDirWorld;
        }
        const waypointDirWorld = this._computeReapproachWaypointDirWorld(ship, target, approachAxisWorld);
        return waypointDirWorld || targetDirWorld;
      }
      return targetDirWorld;
    }
    if (distance <= 1e-4) return approachAxisWorld;

    // v37: 船首と目的地方向のなす角を見て、大きくズレている間は
    // ベジエ（循環構造を持つため大きくズレた船首では収束しない）を
    // 使わず、単純な「目的地の方角」へのフォールバックにする。
    // ヒステリシス付きでship._dockingUsingBezierに現在の状態を
    // キャッシュする（フレームをまたいだ状態保持）。
    const noseWorldForBezierCheck = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion));
    const headingAngleToTarget = Math.acos(clamp(vecDot(noseWorldForBezierCheck, targetDirWorld), -1, 1));
    const wasUsingBezier = ship._dockingUsingBezier === true;
    const enterAngle = this.DOCKING_HEADING_BEZIER_ENTER_ANGLE;
    const exitAngle = enterAngle + this.DOCKING_HEADING_BEZIER_ENTER_MARGIN;
    const useBezier = wasUsingBezier
      ? headingAngleToTarget < exitAngle
      : headingAngleToTarget < enterAngle;
    ship._dockingUsingBezier = useBezier;

    if (!useBezier) {
      return targetDirWorld;
    }

    const bezier = this._buildApproachBezier(ship, target, approachAxisWorld, distance);
    const lookAheadDist = Math.min(this.DOCKING_BEZIER_LOOKAHEAD_DISTANCE, distance);
    const lookAheadPoint = this._lookAheadPointOnBezier(bezier, lookAheadDist);

    const dir = {
      x: lookAheadPoint.x - ship.position.x,
      y: lookAheadPoint.y - ship.position.y,
      z: lookAheadPoint.z - ship.position.z,
    };
    const dirLen = vecLength(dir);
    return dirLen > 1e-6 ? vecScale(dir, 1 / dirLen) : targetDirWorld;
  },

  // -----------------------------------------------------------
  // v21: フルトルクになる角度閾値を、距離800(DOCKING_HEADING_
  // BLEND_START_DISTANCE)から距離300(DOCKING_HEADING_BLEND_END_DISTANCE、
  // v38時点)の間で「緩め(DOCKING_HEADING_FULL_TORQUE_ANGLE, 約60°)」
  // から「厳しめ(DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE, 約20°)」へ
  // 線形補間する。_computeHeadingTargetDirWorldの目標方向ブレンドと
  // 同じ区間・同じtを使うことで、「距離800からアプローチと同時に
  // 少しずつ回頭を強めながら姿勢を整えていく」という一貫した
  // 挙動になる。300以降は常にDOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE
  // （厳しめ・小さい誤差でもフルトルク）のままなので、300→200の
  // 猶予区間でしっかり回頭を追いつかせられる。
  // -----------------------------------------------------------
  _computeHeadingFullTorqueAngle(distance) {
    const blendRange = Math.max(
      1e-6,
      this.DOCKING_HEADING_BLEND_START_DISTANCE - this.DOCKING_HEADING_BLEND_END_DISTANCE
    );
    const t = clamp(
      (this.DOCKING_HEADING_BLEND_START_DISTANCE - distance) / blendRange,
      0,
      1
    );
    return (
      this.DOCKING_HEADING_FULL_TORQUE_ANGLE +
      (this.DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE - this.DOCKING_HEADING_FULL_TORQUE_ANGLE) * t
    );
  },

  // -----------------------------------------------------------
  // v22: 目的地に保存された姿勢(target.quaternion)の"上"方向
  // （ワールドY軸をtarget.quaternionで回転したもの）を艦の
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
    const zComp = targetUpLocal.z;
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
    // にangleだけ回せば目標に一致する」向きに対応する（シミュレーション
    // で実際に収束することを検証済み）。
    return { angle, axis: { x: 0, y: 0, z: 1 } };
  },

  // -----------------------------------------------------------
  // v23: onApproachSideのヒステリシス版。艦が進入軸から大きく
  // 横にズレた位置にいると、alongDistWorldの符号だけでの判定は
  // 艦のわずかな前後移動でも頻繁に反転してしまう
  // （DOCKING_APPROACH_SIDE_EXIT_MARGINのコメント参照）。
  //
  // 一度「手前側(true)」と判定された場合、alongDistWorldが
  // DOCKING_APPROACH_SIDE_EXIT_MARGIN（負の値、既定-20）を
  // 下回るまでは「手前側」の判定を維持する。逆に一度「奥側
  // (false)」と判定された場合は、alongDistWorldが0以上に
  // 戻り次第すぐ「手前側」に復帰する（奥から戻ってくる際に
  // わざと遅らせる理由はないため、falseからtrueへの遷移は
  // 従来通り即時）。
  //
  // 判定結果はship._dockingOnApproachSideにフレームをまたいで
  // キャッシュする（ドッキング解除時などに古い値が残っても、
  // 次にドッキング開始した際は最初のフレームでalongDistWorld>=0
  // なら即trueになるだけなので実害はない）。
  // -----------------------------------------------------------
  _computeOnApproachSideWithHysteresis(ship, alongDistWorld) {
    const wasOnApproachSide = ship._dockingOnApproachSide !== false; // 未設定時はtrue扱い（従来のデフォルト挙動に合わせる）
    let onApproachSide;
    if (wasOnApproachSide) {
      onApproachSide = alongDistWorld >= this.DOCKING_APPROACH_SIDE_EXIT_MARGIN;
    } else {
      onApproachSide = alongDistWorld >= 0;
    }
    ship._dockingOnApproachSide = onApproachSide;

    // v29: 「再アプローチが、最終進入からのオーバーシュート以外の
    // 場面でも発動してしまう」という報告への対応。
    //
    // 旧実装(v27)は「手前側→奥側へ切り替わった瞬間」であれば距離や
    // フェーズを問わず無条件に再アプローチモードへ入っていた。この
    // ためたとえば通常接近フェーズ（最終進入に一度も入っていない、
    // 遠方で艦が進入軸をわずかにまたいだだけ）でもalongDistWorldの
    // 符号が反転すれば再アプローチが誤発動しうる状態だった。
    //
    // 対策: 「直前のフレームで実際に最終進入フェーズ(inFinalApproach)
    // に入っていたか」をship._dockingWasInFinalApproach（
    // _buildDesiredForAutoDocking側でフレーム末に更新）で判定し、
    // 最終進入中だった場合に限り、手前側→奥側への切り替わりを
    // 「最終進入からのオーバーシュート」とみなして再アプローチを
    // 発動する。最終進入に入っていない間の同じ切り替わりは、
    // 従来通りのフォールバック（目的地の方角を向く通常ロジック）に
    // 任せ、再アプローチウェイポイントは使わない。
    const wasInFinalApproach = ship._dockingWasInFinalApproach === true;
    if (wasOnApproachSide && !onApproachSide && wasInFinalApproach) {
      ship._dockingReapproaching = true;
      // v30: 再アプローチ発動の瞬間、ゴーアラウンド旋回円を一度だけ
      // 構築する（このフレームの艦の位置・速度方向を基準にする）。
      this._startGoAroundTurn(ship);
    } else if (onApproachSide) {
      ship._dockingReapproaching = false;
      ship._dockingGoAround = null;
    }

    // v24: 「目的地の姿勢（進入軸）が艦の実際の接近経路と大きく
    // 食い違っている場合（例: ほぼ直進で着く位置関係なのに目的地の
    // 姿勢が直進方向とはかけ離れている）、alongDistWorldが距離800を
    // 切ってもずっと負のままになり、一度もonApproachSideがtrueに
    // ならない」という報告への対応。
    //
    // この関数のfalse時フォールバック（進入軸への姿勢固定・最終進入
    // ゾーンを無効化する）は本来、「一度は進入軸の手前側に入ったのに
    // 後から追い越して奥に出てしまった」場合に、姿勢が目的地から
    // 離れていく方向へ固定され続ける不具合(v17)を防ぐためのもの。
    // 艦がそもそも一度も手前側に入ったことがなければこの「追い越し」
    // は起こりようがなく、フォールバックを発動させる理由がない。
    // むしろ発動させると、姿勢がいつまで経っても進入軸へブレンド
    // されず最終進入フェーズにも入れない（＝目的地の保存済み姿勢へ
    // 一切旋回しない）という今回の不具合に直結する。
    //
    // 対策: 本物のonApproachSide=trueを一度でも経験したかを
    // ship._dockingEverOnApproachSideに記録する。まだ一度も経験して
    // いない間は、生のonApproachSideがfalseでも「手前側」扱いを
    // 返し、オーバーシュート用フォールバックを保留する。一度でも
    // 本物のtrueを経験した後は、以後は従来どおり生の判定（と既存の
    // ヒステリシス）をそのまま使う。
    if (onApproachSide) {
      ship._dockingEverOnApproachSide = true;
    }
    if (!onApproachSide && !ship._dockingEverOnApproachSide) {
      return true;
    }
    return onApproachSide;
  },

  // -----------------------------------------------------------
  // v24: 「船首から見てほぼ真後ろ（180°近く）の方向へ向けたい時、
  // 全く旋回せず逆噴射だけで移動しようとする」不具合の修正。
  //
  // 原因: 従来はnoseLocalとdirLocalの外積の長さをそのままasin()に
  // 渡して角度を求めていた（angle = asin(|cross|)）。sin(θ)は
  // θ=90°を軸に対称（sin(θ)=sin(180°-θ)）なため、外積の長さだけでは
  // 「ほぼ正面(θ≈0°)」と「ほぼ真後ろ(θ≈180°)」を区別できない。
  // 真後ろに近づくほど外積の長さは0へ収束し、実際には180°近い
  // 誤差があるのにangle≈0と誤判定され、HEADING_LOCK_TOLERANCE_DEG
  // （0.01°）を下回ったとしてheadingLockedがtrueになり、角速度を
  // 強制的にゼロへ吸収して回頭そのものを止めてしまっていた。以後は
  // 並進側の制御だけが働き、船首を向けないまま逆噴射スラスターで
  // 直接後退する、という報告どおりの挙動になっていた。
  //
  // 対策: atan2(|cross|, dot)で0..πの全域について正しい角度を
  // 求める。ちょうど180°付近では外積そのものが数値的に縮退し
  // 回転軸が不定になる（sin(180°)=0で軸方向が消える）ため、縮退時
  // （外積がほぼ0で、かつ正面より背面に近い＝angleがπ/2超）は
  // 仮の回転軸を使って旋回のきっかけを作る。一度でも旋回し始めれば
  // 外積が非ゼロになり、以降は通常どおり正しい軸へ収束する。
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

  _buildDesiredForAutoDocking(input, ship, dt) {
    const target = State.dockingTarget;
    const toTargetWorld = {
      x: target.position.x - ship.position.x,
      y: target.position.y - ship.position.y,
      z: target.position.z - ship.position.z,
    };
    const distance = vecLength(toTargetWorld);

    // v17: 距離がDOCKING_FINAL_APPROACH_DISTANCE以下になったら
    // 「最終進入フェーズ」に切り替える。以後は目的地の方角ではなく
    // 目的地に保存された姿勢そのものへ船首を固定し、まっすぐ一直線に
    // 進入させる。
    //
    // ただし、これは「艦が目的地の進入軸上、まだ手前側にいる」場合
    // にのみ有効な前提である。何らかの理由（急な外力、極端な初速、
    // 手動操縦からの切り替え直後など）で艦が目的地を通り越して
    // 奥側に出てしまった場合、姿勢を固定したままだと船首が
    // 目的地と逆を向いたまま戻れなくなる（「奥に行き過ぎたのに
    // 同じ方向を向き続けてさらに離れていく」不具合）。そのため、
    // 進入軸上での位置関係（alongDistの符号）を見て、奥側に
    // 出てしまっている間は通常フェーズと同じ「目的地の方角へ
    // 船首を向ける」ロジックにフォールバックし、手前側まで
    // 戻ってきたら改めて最終進入の姿勢固定を再開する。
    const approachAxisWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    const alongDistWorld = vecDot(toTargetWorld, approachAxisWorld);
    const onApproachSide = this._computeOnApproachSideWithHysteresis(ship, alongDistWorld);

    // v30: 通常フェーズ（まだ最終進入に入っていない間）が姿勢・並進の
    // 両方で実際に目指す先を、target.positionそのものではなく進入軸上の
    // 仮想ウェイポイント（_computeVirtualApproachTarget、target.positionの
    // DOCKING_VIRTUAL_TARGET_OFFSET手前）に差し替える。
    // これにより、距離200（本物のtarget.positionまでの距離）へ到達する
    // 頃には既に位置・姿勢とも進入軸上に乗っており、以降の最終進入
    // フェーズ（_buildFinalApproachForce、本物のtarget.positionを直接
    // 使う）はほぼ直進の制動だけで済むようになる。
    //
    // onApproachSideがfalse（進入軸の奥側に出てしまっている）場合は
    // 従来通り本物のtarget.positionをそのまま使う
    // （_computeHeadingTargetDirWorld・並進の再アプローチ分岐が
    // それぞれ独自にフォールバック/ウェイポイントを解決するため、
    // ここでは通常時の1本の経路計算にのみ影響させる）。
    const virtualApproachTargetPos = this._computeVirtualApproachTarget(
      target,
      approachAxisWorld,
      alongDistWorld
    );
    const effectiveTarget = onApproachSide
      ? { position: virtualApproachTargetPos, quaternion: target.quaternion }
      : target;
    const toEffectiveTargetWorld = {
      x: effectiveTarget.position.x - ship.position.x,
      y: effectiveTarget.position.y - ship.position.y,
      z: effectiveTarget.position.z - ship.position.z,
    };

    // v21: 「距離200(DOCKING_FINAL_APPROACH_DISTANCE)に着く前に
    // 姿勢を回り切っておいて、以降はほぼ直進だけにしたい」という
    // 要望への対応。距離条件だけでなく、船首が進入軸方向へ
    // DOCKING_FINAL_APPROACH_HEADING_READY_ANGLE以内まで実際に
    // 揃っていることも最終進入フェーズへ入る条件に加える。
    // 揃うのが遅れている間は通常フェーズの回頭ロジックのまま
    // その場に留まって姿勢を合わせ切る（headingReadyForFinalApproach、
    // 前進速度の絞りはheadingHold変数側で行う）。
    const approachAxisLocalForCheck = rotateVecByQuat(approachAxisWorld, conjugateQuat(ship.quaternion));
    const headingErrorFromAxis = Math.acos(clamp(-approachAxisLocalForCheck.z, -1, 1));
    const headingReadyForFinalApproach =
      headingErrorFromAxis <= this.DOCKING_FINAL_APPROACH_HEADING_READY_ANGLE;

    // v31: 「アプローチ中に仮想ウェイポイントへ向かいながら姿勢も
    // 進入軸へ揃えていき、距離200到達と同時に位置・姿勢とも
    // 進入軸上に乗っている」という設計を踏まえ、最終進入ゾーンへの
    // 突入条件からonApproachSideを外し、距離のみで判定する。
    // オーバーシュート後の異常系（onApproachSide=falseかつ
    // ship._dockingReapproaching=true）は、この直前の
    // _computeOnApproachSideWithHysteresis内で既に再アプローチ/
    // ゴーアラウンド専用ロジックへ切り替わっており、そちらが
    // 姿勢制御を引き継ぐため、ここでinFinalApproachZoneがtrueに
    // なっても実害はない。また実際の姿勢固定(inFinalApproach)には
    // 引き続きheadingReadyForFinalApproach（船首が進入軸に
    // 実際に揃っていること）を要求するため、船首が逆を向いた
    // ままのオーバーシュート直後に姿勢固定してしまうことはない
    // （揃うまではheadingHold＝姿勢調整中のまま留まる）。
    const inFinalApproachZone = distance <= this.DOCKING_FINAL_APPROACH_DISTANCE;
    const inFinalApproach = inFinalApproachZone && headingReadyForFinalApproach;
    // v29: 次フレームの_computeOnApproachSideWithHysteresis呼び出しが
    // 「直前フレームで最終進入フェーズに入っていたか」を参照できる
    // よう、このフレームで確定したinFinalApproachをship側に記録する。
    // ここでの代入は次回呼び出し時に読まれる（今回のonApproachSide
    // 判定は既にこの直前で完了済みなので、今回の判定には影響しない）。
    ship._dockingWasInFinalApproach = inFinalApproach;
    // 最終進入ゾーンに入っているのに姿勢がまだ整っていない：
    // その場で回頭を優先し、前進はDOCKING_HEADING_HOLD_FORWARD_DAMPING
    // まで絞る（完全停止ではなく、多少は近づきながら合わせる）。
    const headingHold = inFinalApproachZone && !headingReadyForFinalApproach;

    // 目的方向への単位ベクトル（勢い殺しモードの判定、姿勢ブレンドの
    // 奥側フォールバックで使う。安全装置である勢い殺し判定は本物の
    // target.positionまでの距離・方角をそのまま使う）
    const targetDirWorld = distance > 1e-4 ? vecNormalize(toTargetWorld) : null;

    // v30: 姿勢のベジエ追従・通常フェーズの並進接近が実際に目指す
    // 方向（onApproachSide中は仮想ウェイポイントの方角、奥側に出て
    // いる間は従来通り本物の目的地の方角にフォールバックする）。
    const approachTargetDirWorld =
      vecLength(toEffectiveTargetWorld) > 1e-4 ? vecNormalize(toEffectiveTargetWorld) : targetDirWorld;

    // v20: 「旋回で生じた横滑りをRCSだけでは殺しきれず目的地を
    // 通り過ぎる」不具合対策。詳細は_updateMomentumKillStateのコメント参照。
    const killingMomentum = this._updateMomentumKillState(ship, distance, targetDirWorld, dt);

    // --- 姿勢: 通常は船首(-Z)を目的方向へ（距離が縮まるにつれ徐々に
    //     進入軸方向へブレンド）、最終進入フェーズは目的地の保存済み
    //     姿勢そのものへ、勢い殺しモード中は現在の速度ベクトル方向
    //     （進行方向そのもの）へ向けるpitch/yawトルク ---
    //
    // v21: 「rollだけは常にユーザー入力を受け付けてしまっており、
    // 距離800以降はrollも含めて自動制御に姿勢を委ねたい」という
    // 要望への対応。距離800(DOCKING_HEADING_BLEND_START_DISTANCE)を
    // 切ったらrollの手動入力(input.rotateRoll)も無視する。
    // v22: さらに、rollを単に0へ収束させるだけでなく、目的地に
    // 保存された姿勢のroll角そのものへ実際に合わせにいくよう
    // なった（下記のautoRollLockActiveブロック、_computeRollErrorAngle
    // 参照）。800以上ではこれまで通りrollは手動のまま。
    // onApproachSideは見ない（通り越して奥側に出てしまっている間も
    // 「距離800以内なら手動操作は全て自動制御に委ねる」という要望
    // に忠実に、距離のみで判定する）。
    const autoRollLockActive = distance <= this.DOCKING_HEADING_BLEND_START_DISTANCE;
    let desiredTorque = { x: 0, y: 0, z: autoRollLockActive ? 0 : input.rotateRoll };
    let headingLocked = false;
    let rollLocked = false;

    if (killingMomentum) {
      // v20: 目的地/進入軸への通常の姿勢制御を中断し、船首を現在の
      // 速度ベクトル方向へ向け直す。これにより速度のほぼ全てが
      // 艦のローカルZ軸に乗り、艦内で最も強い並進スラスター
      // （主機関・逆噴射スラスター）が全力でその速度を打ち消せる
      // ようになる（並進側の処理は下記のkillingMomentum分岐を参照）。
      const speed = vecLength(ship.velocity);
      if (speed > 1e-4) {
        const progradeWorld = vecScale(ship.velocity, 1 / speed);
        const progradeLocal = rotateVecByQuat(progradeWorld, conjugateQuat(ship.quaternion));
        const noseLocal = { x: 0, y: 0, z: -1 };
        const { angle, axis: axisNorm } = this._computeHeadingAngleAndAxis(noseLocal, progradeLocal);

        headingLocked = this._lockHeadingIfWithinTolerance(ship, angle);

        if (!headingLocked && angle > this.DOCKING_HEADING_MIN_ANGLE) {
          // 緊急の向き直しなので、最終進入と同じ厳しめの閾値で
          // 素早くフルトルクへ近づける。
          const torqueStrength = Math.min(1, angle / this.DOCKING_FINAL_HEADING_FULL_TORQUE_ANGLE);
          desiredTorque.x = axisNorm.x * torqueStrength;
          desiredTorque.y = axisNorm.y * torqueStrength;
        }
      }
    } else if (distance > 1e-4) {
      // v32: ヨー反転バグ対策。inFinalApproach（最終進入フェーズ、
      // 姿勢が既に整っている）の間は、ベジエ先読み点という「位置」
      // ベースの目標方向計算をやめ、target.quaternionが定める船首
      // 方向（-Z軸）そのものを直接ワールド空間へ変換して姿勢目標に
      // する。
      // 理由: _computeHeadingTargetDirWorldの先読み点はベジエ曲線
      // （終点=目的地位置）上を弧長ベースで辿るため、艦が目的地に
      // 極めて接近する（distanceが小さくなる）と、先読み点が艦の
      // すぐ近傍・場合によっては後方や横に来てしまうことがあった。
      // これが「最後の姿勢固定でヨーが180度逆になる」不具合の原因
      // だった。最終進入フェーズは既に船首が進入軸に揃っている
      // (headingReadyForFinalApproach)ので、以後は位置を経由せず
      // 目的地の保存済み姿勢へ直接収束させることで、位置計算の
      // 不安定さの影響を受けなくする。
      //
      // v35: headingHold（最終進入ゾーンに入ったがまだ姿勢が
      // 揃っていない間）も同じ問題を抱えていた。_buildApproachBezier
      // の始点ハンドル(p1)は艦の「現在の船首方向」を接線として使う
      // ため、船首がヨー反転などで大きく乱れている間にこの関数を
      // 呼び続けると、乱れた船首方向を起点に次の目標方向を計算する
      // 循環構造になり、姿勢がいつまで経っても収束しない（「泊まって
      // からも姿勢調整を一切しない」報告の原因）。
      // 対策: headingHold中もinFinalApproachと同様、位置ベースの
      // ベジエ計算を経由せず、target.quaternionへ直接収束させる。
      // 距離200圏内(inFinalApproachZone)に入って以降は常にこちらを
      // 使い、位置ベースのベジエ追従は圏外（通常フェーズ）専用にする。
      const useDirectHeadingTarget = inFinalApproach || headingHold;
      const headingTargetWorld = useDirectHeadingTarget
        ? vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion))
        : this._computeHeadingTargetDirWorld(
            ship,
            effectiveTarget,
            approachTargetDirWorld,
            approachAxisWorld,
            distance,
            onApproachSide,
            dt
          );
      const targetDirLocal = rotateVecByQuat(headingTargetWorld, conjugateQuat(ship.quaternion));

      // 現在の船首方向（ローカル-Z）から見た目的方向への回転軸・角度を、
      // 小角近似の外積で求める（fromVec × toVec ≈ 回転軸*sin(角度)、
      // pitch/yawの2軸分だけを使う簡易版。厳密な最短回転ではないが
      // 「船首を向ける」用途では十分な近似で、既存の角速度ダンピングと
      // 同じ比例制御スキームに素直に乗せられる）。
      const noseLocal = { x: 0, y: 0, z: -1 };
      // x≈pitch誤差, y≈yaw誤差。角度自体はatan2ベースで0..π全域正確
      // （_computeHeadingAngleAndAxis参照、v24でasin()の180°付近の
      // 誤判定バグを修正）。
      const { angle, axis: axisNorm } = this._computeHeadingAngleAndAxis(noseLocal, targetDirLocal);

      // v09: 目標角度との差がHEADING_LOCK_TOLERANCE_DEG（既定0.01度）を
      // 下回ったら、トルク要求を出さず角速度も強制的にゼロへ吸収する
      // （_lockHeadingIfWithinTolerance）。これにより「ほぼ揃っている
      // のに微小な残差を追いかけ続けてRCSが吹きっぱなしになる」現象を防ぐ。
      headingLocked = this._lockHeadingIfWithinTolerance(ship, angle);

      if (!headingLocked && angle > this.DOCKING_HEADING_MIN_ANGLE) {
        // v21: 「距離200を境にフルトルク角度が緩め(60°)→厳しめ(20°)へ
        // 瞬時に切り替わり、境界で急に回頭が強くなる（＝固定された
        // ように感じる）」という報告への対応。
        // _computeHeadingTargetDirWorldと同じ距離800→200の区間で、
        // フルトルク角度自体も線形補間する。距離800以上では従来通り
        // 穏やかな60°、距離200以下では従来通り厳しい20°になり、
        // その間はなめらかに遷移する（「距離800からアプローチと同時に
        // ゆっくり姿勢を整えたい」という要望に合わせ、200という
        // 境界を実質的に無くす）。
        const fullTorqueAngle = this._computeHeadingFullTorqueAngle(distance);
        const torqueStrength = Math.min(1, angle / fullTorqueAngle);
        desiredTorque.x = axisNorm.x * torqueStrength;
        desiredTorque.y = axisNorm.y * torqueStrength;
      }
    }

    // v22: 「自動操船中、船首の向き(pitch/yaw)は目的地方向へ合わせて
    // くれるが、rollは目的地に保存された姿勢のroll角までは合わせて
    // くれない」という報告への対応。autoRollLockActive中（距離800
    // 以内）は、pitch/yawと同じ比例制御スキームでroll角も目的地の
    // 保存済み姿勢へ揃える。killingMomentum中（速度方向へ緊急に
    // 向き直している最中）はpitch/yawの目標自体が目的地姿勢とは
    // 無関係な進行方向になるため、rollだけ目的地姿勢を追いかけると
    // 不自然になる。そのためkillingMomentum中はrollトルクを出さず
    // 角速度ダンピングにのみ委ねる（=roll角速度を止めるだけ）。
    if (autoRollLockActive && !killingMomentum) {
      const rollError = this._computeRollErrorAngle(ship, target);
      rollLocked = this._lockRollIfWithinTolerance(ship, rollError.angle);

      if (!rollLocked && Math.abs(rollError.angle) > this.DOCKING_ROLL_MIN_ANGLE) {
        const rollTorqueStrength = clamp(
          rollError.angle / this.DOCKING_ROLL_FULL_TORQUE_ANGLE,
          -1,
          1
        );
        desiredTorque.z = rollError.axis.z * rollTorqueStrength;
      }
    }

    // 角速度ダンピング: 自動操船中はpitch/yaw/rollいずれの軸も、
    // 上記で意図的にトルクを発生させていない（≒0に近い）場合は
    // 角速度を打ち消す方向へ寄せる。これにより目的方向へ向いた後
    // 船首がピタッと止まり、rollもユーザーが手を離せば止まる。
    // headingLocked時はship.angularVelocity.x/yが既に0へ吸収済み
    // なのでダンピング対象はほぼrollのみになる。
    // v09: 固定閾値の比例ブレーキではなく、艦の制動能力に基づいた
    // オーバーシュートしない強さ（_computeOvershootSafeBrakeTorque）
    // を使う。理由は通常のダンピングと同じ（艦種による慣性差）。
    const angSpeed = vecLength(ship.angularVelocity);
    if (angSpeed > this.AUTO_DAMPING_MIN_ANGULAR_SPEED) {
      const brakeDir = this._computeOvershootSafeBrakeTorque(ship, ship.angularVelocity, dt);
      // 既に自動制御/手動入力で発生させているトルク要求へブレーキ分を
      // 加算する（自動姿勢合わせと角速度ダンピングを同時に働かせる）。
      desiredTorque.x += brakeDir.x * (1 - Math.abs(desiredTorque.x));
      desiredTorque.y += brakeDir.y * (1 - Math.abs(desiredTorque.y));
      desiredTorque.z += brakeDir.z * (1 - Math.abs(desiredTorque.z));
      desiredTorque.x = clamp(desiredTorque.x, -1, 1);
      desiredTorque.y = clamp(desiredTorque.y, -1, 1);
      desiredTorque.z = clamp(desiredTorque.z, -1, 1);
    }

    // --- 並進: 目的地座標へ接近し、付近では速度を打ち消して静止する ---
    const desiredForce = { x: 0, y: 0, z: 0 };
    const localVel = rotateVecByQuat(ship.velocity, conjugateQuat(ship.quaternion));

    if (killingMomentum) {
      // v20: 接近力は一切出さず、フルブレーキだけをかける。姿勢が
      // 速度ベクトル方向へ揃うにつれ、局所速度のほぼ全てがローカルZ
      // 成分に乗ってくるため、この単純な「ローカル速度と逆向きに
      // フル出力」でも主機関・逆噴射スラスターが自動的に選ばれ
      // （03-thruster-solver.jsのソルバーが方向の一致度で評価する）、
      // 弱いRCSだけに頼っていた通常フェーズより強く減速できる。
      const speed = vecLength(localVel);
      if (speed > 1e-4) {
        const brakeDirLocal = vecScale(localVel, -1 / speed);
        desiredForce.x = brakeDirLocal.x;
        desiredForce.y = brakeDirLocal.y;
        desiredForce.z = brakeDirLocal.z;
      }
    } else if (inFinalApproach) {
      // v17: 最終進入フェーズ（距離200以下、かつv21よりheadingReady=
      // 姿勢が既に整っている場合のみ）。姿勢は既に目的地の
      // 保存済み姿勢へ固定を試みているので、並進側は
      //   1) 目的地の進入軸に対する横ずれ(X/Y)を消す
      //   2) 進入軸方向(Z)は制動距離ベースのブレーキで
      //      オーバーシュートなく減速しながら進む
      // の2つを別々に解く。approach力とbrake力を単純加算して
      // クランプする旧方式は、ブレーキが必要な場面でも接近力に
      // 打ち消されてブレーキ実効値が薄まり「通り越す」原因になって
      // いたため、ここでは横方向とZ方向を分離した上でZ方向は
      // ブレーキを主、接近をブレーキが許す残り分だけに制限する。
      this._buildFinalApproachForce(desiredForce, ship, target, toTargetWorld, localVel, dt);
    } else if (headingHold) {
      // v21: 最終進入ゾーン(距離200以下)には入ったが、まだ姿勢が
      // DOCKING_FINAL_APPROACH_HEADING_READY_ANGLE以内に揃って
      // いない状態。
      // v34: 従来はDOCKING_HEADING_HOLD_FORWARD_DAMPING（0.15）まで
      // 絞るだけで加速側の推力を完全には止めていなかったため、
      // ヨー反転などで姿勢がなかなか揃わない間にじわじわ前進を
      // 続けてしまい、「最終進入(inFinalApproach)に入れないまま
      // 距離200のラインをさらに割り込んでいく」不具合があった。
      // 「最終進入以外では距離200以内に入らせない」という方針に
      // 合わせ、加速側の推力を完全にゼロにした（_buildFinalApproachForce
      // へforwardDamping=0を渡す形）。
      //
      // v35: それでもなお200圏内へ侵入してしまう不具合が残っていた。
      // 原因は_buildFinalApproachForceの制動方式にあった：あの関数は
      // 「目的地の進入軸」を基準に速度を『進入軸方向(主機関が担当・
      // 強い)』と『横方向(RCSが担当・弱い)』へ分解し、それぞれ別々に
      // ブレーキをかける。この前提は「船首がおおよそ進入軸方向を
      // 向いている」場合しか成立しない。ところがheadingHold中は
      // まさに姿勢(特にヨー)が乱れている最中で、本来なら主機関の
      // 強い制動力で止まるべき速度成分が「横方向」に分類されてしまい、
      // 非力なRCSだけでは制動が追いつかず、慣性のまま距離200を
      // 突破していた（「エンジンを止めたつもりが慣性で飛ばされる」
      // という報告はこれが原因）。
      //
      // 対策: headingHold中は進入軸基準の分解をやめ、killingMomentum
      // 分岐と同じ考え方で「船の現在のローカル速度(localVel)をその
      // まま逆方向へフルブレーキ」する。船体がどの向きを向いていても、
      // ローカル速度と逆向きの力なら、ソルバー(ThrusterSolver.solve)側が
      // 艦の全スラスター（主機関含む）から方向の一致度で最適な組み
      // 合わせを自動選択してくれるため、姿勢が乱れている最中でも
      // 「今出せる最大の制動力」で確実にワールド速度を殺せる。
      // 横方向の位置ずれ補正（進入軸に戻ろうとする力）は、姿勢が
      // 揃っていない間はどのみち大きな意味を持たないため出さない
      // （姿勢が揃ってheadingHoldを抜け、inFinalApproachに入ってから
      // 改めて_buildFinalApproachForceが横ずれを補正する）。
      const speed = vecLength(localVel);
      if (speed > 1e-4) {
        const brakeStrength = Math.min(1, speed / this.DOCKING_HEADING_HOLD_BRAKE_FULL_SPEED);
        desiredForce.x = (-localVel.x / speed) * brakeStrength;
        desiredForce.y = (-localVel.y / speed) * brakeStrength;
        desiredForce.z = (-localVel.z / speed) * brakeStrength;
      }
    } else if (distance > this.DOCKING_POSITION_MIN_DISTANCE) {
      // --- 通常フェーズ（距離200超）: 目的地方向への接近力と、
      //     艦の実際の制動能力に基づく速度ブレーキを合成する ---
      //
      // v17: 「通り越しがち」の一番の原因はここにあった。旧実装は
      // 接近力とブレーキ力を単純加算してから-1..1にクランプして
      // いたが、両者は逆方向を向くことが多く（接近力=目的地方向、
      // ブレーキ力=速度と逆方向で、順調に接近中はこの2つがほぼ
      // 正反対）、加算すると打ち消し合ってしまう。結果、
      // 「ブレーキが必要なほど速度が出ている」場面ほど合成後の
      // 実効推力が薄まり、減速しきれず通り越す、という不具合に
      // なっていた。
      //
      // 対策: 最終進入フェーズと同じ考え方で、ブレーキを主として
      // 解き、接近力はブレーキが余らせた分（1 - |ブレーキ強度|）を
      // 上限に控えめに上乗せする。
      //
      // v27: 再アプローチ中（onApproachSide=false、オーバーシュート
      // 直後）は、接近先を目的地そのものではなく再アプローチ
      // ウェイポイント（進入軸の手前側）にする。目的地への直進力の
      // ままだと姿勢側は既にウェイポイントへ向き直っているのに
      // 並進力だけ目的地方向のままズレてしまうため、姿勢・並進の
      // 目標地点を必ず一致させる。
      // v30: それ以外（通常の接近中）は、target.positionそのものでは
      // なくeffectiveTarget.position（仮想ウェイポイント。
      // onApproachSide=falseならtargetそのものにフォールバック済み）
      // を接近先にする。姿勢側（上のheadingTargetWorld計算）と同じ
      // 目標地点を使うことで、距離200に到達する頃には並進の狙いも
      // 姿勢もどちらも進入軸上に揃っている状態になる。
      //
      // v30: ゴーアラウンド中（進行方向を保ったままヨーだけで円弧を
      // 描いている最中）は、ウェイポイントへの接近力・横ずれ補正の
      // どちらも並進スラスターを噴かせない。「並進はほぼ使わず、
      // 姿勢(ヨー)だけで曲がる」というゴーアラウンドの狙いに対し、
      // 通常の接近ロジックが横方向のRCSを噴いてしまうと弧が乱れて
      // しまうため。速度は現在の慣性のまま（ダンピングもかけない）
      // 円弧を描かせ、ゴーアラウンド完了後に通常のブレーキ・接近力
      // 制御へ戻す。
      const goingAround = ship._dockingReapproaching && !this._isGoAroundComplete(ship._dockingGoAround);
      if (goingAround) {
        desiredForce.x = 0;
        desiredForce.y = 0;
        desiredForce.z = 0;
      } else {
      const approachTargetWorld = ship._dockingReapproaching
        ? this._computeReapproachWaypoint(target, approachAxisWorld)
        : effectiveTarget.position;
      const toApproachTargetWorld = {
        x: approachTargetWorld.x - ship.position.x,
        y: approachTargetWorld.y - ship.position.y,
        z: approachTargetWorld.z - ship.position.z,
      };
      const toTargetLocal = rotateVecByQuat(toApproachTargetWorld, conjugateQuat(ship.quaternion));
      const approachDirLocal = vecNormalize(toTargetLocal);
      // v21: 勢いキル退出直後はクールダウン倍率(0→1)を接近力に掛け、
      // 「殺したはずの勢いを接近力で即座に再生産してしまう」ことを防ぐ。
      // ブレーキ側(speedBrakeReference以下)には掛けない＝減速そのものは
      // 通常のRCS/主機関にそのまま任せる。
      const cooldownMult = this._tickApproachCooldownMultiplier(ship, dt);
      const approachStrength =
        Math.min(1, distance / this.DOCKING_POSITION_FULL_THRUST_DISTANCE) * cooldownMult;

      // v17: 艦の実際の最大減速度(_estimateMaxLinearDecel)から
      // 「残り距離(を最終進入距離まで詰めた分)でちょうど
      // DOCKING_FINAL_APPROACH_DISTANCEに間に合う速度」を逆算し、
      // 現在速度がそれを超えていたら従来のdistanceベースの基準値より
      // 優先して強めにブレーキをかける。
      //
      // v32: 「進入軸に着く前に距離200を切ってしまい、姿勢が
      // 整わないまま最終進入ゾーンに入る（＝RCSが横方向の勢いを
      // 殺しきれず通り過ぎる）」という報告への対応。
      // 従来はlocalVel全体の大きさ(speed)を、前進方向(Z、主機関・
      // 逆噴射担当)の減速能力だけから逆算したphysicalSafeSpeedと
      // 比較していた。しかし横方向(X/Y、RCS担当)は前進方向より
      // 遥かに非力（艦種にもよるが1桁以上弱い）なため、横方向の
      // 速度成分にも同じ基準を適用すると「この速度なら止まれる」
      // という見積もりが横方向では大きく甘くなり、実際には
      // ブレーキが追いつかず通り過ぎていた。
      // 対策: Z成分と横成分(X/Y)を分離し、それぞれの軸が実際に
      // 出せる減速能力(_estimateMaxLinearDecel/_estimateMaxLateralDecel)
      // から個別にphysicalSafeSpeedを算出、ブレーキ強度も軸ごとに
      // 独立して計算する。
      const maxDecel = this._estimateMaxLinearDecel(ship);
      const maxLateralDecel = this._estimateMaxLateralDecel(ship);
      const distanceToFinalZone = Math.max(0, distance - this.DOCKING_FINAL_APPROACH_DISTANCE);
      // v36: 「距離200へ到達した時点でまだ速度が残っていて、
      // headingHold(全方位フルブレーキ)でも200のラインで止まりきれず
      // 160付近まで侵入してしまう」という報告への対応。
      // 従来はここでマージンなし（1.0倍）の理論値ぎりぎりを
      // physicalSafeSpeedとして使っていたが、これは
      // 「艦がずっと理想的な向きのまま走り続ける」前提の計算であり、
      // 実際には多少の余裕がないと、ソルバーの丸めや1フレーム分の
      // 遅れ、姿勢がまだ完全には揃いきっていない間の制動力低下等で
      // 詰めきれずわずかに超過する。_buildFinalApproachForce側で
      // 既に使っているDOCKING_FINAL_APPROACH_BRAKE_MARGIN（0.85）と
      // 同じ考え方をここにも適用し、200到達時点でより確実に
      // 制動が間に合う速度まで事前に絞っておく。
      // v = sqrt(2 * a * d * margin) : この距離で確実に止まり切れる速度
      const physicalSafeSpeed = Math.sqrt(
        2 * maxDecel * distanceToFinalZone * this.DOCKING_FINAL_APPROACH_BRAKE_MARGIN
      );
      const physicalSafeLateralSpeed = Math.sqrt(
        2 * maxLateralDecel * distanceToFinalZone * this.DOCKING_FINAL_APPROACH_BRAKE_MARGIN
      );

      // v15: ブレーキが「フルになる速度」を距離に応じて伸縮させる。
      // 距離がDOCKING_POSITION_FULL_THRUST_DISTANCE以内なら従来通り
      // DOCKING_APPROACH_SPEED_FULL_BRAKEに絞り、DOCKING_APPROACH_
      // SPEED_TAPER_DISTANCE以上ではship.maxSpeedまで緩める（遠方では
      // 速度4程度で頭打ちにならず加速し続けられるようにするため）。
      // v17: ただし艦の制動能力から逆算したphysicalSafeSpeedより
      // 緩い基準値は採用しない（min）。遠方では従来通りmaxSpeed
      // 付近まで緩められるが、最終進入距離が近づくにつれ
      // physicalSafeSpeedが急速に絞られ、通り越さない速度まで
      // 事前に減速させる。
      const taperRange = Math.max(
        1e-6,
        this.DOCKING_APPROACH_SPEED_TAPER_DISTANCE - this.DOCKING_POSITION_FULL_THRUST_DISTANCE
      );
      const taperT = clamp(
        (distance - this.DOCKING_POSITION_FULL_THRUST_DISTANCE) / taperRange,
        0,
        1
      );
      const distanceBasedReference =
        this.DOCKING_APPROACH_SPEED_FULL_BRAKE +
        (ship.maxSpeed - this.DOCKING_APPROACH_SPEED_FULL_BRAKE) * taperT;
      const speedBrakeReference = Math.max(
        this.DOCKING_APPROACH_SPEED_FULL_BRAKE,
        Math.min(distanceBasedReference, physicalSafeSpeed)
      );
      // v32: 横成分専用の基準値。DOCKING_APPROACH_SPEED_FULL_BRAKE
      // （距離ベースの下限）は前進方向を想定した値なので、横方向は
      // physicalSafeLateralSpeedのみで頭打ちにする（下限を設けると
      // 横方向の非力さを無視してブレーキを緩めてしまうため）。
      const lateralSpeedBrakeReference = Math.max(1e-3, physicalSafeLateralSpeed);

      const lateralVelLocal = { x: localVel.x, y: localVel.y, z: 0 };
      const lateralSpeed = vecLength(lateralVelLocal);
      const forwardSpeed = Math.abs(localVel.z);

      let brakeDirLocal = { x: 0, y: 0, z: 0 };
      if (lateralSpeed > 1e-4) {
        const lateralBrakeStrength = Math.min(1, lateralSpeed / lateralSpeedBrakeReference);
        const lateralBrakeDir = vecScale(lateralVelLocal, -1 / lateralSpeed);
        brakeDirLocal.x = lateralBrakeDir.x * lateralBrakeStrength;
        brakeDirLocal.y = lateralBrakeDir.y * lateralBrakeStrength;
      }
      let brakeStrength = 0;
      if (forwardSpeed > 1e-4) {
        brakeStrength = Math.min(1, forwardSpeed / speedBrakeReference);
        brakeDirLocal.z = -Math.sign(localVel.z) * brakeStrength;
      }
      // approachHeadroom（接近力を上乗せしてよい余地）はZ方向の
      // ブレーキ強度のみを見る。横方向のブレーキは横ずれ補正であり、
      // 接近力（進行方向への推力）とは軸が異なるため混同しない。

      // v17: ブレーキを主として適用し、接近力はブレーキが使わなかった
      // 出力の余り（1 - brakeStrength）分だけ、ブレーキ方向を邪魔しない
      // 範囲で上乗せする。ブレーキ方向と接近方向が同じ（＝目的地から
      // 離れる速度が出ている、正しく引き返している最中等）場合は
      // 単純加算でよい。
      desiredForce.x = brakeDirLocal.x;
      desiredForce.y = brakeDirLocal.y;
      desiredForce.z = brakeDirLocal.z;

      const approachHeadroom = Math.max(0, 1 - brakeStrength);
      desiredForce.x += approachDirLocal.x * approachStrength * approachHeadroom;
      desiredForce.y += approachDirLocal.y * approachStrength * approachHeadroom;
      desiredForce.z += approachDirLocal.z * approachStrength * approachHeadroom;

      desiredForce.x = clamp(desiredForce.x, -1, 1);
      desiredForce.y = clamp(desiredForce.y, -1, 1);
      desiredForce.z = clamp(desiredForce.z, -1, 1);
      }
    }

    // --- 手動のストレイフ微調整をロールと同様に上乗せする ---
    // v09: thrustForward（メインエンジンのレバー）は上乗せしない
    // （上記コメント参照）。ストレイフ(X/Y)はRCSでの微調整として従来通り許可。
    // v21: rollと同じく、距離800(DOCKING_HEADING_BLEND_START_DISTANCE)を
    // 切ったら（autoRollLockActive）ストレイフの手動微調整も拒否し、
    // 並進・回転すべてを自動制御に委ねる。
    if (!autoRollLockActive) {
      desiredForce.x = clamp(desiredForce.x + input.thrustStrafeX, -1, 1);
      desiredForce.y = clamp(desiredForce.y + input.thrustStrafeY, -1, 1);
    }

    return { desiredForce, desiredTorque };
  },

  // -----------------------------------------------------------
  // v17: 最終進入フェーズ（距離≤DOCKING_FINAL_APPROACH_DISTANCE）専用の
  // 並進力を計算し、desiredForceへ書き込む。
  //
  //   横方向(X/Y): 目的地の進入軸（船首方向）を基準に、艦が軸から
  //   どれだけ横に外れているかをローカルX/Y換算で求め、位置ずれ・
  //   速度の両方を打ち消す方向へ推力を出す。これにより「まっすぐ
  //   入港する」動きになる。
  //
  //   前後方向(Z): 単純な比例ブレーキではなく、
  //     制動距離 = 現在速度^2 / (2 × 艦の最大減速度)
  //   を実際に計算し、残り距離がその制動距離を下回った時点で
  //   フルブレーキへ切り替える（stopping-distanceベース）。
  //   これにより「まだ大丈夫」と接近を続けて距離0付近で減速力が
  //   足りなくなる＝目的地を通り越す、という不具合を防ぐ。
  //   制動距離に余裕がある間は、DOCKING_FINAL_APPROACH_MAX_SPEED_RATIO
  //   で頭打ちした穏やかな接近速度を目標にする（最終進入フェーズは
  //   姿勢合わせ優先のため、遠方フェーズほどの高速接近は行わない）。
  // -----------------------------------------------------------
  // v21: 「距離200を切った瞬間、姿勢のズレを回頭ではなく船体の
  // 横スライドで無理やり合わせにいく」→ユーザーの言う「姿勢の
  // 固定」に見える、という報告への対応。
  //
  // 横方向の"位置"ずれ補正（posStrength、下記）は、艦の姿勢が
  // まだ進入軸から大きくズレている間は弱め、回頭が追いついて
  // 姿勢が揃うにつれ通常の強さへ戻す。速度側の横滑りブレーキは
  // 常時フルで効かせる（これは安全のための制動であり、能動的な
  // 位置合わせスライドではないため）。「横移動補正も少しは残したい」
  // 要望に合わせ、姿勢が大きくズレていてもゼロにはせず最低限は残す。
  HEADING_ERROR_FULL_LATERAL_ANGLE: 0.35, // この角度(rad)以上ズレている間は横方向位置補正をMIN倍率まで弱める（約20°）
  HEADING_ERROR_LATERAL_MIN_MULT: 0.25, // 姿勢が大きくズレている時でも残す横方向位置補正の下限倍率

  // v28: 艦の最大減速度(maxDecel)から、最終進入フェーズ専用の
  // 「速度誤差→推力」スロットル基準を動的に算出する。
  // DOCKING_FINAL_APPROACH_THROTTLE_REF_DECELを基準減速度とし、
  // 実際のmaxDecelがそれよりΓ倍強ければ基準もΓ倍緩める（比例）。
  // 減速力の強い艦ほど「多少の速度差なら緩やかに埋めればいずれ
  // 間に合う」ため基準を大きく、弱い艦ほど「早めにフル出力に
  // 入らないと制動が追いつかない」ため基準を小さくする、という
  // 方向性。MIN/MAXでクランプして極端な艦種でも安定させる。
  _computeFinalApproachThrottleErrorRef(maxDecel) {
    const refDecel = Math.max(1e-3, this.DOCKING_FINAL_APPROACH_THROTTLE_REF_DECEL);
    const scaled =
      this.FORWARD_VELOCITY_FULL_THROTTLE_ERROR * (maxDecel / refDecel);
    return clamp(
      scaled,
      this.DOCKING_FINAL_APPROACH_THROTTLE_REF_MIN,
      this.DOCKING_FINAL_APPROACH_THROTTLE_REF_MAX
    );
  },

  // v28: 速度超過側（speedError<0）のブレーキ出力を、緊急度
  // （実際の制動距離／残り距離）に応じて弱い比例ブレーキから
  // フルブレーキへ滑らかにブレンドする。speedError>=0（加速側）は
  // 素通しする（呼び出し側の従来ロジックをそのまま使う）。
  // DOCKING_FINAL_APPROACH_URGENCY_BLEND_START/FULL参照。
  _blendFinalApproachBrake(speedError, closingSpeed, remainingDist, maxDecel, throttleErrorRef) {
    const proportional = clamp(speedError / throttleErrorRef, -1, 0);
    if (speedError >= 0 || closingSpeed <= 0 || remainingDist <= 1e-6) {
      return proportional;
    }
    const stoppingDist =
      (closingSpeed * closingSpeed) / (2 * maxDecel * this.DOCKING_FINAL_APPROACH_BRAKE_MARGIN);
    const urgency = stoppingDist / remainingDist;
    const blendRange = Math.max(
      1e-6,
      this.DOCKING_FINAL_APPROACH_URGENCY_BLEND_FULL - this.DOCKING_FINAL_APPROACH_URGENCY_BLEND_START
    );
    const urgencyT = clamp(
      (urgency - this.DOCKING_FINAL_APPROACH_URGENCY_BLEND_START) / blendRange,
      0,
      1
    );
    return proportional * (1 - urgencyT) + -1 * urgencyT;
  },

  _buildFinalApproachForce(desiredForce, ship, target, toTargetWorld, localVel, dt, forwardDamping) {
    const toTargetLocal = rotateVecByQuat(toTargetWorld, conjugateQuat(ship.quaternion));

    // 目的地の進入軸（船首方向、ワールド→ローカル）
    const approachAxisWorld = vecNormalize(rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion));
    const approachAxisLocal = vecNormalize(rotateVecByQuat(approachAxisWorld, conjugateQuat(ship.quaternion)));

    // toTargetLocalを「進入軸に沿った成分」と「軸に垂直な横ずれ成分」に分解
    const alongDist = vecDot(toTargetLocal, approachAxisLocal);
    const alongVec = vecScale(approachAxisLocal, alongDist);
    const lateralOffset = {
      x: toTargetLocal.x - alongVec.x,
      y: toTargetLocal.y - alongVec.y,
      z: toTargetLocal.z - alongVec.z,
    };
    const lateralDist = vecLength(lateralOffset);

    // v21: 船首(-Z)が進入軸(approachAxisLocal)からどれだけズレているか。
    // このズレが大きいほど「今はまだ回頭中」と判断し、横方向の
    // 位置合わせスライドを控えめにする。
    const headingAngle = Math.acos(clamp(-approachAxisLocal.z, -1, 1));
    const headingErrorT = clamp(headingAngle / this.HEADING_ERROR_FULL_LATERAL_ANGLE, 0, 1);
    const lateralPosMult = this.HEADING_ERROR_LATERAL_MIN_MULT +
      (1 - this.HEADING_ERROR_LATERAL_MIN_MULT) * headingErrorT;

    // --- 横方向: 位置ずれ + 速度の両方を打ち消す（PD制御的に合成） ---
    if (lateralDist > 1e-4) {
      const lateralDirLocal = vecScale(lateralOffset, 1 / lateralDist); // 目的軸へ戻る方向
      const posStrength =
        Math.min(1, lateralDist / this.DOCKING_LATERAL_CORRECTION_FULL_THRUST_OFFSET) * lateralPosMult;
      desiredForce.x += lateralDirLocal.x * posStrength;
      desiredForce.y += lateralDirLocal.y * posStrength;
    }
    // 横方向速度成分（進入軸に垂直な速度）を制動
    const velAlong = vecDot(localVel, approachAxisLocal);
    const velAlongVec = vecScale(approachAxisLocal, velAlong);
    const lateralVel = {
      x: localVel.x - velAlongVec.x,
      y: localVel.y - velAlongVec.y,
      z: localVel.z - velAlongVec.z,
    };
    const lateralSpeed = vecLength(lateralVel);
    if (lateralSpeed > 1e-4) {
      const brakeStrength = Math.min(1, lateralSpeed / this.STRAFE_DAMPING_FULL_BRAKE_SPEED);
      const brakeDirLocal = vecScale(lateralVel, -brakeStrength / lateralSpeed);
      desiredForce.x += brakeDirLocal.x;
      desiredForce.y += brakeDirLocal.y;
    }
    desiredForce.x = clamp(desiredForce.x, -1, 1);
    desiredForce.y = clamp(desiredForce.y, -1, 1);

    // --- 前後方向(進入軸): 距離に応じて連続的に変化する目標接近速度への
    //     比例制御（単一の制御則。フルブレーキ/フル前進の二値切り替えは
    //     行わない） ---
    // alongDistは「艦から見て目的地が進入軸方向にどれだけ先にあるか」。
    // 通常は正（まだ手前にいる）。速度は艦が進入軸方向へ進んでいれば正。
    //
    // v25: 従来は「制動距離 >= 残り距離ならフルブレーキ(-1)、それ未満
    // なら固定目標速度への比例制御」という2つの制御則をハード
    // スイッチしていた。この閾値をまたぐ瞬間に主機関(+1)と逆噴射(-1)
    // が交互に全力で切り替わり、ガクガクした挙動になっていた
    // （「主機関と逆噴射がフルパワーで交互に切り替わる」報告）。
    //
    // 対策: 目標接近速度そのものを、残り距離から逆算した
    // 「その距離で安全に止まり切れる速度」で滑らかに頭打ちする
    // 一本の関数にする。v = sqrt(2 * maxDecel * remainingDist) は
    // 制動距離の式の逆算そのものなので、残り距離が減るにつれ
    // targetSpeedも連続的に絞られていき、閾値をまたぐ瞬間の
    // 不連続な切り替えが起きない。速度がその目標を上回れば
    // speedErrorが自然に負になりブレーキ側に働くので、フルブレーキ
    // 分岐を別途持つ必要も無くなる。
    const maxDecel = this._estimateMaxLinearDecel(ship);
    // 艦のローカルZ速度のうち進入軸成分を「接近速度」として扱う
    // （ローカルZは-1が前進方向なので、-approachAxisLocal.zの符号に注意
    // する必要はなく、velAlongをそのまま接近速度の代理として使う—
    // alongDistが正のとき艦は目的地の手前にいるので、alongDistを
    // 減らす方向＝velAlongが正の方向が「接近している」に対応する）。
    const closingSpeed = velAlong;
    const remainingDist = Math.max(0, alongDist);

    if (remainingDist > this.DOCKING_POSITION_MIN_DISTANCE) {
      // 「この残り距離でちょうど止まり切れる」速度を物理的な安全上限とし、
      // 姿勢合わせ優先の巡航速度上限（maxSpeed×RATIO）と比べて小さい方を
      // 目標接近速度にする。DOCKING_FINAL_APPROACH_BRAKE_MARGINで少し
      // 手前から絞り始めることで、理論値ぎりぎりまで詰めてオーバー
      // シュートすることも防ぐ。
      const physicalSafeSpeed = Math.sqrt(
        2 * maxDecel * remainingDist * this.DOCKING_FINAL_APPROACH_BRAKE_MARGIN
      );
      // v28: 艦種によってmaxSpeedが大きく異なるため、比率(RATIO)だけに
      // 頼ると距離200時点の巡航速度が艦によって過大になりオーバー
      // シュートの一因になっていた。絶対値の上限(MAX_SPEED_ABS)も
      // 併せてクランプする。
      const cruiseSpeed = Math.min(
        ship.maxSpeed * this.DOCKING_FINAL_APPROACH_MAX_SPEED_RATIO,
        this.DOCKING_FINAL_APPROACH_MAX_SPEED_ABS
      );
      const targetSpeed = Math.min(cruiseSpeed, physicalSafeSpeed);

      const speedError = targetSpeed - closingSpeed;
      // v28: 固定基準(40)ではなく艦の減速性能に応じたスロットル基準を
      // 使う（_computeFinalApproachThrottleErrorRef参照）。これにより
      // 「速度差が少し出ただけで即フル主機関」を防ぎ、ブレーキ側も
      // 同じ基準で滑らかに効くため喧嘩が起きにくくなる。
      const throttleErrorRef = this._computeFinalApproachThrottleErrorRef(maxDecel);
      let thrustStrength;
      if (speedError >= 0) {
        thrustStrength = clamp(speedError / throttleErrorRef, -1, 1);
      } else {
        // v28: 速度超過側は緊急度ベースのブレンドブレーキに委ねる
        // （_blendFinalApproachBrake参照）。目標速度がremainingDist→0で
        // 0に張り付いても、間に合わなくなりそうなら滑らかにフル
        // ブレーキへ寄っていくため、通常の比例制御だけでは間に合わず
        // 通り越していた問題を解消する。
        thrustStrength = this._blendFinalApproachBrake(
          speedError,
          closingSpeed,
          remainingDist,
          maxDecel,
          throttleErrorRef
        );
      }
      // v21: 勢いキル退出直後は加速側だけクールダウン倍率で絞る
      // （減速側=thrustStrength<0はそのまま。既に速すぎる場合の
      // ブレーキを弱めては本末転倒なので、絞るのは正方向のみ）。
      if (thrustStrength > 0) {
        thrustStrength *= this._tickApproachCooldownMultiplier(ship, dt);
        // v21: headingHold中（姿勢がまだ整っていない状態でこの
        // 関数が呼ばれた場合）は加速側をforwardDampingでさらに
        // 絞り、その場に留まりながら回頭を優先させる。ブレーキ側
        // (thrustStrength<0、通り越し防止)には掛けない。
        if (forwardDamping !== undefined) {
          thrustStrength *= forwardDamping;
        }
      }
      const approachDirLocal = vecScale(approachAxisLocal, thrustStrength);
      desiredForce.x += approachDirLocal.x;
      desiredForce.y += approachDirLocal.y;
      desiredForce.z += approachDirLocal.z;
    } else {
      // v25: 「目的地にほぼ到達」の残留速度制動。
      //
      // 旧実装はMath.sign(closingSpeed)で常にフル出力(±1)のブレーキを
      // かけていた。これだと1つ上の分岐（比例制御、通常は小さな出力）
      // との境界(DOCKING_POSITION_MIN_DISTANCE=0.15)を艦がわずかに
      // 前後するだけで、「小さな比例出力」⇔「符号だけを見た全力出力」が
      // 不連続に入れ替わり、主機関と逆噴射がフルパワーで交互に切り替わる
      // 発振の原因になっていた（報告された不具合の本体）。
      //
      // 対策: ここでも同じ比例制御を使う（目標速度0への収束）。
      // 速度が小さいほど出力も小さくなるので、1つ上の分岐との境界
      // でも出力の大きさが連続につながり、不連続なフル出力への
      // 切り替わりが起きない。
      // v28: 基準をFORWARD_VELOCITY_FULL_THROTTLE_ERROR固定値から
      // 艦の減速性能ベースのthrottleErrorRefに統一し、速度超過側は
      // 上の分岐と同じ_blendFinalApproachBrakeを使う（remainingDistは
      // ここでは0付近の実際値をそのまま渡す）ことで、
      // DOCKING_POSITION_MIN_DISTANCEの境界をまたいでも出力が
      // 連続につながるようにする。
      const speedError = -closingSpeed; // 目標速度0
      const throttleErrorRef = this._computeFinalApproachThrottleErrorRef(maxDecel);
      let thrustStrength =
        speedError >= 0
          ? clamp(speedError / throttleErrorRef, -1, 1)
          : this._blendFinalApproachBrake(
              speedError,
              closingSpeed,
              remainingDist,
              maxDecel,
              throttleErrorRef
            );

      // v28: 「ほぼ到達」判定に入った瞬間、艦の性能によっては1フレームで
      // MIN_DISTANCEを大きく飛び越すことがあり（減速力の強い艦ほど
      // 顕著）、この分岐は元々速度制動のみで位置は見ていなかったため、
      // 飛び越した分の位置ズレが永続的に残ってしまっていた。alongDist
      // （クランプ前の符号付き値、負＝通り越し）がMIN_DISTANCEを超えて
      // いる間は、速度制動に軽い位置復帰力を上乗せしてじわじわ戻す
      // （急な押し戻しで再度通り越さないよう、比例制御のまま弱めに）。
      if (alongDist < -this.DOCKING_POSITION_MIN_DISTANCE) {
        const overshootDist = -alongDist;
        const positionCorrection = clamp(
          overshootDist / this.DOCKING_LATERAL_CORRECTION_FULL_THRUST_OFFSET,
          0,
          1
        );
        // 通り越した先(alongDist<0)から目的地へ戻るには、進入軸方向
        // (approachAxisLocal、前進方向)と逆＝マイナス側の推力が要る。
        thrustStrength = clamp(thrustStrength - positionCorrection, -1, 1);
      }
      const brakeDirLocal = vecScale(approachAxisLocal, thrustStrength);
      desiredForce.x += brakeDirLocal.x;
      desiredForce.y += brakeDirLocal.y;
      desiredForce.z += brakeDirLocal.z;
    }

    desiredForce.x = clamp(desiredForce.x, -1, 1);
    desiredForce.y = clamp(desiredForce.y, -1, 1);
    desiredForce.z = clamp(desiredForce.z, -1, 1);
  },
};
