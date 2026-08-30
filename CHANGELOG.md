# 変更履歴

このファイルは、宇宙船シミュレーターの変更内容を記録していきます。
v50以降、変更のたびにここへ追記していく想定です（それ以前の経緯は
各JSファイル冒頭・該当箇所のコメントに散在しています）。

---

## v50 - 2026-08-29

### 修正: 自動ドッキング操縦

- **距離300ブレーキポイント（brake300）: 「距離300で停船する」ように修正**
  - 症状: 距離300に到達してからブレーキを始める形になっており、
    「距離300から止まろうとする」体感になっていた。
  - 原因: 直前のadjustフェーズ（distance 500→300）の減速基準が
    target.positionそのもの（distance=0）になっており、distance=300を
    跨ぐ時点でもまだ「制動距離の余裕」が残っていたため、そこまでに
    十分減速し切れていなかった。
  - 対応: adjustフェーズの減速基準を「distance=300までの残り距離」に
    変更（`03-thruster-solver.js` の `_runApproachPhase` に
    `stopAtDistance` パラメータを追加し、adjust呼び出し時のみ
    `ZONE_BRAKE300`(300) を渡す）。distance=300へ到達する時点でほぼ
    速度0まで収束するようになり、brake300は最後の微調整（厳密な
    軸合わせ・姿勢合わせ）だけで済むようになった。approachフェーズ
    （800→500）の挙動は変更なし。

- **距離250ブレーキポイント（brake250）→ 最終進入をスキップして
  即座に入港・固定されてしまう不具合を修正**
  - 症状: distance=250付近で条件（速度・姿勢誤差・角速度）を満たすと、
    トンネル内の最終進入（250〜0での前進・整列）を経ずに、その場で
    いきなり入港・固定されてしまっていた。
  - 原因: tunnelフェーズ中の入港固定判定が「入港判定基準
    （`_meetsArrivalCriteria`: 速度・姿勢誤差・角速度のみ、distanceは
    見ない）を満たすかどうか」だけで行われていた。brake250からtunnelへ
    切り替わった直後は、まだdistanceが200〜250のどこかにあるにも
    かかわらず、brake250側で既に速度・姿勢を収束させ切っていることが
    多く、tunnel本来の前進スラスト（距離200地点で目標速度3.0まで
    再加速する設計）が一度も働く前の同一フレームで即座に固定されて
    しまっていた。
  - 対応: 設計書の「入港: distance ≤ 200（ZONE_FINAL_APPROACH）かつ
    入港判定達成」に合わせ、固定判定に
    `distance <= params.ZONE_FINAL_APPROACH` の条件を追加。
    `_meetsArrivalCriteria` 自体は変更していない（brake250→tunnel
    遷移判定と共用しており、そちら側にdistance条件を混ぜると別の
    不具合が再発するため。v47〜v49の経緯としてコード内コメントに
    詳細あり）。

### 修正: `alongDist`の符号バグ（手前側/奥側が反転していた）
- 症状: 正常に手前側から接近しているだけの艦が、巡航中いきなり
  `return_to_axis`（奥側からの回り込み専用フェーズ）に送られ、
  target.positionを挟んで反対（奥）側の地点へ誘導されてしまう
  ＝実質的に逆走に見える挙動になっていた。
- 原因: `_buildDesiredForAutoDocking`・`_runBrakePhase`内の
  `alongDist = vecDot(toTargetWorld, approachAxisWorld)`
  （`toTargetWorld = target.position - ship.position`）が、
  設計書の「プラス＝手前側、マイナス＝奥側」と符号が逆になって
  いた（手前側の艦でマイナスになる）。`_runApproachPhase`内の
  `shipAlong`も同じ式の変形で同じ向きに符号が反転していた
  （不要な先頭の`-`が原因）。
- 対応: `toTargetWorld`への生の投影値（lateralVec分解に必要）と、
  ゾーン判定に使う符号付き`alongDist`（設計書の符号規約に合わせて
  反転）を分離。`shipAlong`は先頭の`-`を削除して修正。
  `_resolveDockingPhase`側のロジック・比較（`alongDist<0`＝奥側等）
  はコード内コメントの意図通りだったため変更なし。

