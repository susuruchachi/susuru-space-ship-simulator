# 変更履歴

このファイルは、宇宙船シミュレーターの変更内容を記録していきます。
v50以降、変更のたびにここへ追記していく想定です（それ以前の経緯は
各JSファイル冒頭・該当箇所のコメントに散在しています）。

---

## v63 - 2026-08-30

### 追加: ドッキングポートごとの3Dモデル読み込み・保存

- **症状**: port-builder.htmlにはそもそもポートの3Dモデルを読み込む
  UIが存在しておらず（GLTFLoader/OBJLoader/MTLLoaderのスクリプト
  タグ自体が抜けていた）、「読み込みができない」状態だった。
- **対応**: 艦船建造画面（ship-builder.html/09-ship-builder.js）と
  同じ方式で、ポートごとにGLB、またはOBJ+MTL(+テクスチャ)の3Dモデルを
  読み込み・保存・削除・差し替えできるようにした。
  - port-builder.htmlに、ビューポート上に重ねる形でモデル読込UI
    （フォーマットタブ、ファイル選択、ドラッグ&ドロップ、読込ボタン）
    と、調整パネル（回転X/Y/Z、スケール[自動フィット付き]、位置
    オフセット、リセット/差し替え/削除ボタン）を追加。
  - 保存はIndexedDB（`spaceSimPortModels`、艦モデルと同じ仕組み）を
    portId単位で使用（01-state-and-config.jsに
    `loadPortModelData`/`savePortModelData`/`removePortModelData`を
    追加）。ポート自体（名前・位置・姿勢、`spaceSimDockingPorts`）とは
    別データとして保持し、ポート削除時にあわせて削除する。
  - ゲームプレイ中（index.html）は、10-docking-platform.jsが現在の
    入港目的地(State.dockingTarget)を保存済みポート一覧と位置・姿勢
    で照合し、一致するポートにモデルが保存されていれば読み込んで
    ゲート内に表示する。一致しない場合やモデル未設定の場合は従来通り
    簡易ゲート表示のみ。

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

## v50-fix5 - 2026-08-29

### 修正: 「final_approachからtunnelへ切り替わらない」不具合（v50-fix4のtunnel継続修正が過剰だった）

- **症状**: distance=250付近まで来ても`final_approach`から`tunnel`
  （最終進入）へ進めず、その場に留まり続ける。
- **原因**: v50-fix4で追加したtunnel/overshoot継続判定
  （「`alongDist>=0`に戻った場合は通常通りtunnelとして扱う」を実際に
  実装した箇所）の継続条件を誤って
  `distance<=ZONE_FINAL_APPROACH(200)`としてしまっていた。設計上
  `tunnel`は`brake250→tunnel`遷移によって`distance>200`かつ`<=250`
  の範囲で開始するフェーズであり、200という値は「トンネル内を
  さらに200まで進んだら入港」という入港達成の目安に過ぎない。
  この誤った200という条件のせいで、tunnel突入直後
  （distance 250〜200の間）は継続条件を満たせず、下の通常ゾーン
  判定（`distance>250`なら`final_approach`）に落ちてしまい、
  「`tunnel`→`final_approach`」への逆戻りが発生していた。
  `final_approach`側の事前減速（v50-fix3で追加）はdistance=250
  ちょうどで速度をほぼ使い切る設計になっているため、一度
  `final_approach`へ押し戻されると再びtunnelへ進むだけの速度が
  出せなくなり、distance=250付近に張り付いたまま動けなくなって
  いた。実測ログでは、`brake250→tunnel`への正規の遷移自体は成功して
  いたが、その直後に`tunnel↔brake250`を細かく往復しながらdistanceが
  250をわずかに超え、最終的に`final_approach`へ戻ってそこで停止する
  様子を確認した。
- **対応**: `03-thruster-solver.js`の`_resolveDockingPhase`を修正。
  tunnel継続の条件を`distance<=ZONE_FINAL_APPROACH(200)`から
  `distance<=ZONE_BRAKE250(250) かつ distance>ZONE_FINAL_APPROACH
  (200)`に変更。これにより、tunnel突入直後（distance 250〜200）は
  無条件でtunnelを継続し、distance<=200になったら本来の詳細な
  tunnel判定ブロック（`lateral`が大きい場合にbrake250へ差し戻す
  安全策を含む）にそのままフォールスルーする。単純に
  `distance<=250`全体を無条件tunnel継続にしなかったのは、それだと
  200以下の範囲でも`lateral`チェックを迂回してしまい、横ズレが
  残ったままトンネル内に留まり続けてしまう別の不具合を生むため。
- 実測ログで、`tunnel→brake250`遷移が起きていた全箇所
  （14件）を確認したところ、いずれも`distance`は249.99台
  （200超）、`lateral`は0.0087〜0.0099（許容値0.15を大きく下回る）
  であり、`lateral`超過が原因ではなく、上記のtunnel継続条件の
  範囲設定ミスが直接の原因だったことを裏付けた。

---

## v51 - 2026-08-30

### 修正: `tunnel`と`final_approach`の間でdistance=250付近を永久に往復する不具合（v50-fix5のtunnel継続条件がなお不十分だった）

- **症状**: `brake250→tunnel`への遷移自体は成功するが、直後に
  `tunnel→final_approach→brake250→tunnel→…`を繰り返し、
  トンネル内へ実質的に進めないまま距離250付近で振動し続ける。
  外から見ると、最終進入で逆方向へ戻ろうとしている、あるいは
  距離250で止まったまま動かなくなっているように見える。
