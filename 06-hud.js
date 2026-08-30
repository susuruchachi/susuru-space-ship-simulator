// =============================================================
// 06-hud.js
// 最小HUD: デバッグ情報表示 + タッチスティック用DOM生成
// 設定画面本体はここには含めない（別ファイル settings.html に分離）
// =============================================================

const HUD = {
  _debugEl: null,

  init(domRoot) {
    this._buildTouchControls(domRoot);
    this._buildDebugPanel(domRoot);
    this._buildSettingsLink(domRoot);
    this._buildCameraControls(domRoot);
    this._buildSideMenu(domRoot);
  },

  _buildTouchControls(domRoot) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-touch-controls';
    wrap.innerHTML = `
      <div class="throttle-lever" data-label="throttle">
        <div class="throttle-lever-handle"></div>
        <div class="throttle-lever-label">0%</div>
      </div>
      <div class="stick-move" data-label="move"></div>
      <div class="stick-look" data-label="look"></div>
      <button class="btn-roll-left">ROLL-</button>
      <button class="btn-roll-right">ROLL+</button>
      <button class="btn-boost">BOOST</button>
    `;
    domRoot.appendChild(wrap);

    // ボタン系はタッチ押下状態を dataset.pressed で管理
    // （InputSystem._isPressed() が参照する）
    for (const sel of ['.btn-roll-left', '.btn-roll-right', '.btn-boost']) {
      const el = wrap.querySelector(sel);
      el.dataset.pressed = 'false';
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        el.dataset.pressed = 'true';
      }, { passive: false });
      el.addEventListener('touchend', () => { el.dataset.pressed = 'false'; });
      el.addEventListener('touchcancel', () => { el.dataset.pressed = 'false'; });
      // マウス操作でもテストできるようにフォールバック
      el.addEventListener('mousedown', () => { el.dataset.pressed = 'true'; });
      el.addEventListener('mouseup', () => { el.dataset.pressed = 'false'; });
      el.addEventListener('mouseleave', () => { el.dataset.pressed = 'false'; });
    }
  },

  _buildDebugPanel(domRoot) {
    const el = document.createElement('div');
    el.className = 'hud-debug-panel';
    domRoot.appendChild(el);
    this._debugEl = el;
    this._buildDockingLogButton(domRoot);
  },

  // -----------------------------------------------------------
  // デバッグ用: 自動ドッキングのフェーズ判定に使われた生の物理量
  // （ThrusterSolver._dockingLog）をJSON/CSVでダウンロードする
  // ボタン。原因調査用の一時UI。
  // -----------------------------------------------------------
  _buildDockingLogButton(domRoot) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-docking-log-controls';
    wrap.style.cssText = 'position:fixed; top:8px; right:8px; z-index:9999; display:flex; gap:6px;';
    wrap.innerHTML = `
      <button class="btn-docking-log-dl" style="font-size:12px; padding:4px 8px;">ログDL</button>
      <button class="btn-docking-log-clear" style="font-size:12px; padding:4px 8px;">ログ消去</button>
    `;
    domRoot.appendChild(wrap);

    wrap.querySelector('.btn-docking-log-dl').addEventListener('click', () => {
      this._downloadDockingLog();
    });
    wrap.querySelector('.btn-docking-log-clear').addEventListener('click', () => {
      ThrusterSolver.clearDockingLog();
    });
  },

  _downloadDockingLog() {
    const log = ThrusterSolver.getDockingLog();
    if (!log || log.length === 0) {
      alert('ドッキングログが空です（自動ドッキングを有効にする、または手動操船で少し飛んでから押してください）');
      return;
    }

    // CSV（Excel/スプレッドシートでそのまま開ける形式）
    const headers = Object.keys(log[0]);
    const csvLines = [headers.join(',')];
    for (const row of log) {
      csvLines.push(headers.map((h) => (row[h] === null || row[h] === undefined ? '' : row[h])).join(','));
    }
    const csvBlob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
    const csvUrl = URL.createObjectURL(csvBlob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    const a = document.createElement('a');
    a.href = csvUrl;
    a.download = `docking-log-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(csvUrl);
  },

  // v42: 「航路トグル（航跡もまとめて対象になった）を、進入軸トグルの
  // 真下に置きたい」という要望への対応。従来は設定リンク・進入軸・
  // 航路の3つを1本のrow-reverse行に横並びさせていたが、それだと
  // 「進入軸の下」という位置関係を作れないため、上段（設定＋進入軸の
  // 横並び）と下段（航路/航跡トグル、進入軸ボタンの真下に配置）の
  // 2段構成に変更する。
  _buildSettingsLink(domRoot) {
    const col = document.createElement('div');
    col.className = 'hud-top-right-col';
    domRoot.appendChild(col);

    const topRow = document.createElement('div');
    topRow.className = 'hud-top-right-row';
    col.appendChild(topRow);

    const link = document.createElement('a');
    link.className = 'hud-settings-link';
    link.href = 'settings.html';
    link.textContent = '⚙ 設定';
    topRow.appendChild(link);

    this._buildApproachGuidesToggle(topRow);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'hud-top-right-row hud-top-right-row-secondary';
    col.appendChild(bottomRow);

    this._buildRouteLineToggle(bottomRow);
  },

  // -----------------------------------------------------------
  // v40: 進入軸（点+線）・目的地ゲート（DockingPlatform）を
  // まとめて表示/非表示するトグルボタン。設定ボタンの左隣に配置する
  // （呼び出し元の.hud-top-right-row、row-reverseで右から順に並ぶ）。
  // ApproachVisualizer.update()・DockingPlatform.update()側は
  // State.settings.showApproachGuidesを毎フレーム参照するだけなので、
  // ここではフラグの反転と永続化（cameraMode等と同じ運用）のみを行う。
  //
  // v41: 予定航路の線はshowRouteLine（別トグル、_buildRouteLineToggle）
  // に分離したため、このボタンの対象は進入軸＋目的地ゲートのみになった。
  // -----------------------------------------------------------
  _buildApproachGuidesToggle(domRoot) {
    const btn = document.createElement('button');
    btn.className = 'btn-approach-guides-toggle';
    domRoot.appendChild(btn);

    const refresh = () => {
      const on = State.settings.showApproachGuides !== false;
      btn.textContent = on ? '🛰 進入軸: ON' : '🛰 進入軸: OFF';
      btn.classList.toggle('is-off', !on);
    };

    btn.addEventListener('click', () => {
      State.settings.showApproachGuides = !(State.settings.showApproachGuides !== false);
      savePersistedSettings({ showApproachGuides: State.settings.showApproachGuides });
      refresh();
    });

    refresh();
  },

  // -----------------------------------------------------------
  // v41: 予定航路（艦がこれから辿る経路の線、ApproachVisualizer.
  // _updateRoute参照）専用の表示/非表示トグル。進入軸・目的地ゲート
  // （showApproachGuides）とは独立に切り替えられるよう別ボタンにする。
  // v42: 自動航行の実際の航跡線（暗いオレンジ、ApproachVisualizer.
  // _updateTrailLine参照）も同じフラグ・同じボタンで一括切り替えの
  // 対象にした（予定航路とセットで表示/非表示したいという要望）。
  // -----------------------------------------------------------
  _buildRouteLineToggle(domRoot) {
    const btn = document.createElement('button');
    btn.className = 'btn-approach-guides-toggle';
    domRoot.appendChild(btn);

    const refresh = () => {
      const on = State.settings.showRouteLine !== false;
      btn.textContent = on ? '〰 航路/航跡: ON' : '〰 航路/航跡: OFF';
      btn.classList.toggle('is-off', !on);
    };

    btn.addEventListener('click', () => {
      State.settings.showRouteLine = !(State.settings.showRouteLine !== false);
      savePersistedSettings({ showRouteLine: State.settings.showRouteLine });
      refresh();
    });

    refresh();
  },

  // -----------------------------------------------------------
  // カメラコントロール:
  //   - モード切替ボタン（chase⇄orbit、常時表示）
  //   - 定点リセットパネル（前後左右上下、orbitモード時のみ表示）
  // orbitモードのドラッグ操作自体は08-camera.jsがcanvas上で
  // 直接ハンドリングするため、ここではボタンUIのみを扱う。
  // -----------------------------------------------------------
  _buildCameraControls(domRoot) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-camera-controls';
    wrap.innerHTML = `
      <button class="btn-camera-mode">視点: 追従</button>
      <div class="camera-preset-panel" style="display:none;">
        <button data-preset="front">前</button>
        <button data-preset="back">後</button>
        <button data-preset="left">左</button>
        <button data-preset="right">右</button>
        <button data-preset="top">上</button>
        <button data-preset="bottom">下</button>
      </div>
    `;
    domRoot.appendChild(wrap);

    const modeBtn = wrap.querySelector('.btn-camera-mode');
    const presetPanel = wrap.querySelector('.camera-preset-panel');

    const refreshModeUI = () => {
      const isOrbit = State.settings.cameraMode === 'orbit';
      modeBtn.textContent = isOrbit ? '視点: 自由' : '視点: 追従';
      presetPanel.style.display = isOrbit ? 'flex' : 'none';
    };

    modeBtn.addEventListener('click', () => {
      CameraSystem.toggleMode();
      refreshModeUI();
    });

    presetPanel.querySelectorAll('button[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        CameraSystem.setOrbitPreset(btn.dataset.preset);
      });
    });

    refreshModeUI();
  },

  // -----------------------------------------------------------
  // v09: サイドメニュー（横からスライドして出るパネル）
  //   スマホでは常設ボタンを並べる横幅の余裕がないため、以下を
  //   まとめて画面端のタブ1つの裏に収納する:
  //     - 自動制動 ON/OFF（角速度ダンピング+並進ダンピング一括切替）
  //     - 自動操船 ON/OFF（目的地へのオートパイロット）
  //     - 目的地座標のX/Y/Z数値入力（「ここを目的地として保存」＝
  //       現在位置ボタンは残しつつ、直接数値入力でも設定できるように）
  //   タブ自体は常時表示、パネル本体は開いている間だけ操作を奪う。
  // -----------------------------------------------------------
  _buildSideMenu(domRoot) {
    const wrap = document.createElement('div');
    wrap.className = 'hud-side-menu';
    wrap.innerHTML = `
      <button class="side-menu-tab">☰</button>
      <div class="side-menu-panel">
        <div class="side-menu-section-title">飛行支援</div>
        <button class="hud-damping-toggle">自動制動(回転): OFF</button>
        <button class="hud-retro-damping-toggle">自動制動(逆噴射): OFF</button>

        <div class="side-menu-section-title">目的地</div>
        <div class="docking-coord-row">
          <label>X</label><input type="number" class="docking-coord-x" step="any">
        </div>
        <div class="docking-coord-row">
          <label>Y</label><input type="number" class="docking-coord-y" step="any">
        </div>
        <div class="docking-coord-row">
          <label>Z</label><input type="number" class="docking-coord-z" step="any">
        </div>
        <div class="docking-coord-row">
          <label>Pitch</label><input type="number" class="docking-attitude-pitch" step="any" placeholder="0">
        </div>
        <div class="docking-coord-row">
          <label>Yaw</label><input type="number" class="docking-attitude-yaw" step="any" placeholder="0">
        </div>
        <div class="docking-coord-row">
          <label>Roll</label><input type="number" class="docking-attitude-roll" step="any" placeholder="0">
        </div>
        <button class="btn-docking-set-coords">🎯 この座標を目的地に設定</button>
        <button class="btn-docking-save">📍 現在地を目的地として保存</button>
        <button class="btn-docking-toggle">自動操船: OFF</button>
      </div>
    `;
    domRoot.appendChild(wrap);

    const tab = wrap.querySelector('.side-menu-tab');
    const panel = wrap.querySelector('.side-menu-panel');

    tab.addEventListener('click', () => {
      const isOpen = wrap.classList.toggle('is-open');
      tab.textContent = isOpen ? '✕' : '☰';
    });

    this._bindDampingToggle(wrap);
    this._bindRetroDampingToggle(wrap);
    this._bindDockingControls(wrap);
  },

  // -----------------------------------------------------------
  // 自動姿勢制動（角速度ダンピング）トグル:
  //   旋回入力を離すと自動でRCSが逆噴射して回転を止める。
  //   v10: 並進制動（逆噴射用SRC）はhud-retro-damping-toggle側に
  //   分離したため、こちらは回転のみを対象とする
  //   （03-thruster-solver.jsのbuildDesiredFromInput参照）。
  // -----------------------------------------------------------
  _bindDampingToggle(wrap) {
    const btn = wrap.querySelector('.hud-damping-toggle');

    const refresh = () => {
      const on = State.settings.autoDampingEnabled;
      btn.textContent = on ? '自動制動(回転): ON' : '自動制動(回転): OFF';
      btn.classList.toggle('is-off', !on);
    };

    btn.addEventListener('click', () => {
      State.settings.autoDampingEnabled = !State.settings.autoDampingEnabled;
      savePersistedSettings({ autoDampingEnabled: State.settings.autoDampingEnabled });
      refresh();
    });

    refresh();
  },

  // -----------------------------------------------------------
  // v10: 並進制動（逆噴射用SRC）専用トグル。
  //   左右/上下ストレイフ入力が無い間、機首方向(ローカルZ)以外の
  //   速度成分をRCS逆噴射で打ち消す（回転トルクは生成しない）。
  //   従来は自動姿勢制動と同じフラグで一括ON/OFFしていたが、
  //   「逆噴射用のSRCを独立させたい」という要望に応じて分離した。
  //   注意: これは横方向(X/Y)の慣性キャンセルのトグルであり、
  //   v15で船首に新設した前後方向(Z)専用の逆噴射スラスター
  //   （retro_left/retro_right、main主機の減速側に相当）とは別物。
  //   前後方向の逆噴射はスロットルレバーの目標速度追従ロジック
  //   （buildDesiredFromInput内のZ速度制御）から常時使われる。
  // -----------------------------------------------------------
  _bindRetroDampingToggle(wrap) {
    const btn = wrap.querySelector('.hud-retro-damping-toggle');

    const refresh = () => {
      const on = State.settings.retroDampingEnabled;
      btn.textContent = on ? '自動制動(逆噴射): ON' : '自動制動(逆噴射): OFF';
      btn.classList.toggle('is-off', !on);
    };

    btn.addEventListener('click', () => {
      State.settings.retroDampingEnabled = !State.settings.retroDampingEnabled;
      savePersistedSettings({ retroDampingEnabled: State.settings.retroDampingEnabled });
      refresh();
    });

    refresh();
  },

  // -----------------------------------------------------------
  // v08→v09: 入港（オートドッキング）関連UI
  //   - 座標入力(X/Y/Z) + 「この座標を目的地に設定」: 数値入力欄の
  //     値をそのまま目的地座標として保存する。姿勢(quaternion)は
  //     現在の艦の姿勢をそのまま流用する（オートパイロットは目的地の
  //     "方角"へ機首を向けるだけの仕組みなので、保存時点の姿勢そのもの
  //     は経由点でしかなく実害がない）。
  //   - 「現在地を目的地として保存」: 従来通り、艦の現在位置・姿勢を
  //     そのまま目的地として保存する。
  //   - 「自動操船: ON/OFF」: 目的地が未設定の場合は無効化。
  //   パネルを開くたびに、現在保存されている目的地の座標を入力欄に
  //   反映する（前回値の確認・微調整をしやすくするため）。
  // -----------------------------------------------------------
  _bindDockingControls(wrap) {
    const xEl = wrap.querySelector('.docking-coord-x');
    const yEl = wrap.querySelector('.docking-coord-y');
    const zEl = wrap.querySelector('.docking-coord-z');
    const pitchEl = wrap.querySelector('.docking-attitude-pitch');
    const yawEl = wrap.querySelector('.docking-attitude-yaw');
    const rollEl = wrap.querySelector('.docking-attitude-roll');
    const setCoordsBtn = wrap.querySelector('.btn-docking-set-coords');
    const saveBtn = wrap.querySelector('.btn-docking-save');
    const toggleBtn = wrap.querySelector('.btn-docking-toggle');

    const refresh = () => {
      const ship = State.ship;
      const hasTarget = !!State.dockingTarget;
      const isAutoOn = !!(ship && ship.autoDockingEnabled);

      toggleBtn.disabled = !hasTarget;
      toggleBtn.textContent = isAutoOn ? '自動操船: ON' : '自動操船: OFF';
      toggleBtn.classList.toggle('is-on', isAutoOn);
      toggleBtn.classList.toggle('is-disabled', !hasTarget);

      if (State.dockingTarget) {
        xEl.value = State.dockingTarget.position.x.toFixed(1);
        yEl.value = State.dockingTarget.position.y.toFixed(1);
        zEl.value = State.dockingTarget.position.z.toFixed(1);

        // 保存済み目的地の姿勢(quaternion)をpitch/yaw/roll(度)に変換して表示
        // （quatToEulerDegreesは05-ship-controller.js参照）。
        const euler = quatToEulerDegrees(State.dockingTarget.quaternion);
        pitchEl.value = euler.pitch.toFixed(1);
        yawEl.value = euler.yaw.toFixed(1);
        rollEl.value = euler.roll.toFixed(1);
      }
    };

    setCoordsBtn.addEventListener('click', () => {
      const ship = State.ship;
      const x = parseFloat(xEl.value);
      const y = parseFloat(yEl.value);
      const z = parseFloat(zEl.value);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      // 姿勢: pitch/yaw/roll入力欄に数値があればそれを使い、
      // 未入力・不正値の場合は現在の艦の姿勢（未取得時は無回転）を
      // 流用する（従来の挙動を後方互換として維持）。
      const pitchDeg = parseFloat(pitchEl.value);
      const yawDeg = parseFloat(yawEl.value);
      const rollDeg = parseFloat(rollEl.value);
      const hasAttitudeInput =
        Number.isFinite(pitchDeg) && Number.isFinite(yawDeg) && Number.isFinite(rollDeg);

      let q;
      if (hasAttitudeInput) {
        const toRad = (deg) => (deg * Math.PI) / 180;
        // eulerToQuatSmallは名前の通り微小角前提の関数ではなく、
        // pitch(X)->yaw(Y)->roll(Z)順の正確な軸回転合成
        // （05-ship-controller.js参照）なので、任意角の姿勢指定にも
        // そのまま使える。
        q = eulerToQuatSmall(toRad(pitchDeg), toRad(yawDeg), toRad(rollDeg));
      } else {
        q = ship
          ? { x: ship.quaternion.x, y: ship.quaternion.y, z: ship.quaternion.z, w: ship.quaternion.w }
          : { x: 0, y: 0, z: 0, w: 1 };
      }

      const target = { position: { x, y, z }, quaternion: q };
      State.dockingTarget = target;
      saveDockingTarget(target);
      refresh();
    });

    saveBtn.addEventListener('click', () => {
      const ship = State.ship;
      if (!ship) return;

      const target = {
        position: { x: ship.position.x, y: ship.position.y, z: ship.position.z },
        quaternion: {
          x: ship.quaternion.x,
          y: ship.quaternion.y,
          z: ship.quaternion.z,
          w: ship.quaternion.w,
        },
      };
      State.dockingTarget = target;
      saveDockingTarget(target);
      refresh();
    });

    toggleBtn.addEventListener('click', () => {
      const ship = State.ship;
      if (!ship || !State.dockingTarget) return; // 目的地未設定時は切り替えない
      ship.autoDockingEnabled = !ship.autoDockingEnabled;
      refresh();
    });

    refresh();
  },

  // 主機（id先頭が'main'）／逆噴射（id先頭が'retro'）の出力比を
  // それぞれ集計（複数あれば平均）。v16: 逆噴射をRCS出力比とは
  // 別枠でHUD表示するため、idPrefixを渡して汎用的に集計できる
  // ようにしてある。艦種プリセット側でスラスターidを増やす場合も、
  // 主機系は'main'始まり、逆噴射系は'retro'始まりの命名を維持すること。
  _computeThrustGroupRatio(ship, idPrefix) {
    const group = ship.thrusters.filter((t) => t.id.startsWith(idPrefix));
    if (group.length === 0) return 0;

    let sum = 0;
    for (const t of group) {
      sum += ship.thrusterOutputRatios[t.id] ?? 0;
    }
    return sum / group.length;
  },

  // 毎フレーム呼び出し
  update() {
    if (!State.settings.showDebugHud || !this._debugEl) return;

    const ship = State.ship;
    if (!ship) return;

    const speed = vecLength(ship.velocity);
    const speedCapMode = getEffectiveSpeedCapMode(ship);
    const mainRatio = this._computeThrustGroupRatio(ship, 'main');
    const retroRatio = this._computeThrustGroupRatio(ship, 'retro');
    const throttlePercent = Math.round((State.input.thrustForward ?? 0) * 100);

    // アクティブなスラスター数（デバッグ用、どれだけ焚かれているか把握しやすくする）
    const activeThrusterCount = Object.values(ship.thrusterOutputRatios).filter((r) => r > 0.01).length;

    // 各軸の姿勢角（pitch/yaw/roll、度）。ストレイフ操作で意図せず
    // 姿勢が変化していないかを確認しやすくするためのデバッグ表示
    // （quatToEulerDegreesは05-ship-controller.js参照）。
    const euler = quatToEulerDegrees(ship.quaternion);
    const angVel = ship.angularVelocity;

    // v46: フェーズ判定はThrusterSolver側のステートマシン
    // （ship._dockingPhase）に一本化されたため、HUDはそれを読んで
    // 日本語ラベルに変換するだけでよい。
    let dockingLine = '';
    if (ship.autoDockingEnabled && State.dockingTarget) {
      const target = State.dockingTarget;
      const dx = target.position.x - ship.position.x;
      const dy = target.position.y - ship.position.y;
      const dz = target.position.z - ship.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const phaseLabels = {
        cruise: '自由巡航中',
        approach: 'アプローチ中',
        adjust: '軸合わせ調整中',
        brake300: '停止中（距離300・軸合わせ）',
        final_approach: '最終アプローチ（姿勢調整）',
        brake250: '停止中（距離250・姿勢調整）',
        tunnel: '最終進入（トンネル内・姿勢固定）',
        overshoot: 'オーバーシュート通過中',
        return_to_axis: '進入軸へ回り込み中',
        docked: '到着（固定）',
      };
      const phaseLabel = phaseLabels[ship._dockingPhase] || ship._dockingPhase || '-';

      dockingLine = `<div>自動操船: 目的地まで ${dist.toFixed(1)} [${phaseLabel}]</div>`;
    }

    this._debugEl.innerHTML = `
      <div>艦種: ${ship.label}</div>
      <div>速度: ${speed.toFixed(1)} / ${ship.maxSpeed} ${ship.isAtMaxSpeed ? '(MAX)' : ''}</div>
      <div>速度上限モード: ${speedCapMode}</div>
      <div>スロットル: ${throttlePercent}%</div>
      <div>主機出力: ${(mainRatio * 100).toFixed(0)}%</div>
      <div>逆噴射出力: ${(retroRatio * 100).toFixed(0)}%</div>
      <div>稼働スラスター数: ${activeThrusterCount} / ${ship.thrusters.length}</div>
      <div>位置: (${ship.position.x.toFixed(1)}, ${ship.position.y.toFixed(1)}, ${ship.position.z.toFixed(1)})</div>
      <div>姿勢角: pitch ${euler.pitch.toFixed(1)}° / yaw ${euler.yaw.toFixed(1)}° / roll ${euler.roll.toFixed(1)}°</div>
      <div>角速度: pitch ${angVel.x.toFixed(2)} / yaw ${angVel.y.toFixed(2)} / roll ${angVel.z.toFixed(2)} rad/s</div>
      ${dockingLine}
    `;
  },
};