### バージョン表記
- `GAME_VERSION`（`01-state-and-config.js`）および `index.html` の
  `<title>` を v49 → v50 に更新。

---

## v50-fix2 - 2026-08-29

### 修正: `return_to_axis`から永久に抜けられない不具合（v50-fixの符号再反転バグ）

- **症状**: 進入軸の奥側から回り込む`return_to_axis`フェーズに入ると、
  艦は迂回中間地点（`target.position`から手前側へ750の固定点）へ
  物理的にはほぼ正確に到達しているにもかかわらず、いつまで経っても
  `return_to_axis`から抜けられず「進入軸へ回り込み中」のまま張り
  付き続ける（HUD表示上は`alongDist`が-750付近で反復しているように
  見えた）。
- **原因**: 直前のv50-fixが、上のセクション（55〜65行目）の説明とは
  逆に、実際には**正しかった符号を再び反転させてしまっていた**。
  `rawAlong = vecDot(toTargetWorld, approachAxisWorld)`
  （`toTargetWorld = target.position - ship.position`）は、艦が
  手前側にいるとき既にプラスになる（v50-fixのコメントの前提が誤り
  だった）。それを`alongDist = -rawAlong`としてしまったことで、
  手前側にいるほど`alongDist`がマイナスに振れる形になっていた。
  `return_to_axis`の離脱条件は`alongDist >= 750`（迂回中間点に
  十分近づいたら抜ける）だが、この符号バグにより艦がどれだけ目標点
  に近づいても`alongDist`は-750付近にしか届かず、条件を満たすことが
  なかった。実測ログ（ドッキングログDL機能で採取）でも、艦の
  `returnTargetDist`（目標点までの実距離）は約8まで縮まっていたのに
  `alongDist`は-749のまま推移していたことを確認した。`_runApproachPhase`
  内の`shipAlong`（v50-fixで符号修正を試みた箇所）も同様に、実際には
  逆方向へ直してしまっていた。
- **対応**: `03-thruster-solver.js`内の3箇所を修正。
  - `_buildDesiredForAutoDocking`: `alongDist = -rawAlong` →
    `alongDist = rawAlong`（符号反転を削除）
  - `_runApproachPhase`: `shipAlong = vecDot(toShip, approachAxisWorld)` →
    `shipAlong = -vecDot(toShip, approachAxisWorld)`（`toShip`は
    `toTargetWorld`と逆ベクトルのため、`alongDist`と同じ規約に揃える
    には反転が必要）
  - `_runBrakePhase`: 未使用の`alongDist`変数だが規約統一のため同様に
    修正
- **調査用に追加した機能**: `03-thruster-solver.js`に
  `ThrusterSolver._dockingLog`（直近フレームのフェーズ・distance・
  alongDist等を貯めるリングバッファ）と`06-hud.js`に「ログDL」
  ボタン（画面右上、CSVダウンロード）を追加。今後同種の不具合が
  出た場合の調査に使えるよう恒久的に残す。

---

## v50-fix3 - 2026-08-29

### 修正: brake300・brake250でオーバーシュートした位置に停止してしまう不具合

- **症状**: 距離300ブレーキポイント・距離250ブレーキポイントの両方で、
  ちょうどその距離でピタリと止まらず、行き過ぎた（あるいは届く前の）
  位置でそのまま停止してしまう。体感として「distance=300や250で
  ブレーキをかけ始めている」ように見える。
- **原因**: 2つ複合していた。
  1. `_runBrakePhase`（brake300/brake250共通の実装）は、前後方向
     （進入軸方向）について「その時点の速度を0にする」ブレーキのみ
     行っており、目標distance（300 or 250）へ位置そのものを戻す
     制御が存在しなかった。直前のフェーズの事前減速で理論上は
     ちょうどそのdistanceで速度が0になるよう作られていても、
     フレーム単位の誤差や安全マージンの影響でわずかに行き過ぎた
     （またはまだ届いていない）位置・速度でbrake300/250へ切り替わる
     と、そのズレがそのまま最終停止位置として固定されてしまって
     いた。横方向（lateral）は`_applySettlingForce`で位置・速度とも
     0へ収束する制御が既にあったが、前後方向には同様の仕組みが
     なかった。
  2. `_runFinalApproachAdjustPhase`（final_approach、distance
     300→250）は減速の基準を`target.position`（distance=0）に
     していたため、distance=250に到達する時点でもまだ「制動距離の
     余裕」が残っており、速度が十分に落ちきらないままbrake250へ
     突入していた（adjustフェーズがdistance=300を基準にしていな
     かった旧不具合と同種の原因）。