- **原因**: v50-fix5で追加したtunnel継続条件
  `distance<=ZONE_BRAKE250(250) かつ distance>ZONE_FINAL_APPROACH(200)`
  には、境界ちょうど（250）に強く依存する欠陥が残っていた。
  `brake250`から`tunnel`へ切り替わった直後、`brake250`側の位置収束
  制御の余韻（慣性のわずかな揺り戻し）により、distanceが一瞬
  250.00をわずかに超えて押し戻されることがアップロードされた
  操縦ログ（docking-log-2026-08-30T06-06-43-039Z.csv）で確認できた
  （例: t=174976で250.0018、そこから250.0039、250.0061…と
  微増しながら250を超え続ける）。distanceが250を超えた瞬間、
  v50-fix5の継続条件（`<=250`）を満たせなくなり、下の通常ゾーン
  判定（`distance>250`なら`final_approach`）に落ちて`tunnel`の
  前進プロファイルが失われる。`final_approach`側の事前減速で
  速度をまた失った状態で`brake250`へ戻り、そこの位置収束が再び
  わずかに押し出す…という循環が、実測ログでは同一セッション内で
  6回以上連続して発生し、往復のたびにわずかに速度が積み上がって
  いく（0.112→0.132→0.139→0.143→0.157→0.169→0.184、いずれも
  m/s）不安定な振動として記録されていた。
- **対応**: `03-thruster-solver.js`に`TUNNEL_REENTRY_TOLERANCE`
  （許容マージン、1.0）を新設し、tunnel継続条件を
  `distance<=ZONE_BRAKE250+TUNNEL_REENTRY_TOLERANCE かつ
  distance>ZONE_FINAL_APPROACH`に変更。実測された揺り戻し幅
  （±0.01オーダー）に対して十分な余裕を持たせることで、
  正規のtunnel内制動による小さな前後動ではtunnelから脱落せず、
  外力等による本当に大きな押し戻し（250+1.0を超える場合）のみ
  通常ゾーン判定に委ねるようにした。
- 教訓: 「distance<=250」のような境界ちょうどの等号条件を、
  同じ境界付近で発生しうる制御自身の微小な揺り戻し（オーバー
  シュート）の継続判定に使うと、揺り戻しのたびに条件の内外を
  跨いでフェーズが往復してしまう。境界依存の継続判定には、
  実測される揺り戻し幅を上回る許容マージンを持たせること。

---

## v52 - 2026-08-30

### 修正: tunnel（最終進入）フェーズが目的地と逆方向へ加速し続ける符号バグ

- **症状**: `brake250→tunnel`への遷移後、艦が目的地へ向かわず逆方向
  （進入軸の手前側）へ徐々に加速していき、最終的にdistance/alongDist
  が250を大きく超えて（実測ログで255.5まで）final_approachへ押し
  戻される。傍目には「最終進入で逆向きに進もうとしている」ように
  見える。v51で追加したTUNNEL_REENTRY_TOLERANCE（許容マージン1.0）
  では吸収しきれないほど大きく・持続的に逆走するため、v51時点でも
  症状が再現していた。
- **原因**: `_runTunnelPhase`内の目標速度ベクトル計算
  `targetVelWorld = vecScale(approachAxisWorld, -targetSpeed)`の符号が
  逆だった。`approachAxisWorld`は`_buildDesiredForAutoDocking`の
  `alongDist`計算（艦が手前側にいるとき`dot(toTargetWorld,
  approachAxisWorld)`が正になる）、および`_runOvershootPhase`の
  「奥方向は`-approachAxisWorld`方向」というコメントの両方から、
  「艦（手前側）から目的地へ向かう方向」を指すことが確認できる。
  したがって目的地へ向かう目標速度は
  `approachAxisWorld * (+targetSpeed)`であるべきところ、`-targetSpeed`
  を掛けていたため、tunnelフェーズは常に目的地とは逆方向（進入軸の
  手前側）へ艦を加速させ続けていた。
  アップロードされた操縦ログ（docking-log-2026-08-30T06-26-24-181Z.csv）
  で、tunnel突入直後からvelZ・alongDistが単調に増加し続け、艦の実際の
  変位ベクトルが目的地方向（toTargetWorld）とちょうど正反対になって
  いることを直接確認して特定した。
- **対応**: `03-thruster-solver.js`の`_runTunnelPhase`で
  `targetVelWorld`の符号を`-targetSpeed`から`+targetSpeed`に修正。
- 教訓: 進入軸方向のベクトル（`approachAxisWorld`）を新しい箇所で
  使うときは、その符号規約（どちらが「目的地へ向かう方向」か）を
  必ず既存コード（`_buildDesiredForAutoDocking`や
  `_runOvershootPhase`など、規約が確立している箇所）と突き合わせて
  確認すること。コード内コメントの言葉（「マイナス方向＝目的地へ
  向かう方向」）を鵜呑みにせず、実測ログの位置・速度データで実際の
  移動方向を検証したことで発見できた。

---

## v53 - 2026-08-30

同一の操縦ログ（docking-log-2026-08-30T07-21-13-972Z.csv）から3件の
不具合を特定・修正。

### 修正1: オーバーシュート通過（overshoot）の符号バグ

- **症状**: トンネル内でオーバーシュートし奥側へ抜けていく際、
  「奥方向へ主機で押し出す」はずが、実際には目的地側（手前方向）へ
  ブレーキがかかっているように見える。
