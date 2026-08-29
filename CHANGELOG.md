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

## v50より前

このファイルが存在する前の変更履歴は、各JSファイルの冒頭・該当箇所の
コメント（`// v27:`, `// v46:`, `// v47:` … のような形式）にまとまって
います。特に自動ドッキング操縦まわりは `03-thruster-solver.js` の
`_buildDesiredForAutoDocking` 周辺コメントに、v46でのゼロベース再設計
の経緯を含めて詳しく書かれています。