- **対応**: `03-thruster-solver.js`を修正。
  - `_runBrakePhase`に`targetDistance`引数を追加し、前後方向にも
    横方向と同じ`_applySettlingForce`を使った位置・速度収束制御を
    追加。目標点は「進入軸上、艦の現在の横ズレを保ったまま、
    distance=targetDistanceになる点」とし、前後方向だけを動かす。
    呼び出し側（`brake300`は`params.ZONE_BRAKE300`、`brake250`は
    `params.ZONE_BRAKE250`）でそれぞれ渡す。完了判定
    （`onSettled`呼び出し条件）にも前後方向の位置誤差
    （`DOCKING_POSITION_MIN_DISTANCE`以内）を追加。
  - `_runFinalApproachAdjustPhase`に`distance`引数を追加し、
    `_applyApproachForce`の`stoppingDistanceForCapOverride`に
    `distance - params.ZONE_BRAKE250`（残り距離）を渡すよう変更。
    adjustフェーズの`stopAtDistance`と同じ考え方で、distance=250へ
    到達する時点でほぼ速度0になるよう事前減速する。
- 簡易シミュレーションで、distance=280（意図的に20行き過ぎた状態）
  からスタートしても、最終的にdistance≈300・速度≈0.09まで収束する
  ことを確認済み。

---

## v50-fix4 - 2026-08-29

### 修正: tunnel内でbrake300・brake250・tunnelを永久に往復し続ける不具合

- **症状**: 最終進入（トンネル内、distance 200〜250付近）で、
  「tunnel→brake300→brake250→tunnel→…」を無限に繰り返し、
  distanceがある一点（実測ログではdistance≈208付近）に張り付いた
  まま先へ進めなくなる。
- **原因**: `_resolveDockingPhase`内のtunnel/overshoot継続判定に、
  「`alongDist>=0`に戻った（トンネル内に留まったまま通過しなかった）
  場合は通常通りtunnelとして扱う」という意図のコメントはあったが、
  実際にそれを実行するコードが書かれておらず、この分岐を素通りして
  下の通常ゾーン判定（cruise/approach/adjust/brake300...の距離
  しきい値だけを見る判定）に落ちてしまっていた。distance<=
  ZONE_BRAKE300(300)の判定は「`_dockingBrake300Done`がfalseなら
  無条件でbrake300」という単純なものだったため、tunnel中の艦
  （distance 200前後）がこの判定に落ちるたびにbrake300へ
  引き戻されていた。さらに、`brake250→tunnel`遷移時に
  `_dockingBrake300Done`を「次回入港に備えて」falseへリセットする
  処理があり、これがtunnel突入直後という早すぎるタイミングで
  行われていたため、tunnel内で一時的にbrake250へ差し戻される
  （横ズレの微小な再発等）ことがあると、その後上記のbrake300誤
  遷移が発生する条件が整ってしまっていた。
- **対応**: `03-thruster-solver.js`の`_resolveDockingPhase`を修正。
  - tunnel/overshoot継続判定に、`alongDist>=0`かつ
    `distance<=ZONE_FINAL_APPROACH(200)`の場合は明示的に`tunnel`を
    返す分岐を追加（コメントが元々意図していた挙動を実装した）。
  - `_dockingBrake300Done`のリセットを`brake250→tunnel`遷移時
    （時期尚早）から削除し、実際に`docked`へ到達したあとそこから
    離脱する時点でのみリセットするよう変更（既存の`docked`離脱
    リセット処理はそのまま活用）。これにより、tunnel内で一時的に
    brake250へ差し戻されても、一度完了したbrake300が無条件に
    再要求されることはなくなる。
- 実測ログで、上記2つの不具合により艦がdistance≈208.29に張り付いた
  まま`tunnel`→`brake300`→`brake250`を17ms周期程度で無限に往復して
  いたことを確認済み。