- **原因**: `_runOvershootPhase`の「奥方向(-approachAxisWorld方向)」
  という符号規約がv52で確定した規約（approachAxisWorldは艦(手前側)
  から目的地へ向かう方向）と矛盾していた。`outwardSpeed =
  -vecDot(ship.velocity, approachAxisWorld)`と
  `outwardDirWorld = vecScale(approachAxisWorld, -1)`の符号が
  逆だった。ログでは、オーバーシュート突入直後から速度が単調に
  減少し続け、艦の実際の変位方向がapproachAxisWorldと同じ向き
  （＝目的地から見て「奥」に進む方向）になっていることを確認して
  特定した。この回では速度が既に低かったため惰性でたまたま
  目的地へ戻り入港できたが、速度が高い場面では正しく機能しない。
- **対応**: `outwardSpeed`を`+vecDot(...)`に、`outwardDirWorld`を
  `approachAxisWorld`そのもの（+1倍）に修正。

### 修正2: final_approach⇔brake250の往復で距離250付近の姿勢調整が進まない

- **症状**: 距離300・250でのブレーキポイントで、速度・姿勢・角速度が
  HUD上はすでに整っているように見えても、なかなか次のフェーズへ
  進まない（特に距離250での姿勢調整）。
- **原因**: `final_approach`フェーズには、一度`brake250`へ入った後の
  揺り戻しに対する継続判定が存在せず、`distance`が250をわずかに
  超えるたびに無条件で`final_approach`へ差し戻されていた。
  `brake250`側の「入港基準を満たすまで留まる」ロジックは
  `distance<=ZONE_BRAKE250`の内側でしか机上に乗らないため、
  `distance`の緩やかな減衰振動でこの境界を跨ぐたびにリセットされ、
  実質的に`final_approach⇔brake250`を延々往復し続けていた。ログでは
  `meetsArrivalCriteria`が早い段階（t=1427637）でtrueになっていた
  にもかかわらず、その後も長時間（ログ上1回のログ休止を挟み実測で
  100万msのオーダー）`brake250`へ進めていなかったことを確認した。
- **対応**: `final_approach → brake250`遷移の判定に、v50-fix6の
  `TUNNEL_REENTRY_TOLERANCE`と同種の許容マージン
  `BRAKE250_REENTRY_TOLERANCE`（1.0）を追加。`prevPhase==='brake250'`
  かつ入港基準を満たしている場合は、distanceが250+マージンまでの
  範囲で揺り戻してもbrake250を維持するようにした。

### 修正3: 最終進入（トンネル内）の減速が停止直前まで始まらない

- **症状**: トンネル内での減速（逆噴射）が、停止位置に着くまで
  ほとんど始まらず、直前になって急ブレーキがかかる。
- **原因**: 減速プロファイルの基準距離に`FINAL_APPROACH_BRAKING_
  DISTANCE`(10)を使っていたため、トンネル全長200のうち最初の190分は
  目標速度が常に`FINAL_APPROACH_ENTRY_SPEED`(3.0)で頭打ちのまま
  巡航し、残り10単位でのみ0まで減速する「駆け込みブレーキ」に
  なっていた。この定数はv47で「トンネル入口での距離0への瞬間ワープ」
  対策として導入されたものだったが、結果的に減速プロファイルの
  形自体を歪めてしまっていた。ログでは、distance=240付近から10付近
  まで終始speed=3.0000で貼り付いたまま推移し、直前になって初めて
  減速が始まる様子を確認した。
- **対応**: 減速プロファイルの基準距離をトンネル全長
  `ZONE_FINAL_APPROACH`(200)に変更（`v(d) = ENTRY_SPEED *
  sqrt(d / ZONE_FINAL_APPROACH)`）。トンネル突入直後から停止点まで
  一貫して減速し続ける滑らかな曲線になる。物理的な制動距離による
  上限（`physicalSafeSpeed`）と組み合わせる設計は維持。不要になった
  `FINAL_APPROACH_BRAKING_DISTANCE`定数は削除。

---

## v54 - 2026-08-30

戦艦級での実プレイ（docking-log-2026-08-30T07-44-53-871Z.csv）を元に、
速度条件のみの入港固定バグと、重量級艦の姿勢制御の遅さを修正。

### 修正1: 速度が0.5を切った時点で、距離が残っていても停止（固定）してしまう

- **症状**: 戦艦級のような重い艦だと、目的地までまだ距離が残っている
  のに停止扱いになってしまう。
- **原因**: トンネル内での入港固定判定が`distance<=ZONE_FINAL_APPROACH`
  (200、トンネル内かどうかの粗い判定)と`_meetsArrivalCriteria`(速度
  ARRIVAL_SPEED未満・姿勢誤差0.1°以内・角速度0.01未満)のみで行われて
  おり、目的地までの実距離を見ていなかった。アップロードされたログでは、
  `brake250`側で速度が先に0.5を切って`_meetsArrivalCriteria`がtrueに
  なった直後、`distance≈64`というまだ大きく離れた地点で`tunnel`へ
  遷移し、その次のフレームで即座に`distance=0`（入港固定）へワープ
  していることを確認した。戦艦級は制動距離が長いため、速度だけが先に
  閾値を切りやすく、この不具合が顕在化しやすい。
- **対応**: 入港（固定）判定基準に新しい定数`ARRIVAL_DISTANCE`(0.1)を
  追加し、トンネル内の固定判定に`distance<=ARRIVAL_DISTANCE`の条件を
  追加。速度条件を満たしても、目的地までの実距離が0.1を切るまでは
  固定されず、トンネル内の前進プロファイルが働き続けるようにした。
  `_meetsArrivalCriteria`自体は`brake250→tunnel`遷移判定とも共用して
  いるため変更せず（変更するとdistanceが常に200〜250の`brake250`側で
  常にfalseになる不具合が再発するため）、呼び出し側にのみ条件を追加。

### 修正2: 戦艦級・巡洋艦級の距離250付近での姿勢制御が遅い

- **症状**: 戦艦級や巡洋艦級のような重い船は、距離250のブレーキ
  ポイント（brake250）での姿勢合わせが遅すぎる。
- **原因**: RCSスラスターのトルクが艦の慣性モーメントの増大に対して
  スケールしていなかった。艦種プリセットの数値から実効的な角加速度を
  試算すると、rocket級が約4.1 rad/s²なのに対し、cruiser級は約
  0.53 rad/s²、battleship級は約0.23 rad/s²しか出ておらず、
  battleship級はcruiser級の半分以下だった。brake250フェーズは姿勢
  誤差0.1°以内までの精密な収束が必要なフェーズのため、この角加速度の
  低さがそのまま体感の遅さに直結していた。
- **対応**: `01-state-and-config.js`のcruiser級・battleship級の
  RCSスラスター（fwd/aft/mid、ロール用）のmaxThrustを引き上げ。
  cruiser級は5500→9000（ロール用4200→6900）、battleship級は
  16000→42000（ロール用12000→31500）。試算上の角加速度はcruiser級が
  約0.53→0.87 rad/s²、battleship級が約0.23→0.60 rad/s²まで改善（
  battleship級が旧cruiser級を上回る水準）。主機(main)・逆噴射(retro)
  スラスターは変更していないため、直進の加減速性能への影響はない。

---

## v55 - 2026-08-30

### 修正: 仕想ウェイポイントが進入軸の奥側（目的地の向こう側）に置かれていた

- **症状**: yaw角のついたtarget（例: 姿勢角(0, 80°, 0)）へ向かう際、
  艦が進入軸を大きく超えた位置まで飛んでから戻ってくる異常な軌道を
  取る。
- **原因**: `_computeVirtualWaypoint`が、target.positionから進入軸上
  「手前」の点を求めるはずが、符号を誤って`approachAxisWorld`を
  そのまま**加算**していた。`approachAxisWorld`はv52で「艦(手前側)
  から目的地へ向かう方向」と規約が確定しているため、加算すると
  target.positionから見てさらに奥（目的地の向こう側）の点になって
  しまう。yaw=0°付近では奥行き(Z)方向のズレが小さく問題が
  目立たなかったが、yaw=80°のような斜めのtargetでは大きく症状が
  出た。アップロードされたログでは、target.position=(0,500,-4000)
  に対し艦が一時z=-4534付近（targetよりさらに1000近く奥）まで
  飛んでいたことを確認して特定した。直後で同じ考え方を使っている
  `_computeAvoidanceWaypoint`は元々正しく減算していたため、そちらに
  合わせて符号を修正。
- **対応**: `_computeVirtualWaypoint`内の3軸の演算を`+ axis * offset`
  から`- axis * offset`に修正。

---

## v56 - 2026-08-30

### 修正: approach/adjustフェーズで、距離300の停止位置に着くまで軸合わせがほとんど進まない

- **症状**: 距離300〜400（adjustフェーズ）で軸合わせ（進入軸に対する
  横方向の位置ズレ補正）がほとんど進んでおらず、距離300の停止位置に
  実際に到達してからようやく軸合わせが始まっているように見える。
- **原因**: adjust/approachフェーズ（`_runApproachPhase`）の並進制御
  (`_applyApproachForce`)は、「艦の現在の速度ベクトルのうち操舵目標
  方向に対して横向きな成分」をブレーキする仕組みで、これは横方向の
  **位置ズレ**そのものを縮める力ではなかった。艦が姿勢制御で操舵目標
  方向へ概ね正しく向いていれば、この横滑りブレーキの対象となる速度
  成分自体がほぼ0になり、事実上何もしない。横方向の位置ズレを直接
  縮める専用の収束制御(`_applySettlingForce`)は、従来`brake300`/
  `brake250`フェーズでしか呼ばれていなかった。実測ログでは、adjust中
  にdistanceが500→300まで進む間、lateral(横ズレ)が10.7→8.4程度までしか
  縮まらなかったのに対し、brake300に入ってdistanceが300で止まった
  直後の短時間でlateralが8.4→0.2まで一気に収束していたことを確認し、
  「距離300の停止位置にいる間だけ軸合わせが効いている」ことが裏付け
  られた。
- **対応**: `_runApproachPhase`に、進入軸上・艦の現在along位置に対応
  する点を横方向のみの目標点とした`_applySettlingForce`呼び出しを
  追加し、approach/adjust中も常時弱く横方向の位置ズレを縮めるように
  した。前後方向の巡航・減速制御（`_applyApproachForce`が別途担当）
  を乱さないよう、新設のゲイン定数`ADJUST_LATERAL_SETTLE_GAIN`
  (0.15)を使用（brake300/250側の`DOCKING_SETTLE_APPROACH_GAIN`
  (0.5)より弱め）。`_applySettlingForce`にゲインを外部指定できる
  引数を追加し、既存のbrake300/250呼び出しは従来通りデフォルトゲイン
  のまま動作する。

---

## v57 - 2026-08-30

### 修正: approach→adjust境界(distance=500)付近で艦が迷走し、なかなかadjustへ進めない

- **症状**: v55で仮想ウェイポイントの符号を修正した後、艦が仮想
  ウェイポイント付近（distance≈500の少し外側）にいつまでも留まり、
  先へ進まず迷走するようになった。始点・目的地はv55修正前と同じ。