### 修正: 猛スピードのままdistance=300/250へ突っ込みオーバーシュートする不具合

- **症状**: 巡航でかなりの速度まで加速したあと、approach・adjustの各
  ゾーンに入ってもほとんど減速しきれないまま距離300・250へ到達し、
  ブレーキポイントを大きく行き過ぎる（v50-fix3の位置補正で最終的には
  戻ってくるが、オーバーシュート量自体が大きい）。
- **原因**: cruise（distance>800）の速度上限先読みロジック
  （`CRUISE_BRAKE_LEAD_DISTANCE`＝固定1200）が、艦の実際の制動能力
  （`_estimateMaxLinearDecel`）と無関係な固定距離で「無制限→
  approach上限」を線形補間していたため、最高速度が高く／制動力が
  相対的に低い艦種では、この固定距離では全く間に合わなかった。
  実測ログでは、艦がcruise中に最高速度267.8まで達したあと、
  cruise→approach境界(distance=800)に到達した時点でもまだ216.1もの
  速度が残っていることを確認した。さらに、`_applyApproachForce`の
  速度上限超過時のブレーキが常に「超過量に比例した緩やかなブレーキ
  （over/40、40未満は弱いブレーキしかかからない）」だったため、
  大きく超過した状態から強くブレーキが立ち上がるまでにも距離を
  消費してしまい、減速の遅れに拍車をかけていた。approachフェーズ
  （800→500）自体もdistance=500での事前減速（stopAtDistance）を
  指定しておらず、adjustへ速度超過を持ち越す一因になっていた。
- **対応**: `03-thruster-solver.js`を修正。
  - `_applyApproachForce`: 速度上限超過時、超過分が
    `speedCap`（巡航速度の目安、`maxBrakingDistanceOverride`由来）
    ではなく`stoppingSpeedCap`（目的地・ゾーン境界への物理的な
    制動距離から来る上限）を超えている場合は、超過量に関わらず
    問答無用でフルブレーキ（`brakeStrength=1`）にするよう変更。
    `stoppingSpeedCap`超過は「今すぐ全力で止まらないと物理的に
    間に合わなくなる」状況を表すため、比例ブレーキで様子を見る
    のは危険側だった。
  - `_runCruisePhase`: 艦の制動能力と無関係な固定距離
    （`CRUISE_BRAKE_LEAD_DISTANCE`）による先読み補間を廃止。
    代わりに`_applyApproachForce`の`stoppingDistanceForCapOverride`
    に「distance − ZONE_APPROACH_START（境界までの残り距離）」を
    渡す方式に変更。艦の実際の制動能力から逆算されるぶん、
    艦種によらず「境界到達時にちょうど速度0近くになる」よう自然に
    減速プロファイルが決まる（adjust/final_approachが既に採用して
    いる`stopAtDistance`と同じ考え方をcruiseにも適用した形）。
    未使用になった`CRUISE_BRAKE_LEAD_DISTANCE`・
    `CRUISE_UNRESTRICTED_BRAKING_DISTANCE`は削除。
  - `approach`呼び出しに`stopAtDistance=params.ZONE_ADJUST_START`
    (500)を追加。distance=500（adjust開始）でほぼ速度上限まで
    減速し切っておくことで、adjust以降へ速度超過を持ち越しにくく
    した（adjustが`stopAtDistance=ZONE_BRAKE300`を使っているのと
    同じ考え方）。
- 艦の制動性能を`maxDecel=15`と仮定した簡易シミュレーションで、
  distance=4000から加速・減速を通しで走らせた結果、cruise→approach
  境界(800)到達時に速度0.75、approach→adjust境界(500)到達時に
  速度0.96、adjust→brake300境界(300)到達時に速度0.52まで収束する
  ことを確認済み（修正前は800到達時点で200超の速度が残っていた）。

---

## v50より前

このファイルが存在する前の変更履歴は、各JSファイルの冒頭・該当箇所の
コメント（`// v27:`, `// v46:`, `// v47:` … のような形式）にまとまって
います。特に自動ドッキング操縦まわりは `03-thruster-solver.js` の
`_buildDesiredForAutoDocking` 周辺コメントに、v46でのゼロベース再設計
の経緯を含めて詳しく書かれています。