- **原因**: `approach`フェーズは元々「distance=ZONE_ADJUST_START(500)
  でほぼ停止する」設計（`_runApproachPhase`のstopAtDistance引数）
  だったが、`approach→adjust`のフェーズ遷移条件も同じ境界値
  （`distance>500`ならapproach継続、`distance<=500`でadjustへ）を
  使っていた。艦がdistance=500へ収束しようとする制御自体が、収束の
  過程でその値をわずかに上下する（実測ログで500.0〜501.8程度の幅）
  のは通常の挙動だが、境界をわずかに超えるたびに`approach`へ
  押し戻されるため、adjustへ安定して進めないデッドロックになって
  いた。v55で仮想WPの位置自体が正しくなったことで艦がこの境界へ
  正確に収束するようになり、結果としてこのデッドロックが初めて
  顕在化した（v55修正前は仮想WPの位置がずれていたため、艦がこの
  境界付近に長く留まること自体が起きにくく、問題が隠れていた）。
- **対応**: `approach→adjust`境界に新しい定数
  `APPROACH_ADJUST_HYSTERESIS`(8.0)による片側ヒステリシスを追加。
  `prevPhase`が`approach`または`adjust`のいずれかで、distanceが
  `ZONE_ADJUST_START`〜`ZONE_ADJUST_START+APPROACH_ADJUST_HYSTERESIS`
  の範囲にある間は、一度adjustへ入ればadjustのまま、まだapproachの
  ままなら（境界の内側に入った時点で）adjustへ進む形にし、この
  範囲内での往復を止めた。`TUNNEL_REENTRY_TOLERANCE`/
  `BRAKE250_REENTRY_TOLERANCE`と同種の考え方だが、静止ではなく
  「速度上限区間の終端」への収束が対象のため揺り戻し幅がやや大きく、
  マージンもその2つ(1.0)より大きめの値にした。cruiseから直接この
  範囲に入ってきた場合の判定（`prevPhase==='cruise'`）には影響しない。

---

## v58 - 2026-08-30

### 修正: adjust突入直後、艦が仮想ウェイポイント付近で姿勢をグルグルさせて制御を失う

- **症状**: v57の対応後も、distance≈500弱（adjust突入直後）付近で艦が
  ほぼ前進しなくなり、姿勢だけが激しく回転し続けて制御不能に見える。
  始点・目的地はv55/v57修正時と同じ。
- **原因**: `_runApproachPhase`の船首目標は`steerTarget`（通常時は
  `virtualWP`）への方向ベクトル`toSteer`をそのまま使っていた。
  `_computeVirtualWaypoint`は`target.position`から進入軸方向に
  `offset=min(VIRTUAL_WAYPOINT_OFFSET(500), distance)`だけ引いた点を
  返すため、distanceがVIRTUAL_WAYPOINT_OFFSETに近いadjust突入直後は
  `offset≈distance`となり、virtualWPの進入軸方向の位置が艦の現在
  位置とほぼ一致してしまう。この状態で`toSteer`を取ると進入軸方向の
  成分がほぼ相殺され、残るのはlateral（横ズレ）由来のサブメートル
  単位の微小成分だけになる。アップロードされたログでは、この距離帯で
  distance/alongDistが473.3〜473.8にほぼ張り付いたまま、lateralが
  0.02〜0.24の範囲で絶えず振動しており、その振動の向き（艦から見た
  横ズレの方向）自体は物理的な意味を持つが、大きさが小さすぎて
  フレームごとの向きの変化に対して`_applyHeadingTorque`が過敏に
  反応し、angSpeedが1〜3.5rad/sの高い値で張り付き続けていたことを
  確認した。姿勢制御が実際には存在しない「方向の変化」を追いかけて
  グルグル回り続け、その間まともに前進できないため、結果として
  v57で解消したはずのdistance≈500付近の停滞が別の形で再発していた。
- **対応**: `03-thruster-solver.js`に新しい定数
  `HEADING_STEER_STABILIZE_RADIUS`(5.0)を追加。`_runApproachPhase`で
  `steerDist`（steerTargetまでの距離）がこの半径未満のときは、
  船首目標を`toSteer`の向きそのままにせず、`approachAxisWorld`
  （進入軸方向、steerDist=0で100%）と`toSteer`の向き（steerDist=
  HEADING_STEER_STABILIZE_RADIUSで100%）を線形ブレンドした方向に
  差し替えた。境界での不連続なジャンプを避けつつ、目標点に極端に
  近い（＝方向がノイズ支配になる）場面でだけ安定した進入軸方向を
  優先させる。並進側（`_applyApproachForce`/`_applySettlingForce`）
  の挙動には影響しない、と当初は考えていたが、並進側にも同種の
  問題が残っていたことがv59で判明した（下記v59参照）。

### 追加: ドッキングログに目的地と手動操船ステータスを追加

- **要望**: ログに、自動航行開始の目的地と、手動操船のステータスを
  追加してほしい。
- **経緯**: 従来のドッキングログ（`ThrusterSolver._dockingLog`）は
  `_buildDesiredForAutoDocking`内でしか書き込まれておらず、自動操船
  （`ship.autoDockingEnabled`）が実際に動いている間の行しか存在
  しなかった。そのため「艦がグルグルしたのは自動操船中だったのか
  手動操船中だったのか」がログだけからは判別できなかった。
- **対応**:
  - `buildDesiredFromInput`の手動操船側（自動操船が無効、または
    目的地未設定のときのフォールバック分岐）にもログ出力を追加。
    phase/distance/alongDist/lateralなど自動操船固有の物理量は
    意味を持たないため`null`のまま記録し、`manualControl: true`と
    艦の位置・速度・角速度、（目的地が設定済みであれば）その座標
    だけを記録する。
  - 自動操船側の既存ログ呼び出しに`manualControl: false`と、
    `targetPosX/Y/Z`（`State.dockingTarget.position`、＝この行の
    時点で自動航行が目指している目的地の座標）を追加。目的地を
    飛行中に変更した場合の変化も追えるよう、開始時の一回きりでは
    なく毎フレームの値を記録する方式にした。
  - 両方の呼び出しで記録するキーの集合を完全に一致させ（`t`,
    `phase`, `prevPhase`, `distance`, `alongDist`, `lateral`,
    `speed`, `maxLinearDecel`, `posX/Y/Z`, `velX/Y/Z`,
    `returnTargetAlong`, `returnTargetDist`,
    `closingSpeedToReturnTarget`, `dockingBrake300Done`,
    `meetsArrivalCriteria`, `angSpeed`, `manualControl`,
    `targetPosX/Y/Z`の24項目）、CSVダウンロード側
    （`06-hud.js`の`_downloadDockingLog`、`Object.keys(log[0])`で
    ヘッダーを決める方式）で列がずれないようにした。
  - ログが空のときのアラート文言も、手動操船だけでもログが残る
    ようになったことに合わせて更新。

---

## v59 - 2026-08-30

### 修正: v58の姿勢修正後もdistance≈494付近で前進が止まり、じわじわ後退する

- **症状**: v58で姿勢のグルグルは収まったが（angSpeedは0.1台まで
  低下）、adjust突入後にdistance≈493.79まで正常に減速したところで
  前進が止まり、その後velZの符号が数十msごとに反転する微小振動に
  転じ、さらに数十万msかけてdistanceが493.79→497.5超までじわじわ
  後退し続けた。始点・目的地・自動操船の設定はv57/v58修正時と同じ。
- **原因**: v58ではheadingTargetWorld（船首方向）だけをsteerDistに
  応じて安定化したが、`_runApproachPhase`が並進力を組み立てる際に
  `_applyApproachForce`へ渡す目標点には、引き続き未加工の`steerTarget`
  （＝virtualWP/avoidanceWP）をそのまま渡していた。`_applyApproachForce`
  は内部で`targetPosWorld - ship.position`から方向を再計算するため、
  v58で特定したのと同じ理由（distanceがVIRTUAL_WAYPOINT_OFFSET(500)に
  近い場面でvirtualWPが艦の現在位置とほぼ一致し、残るのはlateral由来の
  サブメートル単位のノイズだけになる）で、並進推力の向きも実質ノイズに
  支配されていた。簡易シミュレーションで検証したところ、この状況での
  推力の前進成分（艦から見た目標方向のZ成分）は旧コードで0.004〜0.05
  程度しかなく、大半のスラストが目的地方向ではなくノイズ方向へ
  浪費されていたことを確認した。姿勢は安定していても並進側の推力が
  ほぼ役に立たない向きに出続けるため、慣性で距離が縮んでいる間だけ
  接近できるが、慣性が尽きると次に進む力がなく、横滑りブレーキや
  弱いブレンドの余波でわずかに後退する、という形の停滞になっていた。
- **対応**: `_runApproachPhase`に新しい定数`FORCE_AIM_POINT_DISTANCE`
  (250)を追加。`_applyApproachForce`へ渡す並進の目標点を、
  `steerTarget`ではなく、v58で安定化済みのheadingTargetWorld方向へ
  艦の現在位置からFORCE_AIM_POINT_DISTANCEだけ離した仮想の点
  （`forceAimPoint`）に差し替えた。`_applyApproachForce`の速度上限・
  制動距離判定は目標点自体への距離ではなく別途渡す`stoppingBasisDistance`
  （target.positionへの実距離ベース）で行われるため、この差し替えは
  減速プロファイルには影響せず、推力の「向き」だけをheadingTargetWorld
  に揃える。同シミュレーションで、この対応後の推力の前進成分は
  0.999〜1.0まで安定することを確認した。

---

## v60 - 2026-08-30

### 変更: 最終進入（トンネル内）のエントリー速度を艦の制動能力から動的に算出

- **要望**: 最終進入の速度が（設計通りではあるが）少し遅いので、
  もう少し速くしたい。距離50の範囲で停船しきれる速度にしたい
  （船の重さで変わってよい）。ただし理論値いっぱい（艦種によっては
  約37相当）まで出ると速すぎるので、20を絶対上限にしたい。
- **対応**: `_runTunnelPhase`のエントリー速度（distance=
  ZONE_FINAL_APPROACH(200)地点での目標前進速度）を、従来の固定値
  `FINAL_APPROACH_ENTRY_SPEED`(3.0)から、艦の実際の制動能力
  (`maxDecel`)を使って`_speedForBrakingDistance(maxDecel,
  FINAL_APPROACH_STOPPING_DISTANCE(50))`で毎フレーム動的に算出する
  方式に変更した。`_speedForBrakingDistance`は既存の
  `BRAKE_SAFETY_MARGIN`(0.85)を内部で適用するため、「残り距離50で
  確実に止まれる範囲でできるだけ速く」という要件をそのまま満たす。
  艦が重く（またはスラスターが非力で）maxDecelが小さいほど
  entrySpeedは自動的に低くなり、軽い艦・高出力な艦種ほど自動的に
  速くなる。この逆算値がなお大きすぎる場合に備え、新しい定数
  `FINAL_APPROACH_ENTRY_SPEED_CAP`(20)で絶対上限を追加した（実測で
  maxLinearDecel≈16.25の艦だと逆算値は約37になるため、この艦種では
  常にキャップの20が効く）。減速プロファイル自体の形（distance=200
  でentrySpeed、そこから`sqrt(distance/200)`で0まで減速）や、艦の
  制動能力から出せる安全速度（`physicalSafeSpeed`）との`Math.min`に
  よる二重の安全キャップの構造は変更していない。旧`FINAL_APPROACH_
  ENTRY_SPEED`定数は削除した。

---

## v61 - 2026-08-30

### 新機能: 自作3Dモデルの接舷面（ドッキングフェイス）設定と、オートドッキングでの対応

- **要望**: 自作3Dモデルをドッキングポートに置けるようにしたい。艦船建造画面
  （ship-builder.html）でモデルをインポートしたら、接舷する面をギズモ・
  パラメータで設定できるようにし（艦がピッタリ収まる直方体＝バウンディング
  ボックスの6面から選ぶ）、保存する。その後、目的地が設定されてオートドッキング
  で艦が目的地に到着する際、設定した接舷面と目的地（ポート）の面が一致する
  ように誘導してほしい。

- **艦船建造画面（09-ship-builder.js / ship-builder.html）**:
  モデル調整パネルに「接舷面」セクションを新設。バウンディングボックスの6面
  （±X/±Y/±Z）から接舷させたい面をボタンで選択し、選んだ後は面内オフセット
  （U/V、面の平面上でのズレ）と法線の傾き（傾U/傾V、度）をスライダーで微調整
  できる。選択中は3Dビューに水色半透明パネル＋外向き矢印のギズモを表示し、
  回転・スケール・位置オフセットのスライダー操作にもリアルタイムに追従する。
  設定した接舷面は艦種ごとの保存データ（IndexedDB、既存のadjust＝回転・
  スケール・位置オフセットと同じ場所）に`dockingFace`として追加保存される。
  モデルを差し替え・削除した場合や回転・スケール・位置をリセットした場合は、
  古いモデル形状に基づく接舷面は自動的に解除される（保存済みモデルの復元時は
  保存されていた接舷面もあわせて復元）。

- **接舷面の位置・姿勢計算（01-state-and-config.js）**: 6面それぞれの法線・
  面内u/v軸を`DOCKING_FACE_AXES`として定義し、`computeDockingFaceLocalTransform()`
  で接舷面設定＋バウンディングボックス半寸法から艦ローカル座標系での面の
  位置・姿勢を算出する。この面の姿勢と、目的地（`State.dockingTarget`＝
  「艦の接舷面が最終的に一致すべき港側の位置・姿勢」）から、`computeEffectiveShipDockingTarget()`
  が「艦の重心が実際に目指すべき実効目標」を逆算する。接舷面未設定の艦は
  従来通り艦の重心がそのまま目的地として扱われる（後方互換）。

- **オートドッキング本体（03-thruster-solver.js）への組み込み**: 巨大な
  自動操船ロジック本体（フェーズ判定・接近制御・最終進入等、2000行超）は
  一切変更せず、`_buildDesiredForAutoDocking`冒頭の`target`取得を
  `State.dockingTarget`から`computeEffectiveShipDockingTarget(State.dockingTarget, ship)`
  の戻り値に差し替える1箇所の変更のみで対応した。目的地ゲートの表示
  （10-docking-platform.js）は要望通り変更しておらず、従来通り
  `State.dockingTarget`の位置・姿勢にそのまま表示される（＝ポート自体は
  艦の重心ではなく接舷面が来るべき位置を示す）。

- **付随する表示・保存ロジックの調整**:
  - 予定航路の線（11-approach-visualizer.js `_updateRoute`）は、接舷面が
    ある艦で実際の航路とズレて見えないよう、実効目標を基準に描画するよう
    変更（進入軸・目的地ゲート自体は港座標のままで変更なし）。
  - デバッグHUDの「目的地まで◯◯」の残り距離表示（06-hud.js）も実効目標
    基準に変更（接舷面がある艦で、到着＝dockedになっても距離が0にならない
    という見え方のズレを防ぐため）。
  - HUDの「現在地を目的地として保存」ボタン（06-hud.js）は、接舷面がある
    艦では艦の現在位置・姿勢をそのまま保存するのではなく、「今の位置に
    艦がいるとき接舷面はワールド座標のどこにあるか」を逆算して保存する
    よう変更した。素の艦位置をそのまま保存すると、次にオートドッキング
    した際に艦の重心ではなく接舷面がその座標に来るよう調整されてしまい、
    「今いた場所に戻る」つもりが違う位置に着地することになるため。
    座標を数値で直接指定する「この座標を目的地に設定」ボタンは、指定した
    座標そのものが港（接舷面の目標位置）という意味なので変更していない。

- **クォータニオン合成ユーティリティの共通化**: `axisAngleQuat`/`multiplyQuat`/
  `normalizeQuat`は従来05-ship-controller.js（index.html/settings.html系
  のみ読み込み）にのみ存在したが、接舷面の姿勢計算をship-builder.html側
  （05-ship-controller.jsを読み込まない画面）でも行う必要があるため、
  両画面共通の01-state-and-config.jsへ移設した（定義箇所はここ一箇所のみ、
  05-ship-controller.js側の重複定義は削除）。

---

## v62 - 2026-08-30

### 修正: トンネル内（tunnelフェーズ）の逆噴射が減速プロファイルに全く追いつかない不具合

- **要望**: 「最終進入の速度は今のままでいいんだけど、逆噴射がかけらも追いついてない」
- **症状**: 操縦ログ（distance 250→0のtunnel区間）で速度18.6から4.3まで
  落ちるのに距離177も消費しており、艦の実際の制動能力（maxLinearDecel=16.25）
  からは大きくかけ離れた、極端に緩やかな減速になっていた。
- **原因**: tunnelフェーズの目標速度プロファイル自体（`entrySpeed`/`profileSpeed`）
  は艦の`maxDecel`から正しく逆算されていたが、それを実現するための推力
  （`thrustStrength`）の計算が、目標速度との誤差(`zError`)を
  `FORWARD_VELOCITY_FULL_THROTTLE_ERROR`(40.0、手動スロットル操作向けの
  汎用の分母)で割って求める比例制御になっていた。tunnel区間で生じる速度誤差
  は実測で最大でも18前後にしかならず、常に40より小さいため
  `thrustStrength`が0.5以下に頭打ちになり、艦の制動能力を半分も使い切れて
  いなかった（brake300/brake250側でv49に見つかったのと同種の「汎用分母の
  流用による推力不足」がtunnel側にも残っていた）。
- **対応**: tunnelフェーズの`thrustStrength`計算の分母を、40.0固定値から
  艦の実際の制動能力(`maxDecel`)を基準にした専用値
  （`maxDecel * dt`、1フレームで埋めるべき速度差でフルスロットルになる量）
  に変更（`03-thruster-solver.js` `_runTunnelPhase`）。目標速度プロファイル
  自体（＝最終進入の速度）は一切変更していない。

### 調整: オーバーシュート時の最低速度を引き上げ

- **要望**: 「オーバーシュートの最低速度を20まで上げて」
- **対応**: `DOCKING_OVERSHOOT_MIN_SPEED`を5.0→20.0に変更
  （`03-thruster-solver.js`）。トンネルを通り抜けた後、奥方向速度がこの
  値を下回ると主機で下限速度まで押し出す仕組み自体は変更なし。

### 新機能: ドッキングポート設定画面

- **要望**: v61で艦側の接舷面設定は実装されたが、港（ドッキングポート）側
  の位置・向きを読み込み・セットアップする画面が無かったため実装してほしい。
  設定画面の「艦船建造」ボタンの下に開くボタンを配置し、専用のポート設定
  画面を作ってほしいという依頼。
- **設定画面（settings.html）**: 「艦船建造」セクションの下に「ドッキング
  ポート設定」カードを新設。`port-builder.html`を新しいタブ扱いではなく
  同一画面遷移で開く（艦船建造ボタンと同じ見た目・並び）。
- **ドッキングポート設定画面（port-builder.html / 12-port-builder.js、
  新規）**:
  - 一覧画面: 保存済みポートを名前・座標付きカードで一覧表示。各カードから
    「このポートを使う」（＝自動操船の目的地として即座にセット）、
    「編集」ができる。現在アクティブな目的地と座標が一致するポートには
    「使用中」バッジを表示する。
  - 編集画面: 名前、位置（X/Y/Z、スライダー+数値入力の両対応）、向き
    （ピッチ/ヨー/ロール、度）を調整できる。3Dプレビューには
    `10-docking-platform.js`のゲートメッシュ生成ロジック
    （`DockingPlatform._buildGateMesh()`）をそのまま呼び出して表示して
    おり、ゲームプレイ中に実際に見えるゲートと常に同じ見た目になる
    （独自に複製していないため、将来ゲート形状が変わっても自動的に
    追従する）。ドラッグで視点回転、ホイール/ピンチでズーム可能な
    簡易オービットカメラは艦船建造画面（09-ship-builder.js）と同じ
    自前実装パターンを踏襲。
  - 新規作成・編集・削除に対応。ポート一覧はlocalStorage
    （キー: `spaceSimDockingPorts`、艦の3Dモデルと違って軽量な
    座標・姿勢データのみのため、艦モデルのようなIndexedDBは使わず
    localStorageで十分と判断）に保存する。
- **既存の自動ドッキングとの接続（01-state-and-config.js）**: 複数ポート
  一覧はあくまで「保存庫」であり、実際に自動操船が参照する値は従来通り
  単一の`State.dockingTarget`（`DOCKING_TARGET_STORAGE_KEY`、HUDの
  その場保存・座標直接入力と共有）のまま変更していない。ポート一覧から
  「このポートを使う」を押すと、その座標・姿勢を`State.dockingTarget`へ
  コピーして保存する橋渡しだけを行うため、`03-thruster-solver.js`側の
  巨大な自動操船ロジックは一切変更していない。
- **付随するリファクタ**: 姿勢の度数⇔クォータニオン変換
  （`eulerToQuatSmall`/`quatToEulerDegrees`）は従来
  05-ship-controller.js（index.html/settings.html系のみ読み込み）にのみ
  存在したが、port-builder.html（05-ship-controller.jsを読み込まない
  画面）でも必要なため、v61での`axisAngleQuat`等と同様の理由で両画面
  共通の01-state-and-config.jsへ移設した（定義箇所はここ一箇所のみ）。

---

## v50より前

このファイルが存在する前の変更履歴は、各JSファイルの冒頭・該当箇所の
コメント（`// v27:`, `// v46:`, `// v47:` … のような形式）にまとまって
います。特に自動ドッキング操縦まわりは `03-thruster-solver.js` の
`_buildDesiredForAutoDocking` 周辺コメントに、v46でのゼロベース再設計
の経緯を含めて詳しく書かれています。
