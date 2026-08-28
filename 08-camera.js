// =============================================================
// 08-camera.js
// カメラシステム
//   - chase（追従）: 船の後方から追従。船のロールにカメラの
//     上方向(up vector)も追従させる
//   - orbit（自由視点）: 船を中心とした球面座標でカメラを配置。
//     ドラッグ/スワイプで自由に回転、ボタンで定点（前後左右上下）
//     へ即座にリセットできる
// =============================================================

const CameraSystem = {
  // orbit時の球面座標（船のローカル座標系を基準とした角度）
  //   azimuth: 水平角（0=船の真後ろ、+で右回り）
  //   elevation: 仰角（0=水平、+で見上げ）
  //   distance: 船中心からの距離
  _orbit: {
    azimuth: 0,
    elevation: 0.2,
    distance: 30,
  },

  _dragState: {
    active: false,
    lastX: 0,
    lastY: 0,
  },

  // 2本指ピンチズーム用の状態
  _pinchState: {
    active: false,
    lastDist: 0,
  },

  // ドラッグ感度・制限
  DRAG_SENSITIVITY: 0.006,
  PINCH_SENSITIVITY: 0.05,
  MIN_ELEVATION: -1.4, // 真下近くまで（真下=-PI/2=-1.57は特異点なので少し手前で止める）
  MAX_ELEVATION: 1.4,
  MIN_DISTANCE: 8,
  MAX_DISTANCE: 300,

  // -----------------------------------------------------------
  // 初期化: ドラッグ操作のイベントバインド
  //   canvasEl: レンダラーのcanvas要素（renderer.domElement）
  // -----------------------------------------------------------
  init(canvasEl) {
    this._bindDrag(canvasEl);
  },

  // -----------------------------------------------------------
  // orbitモード時のドラッグ回転。マウスとタッチ両対応。
  // 注意: HUDのタッチスティック等はcanvas外のDOM要素として
  // pointer-events:autoを持つため、そちらに重ならない領域での
  // ドラッグのみがここに到達する（イベントバブリング上の競合なし）。
  // -----------------------------------------------------------
  _bindDrag(canvasEl) {
    const onDragStart = (x, y) => {
      if (State.settings.cameraMode !== 'orbit') return;
      this._dragState.active = true;
      this._dragState.lastX = x;
      this._dragState.lastY = y;
    };

    const onDragMove = (x, y) => {
      if (!this._dragState.active) return;
      const dx = x - this._dragState.lastX;
      const dy = y - this._dragState.lastY;
      this._dragState.lastX = x;
      this._dragState.lastY = y;

      this._orbit.azimuth -= dx * this.DRAG_SENSITIVITY;
      this._orbit.elevation = clamp(
        this._orbit.elevation + dy * this.DRAG_SENSITIVITY,
        this.MIN_ELEVATION,
        this.MAX_ELEVATION
      );
    };

    const onDragEnd = () => {
      this._dragState.active = false;
    };

    // 2本指の距離（ピンチ）
    const pinchDistance = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const onPinchMove = (touches) => {
      if (State.settings.cameraMode !== 'orbit') return;
      const dist = pinchDistance(touches);
      if (!this._pinchState.active) {
        this._pinchState.active = true;
        this._pinchState.lastDist = dist;
        return;
      }
      const delta = dist - this._pinchState.lastDist;
      this._pinchState.lastDist = dist;
      // 指を広げる(dist増)→ズームイン(distance減)
      this._orbit.distance = clamp(
        this._orbit.distance - delta * this.PINCH_SENSITIVITY,
        this.MIN_DISTANCE,
        this.MAX_DISTANCE
      );
    };

    const onPinchEnd = () => {
      this._pinchState.active = false;
    };

    canvasEl.addEventListener('mousedown', (e) => onDragStart(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => onDragMove(e.clientX, e.clientY));
    window.addEventListener('mouseup', onDragEnd);

    // passive:trueだとブラウザがスクロール/ジェスチャー処理を
    // 優先してしまい、1本指ドラッグがページスクロール扱いされて
    // 拾えないことがある（バグ報告：「自由視点でドラッグが効かない」）。
    // preventDefault()できるようpassive:falseに変更。CSS側
    // （index.htmlのcanvas{touch-action:none}）と合わせて、
    // ブラウザ標準のタッチジェスチャーを完全に無効化する。
    // 1本指=回転ドラッグ、2本指=ピンチズームとして両方自前で処理する
    // （touch-action:noneでブラウザ標準ピンチも無効化されているため、
    //   ズームは自前実装しないと一切効かなくなる）。
    canvasEl.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        this._pinchState.active = false;
        const t = e.touches[0];
        onDragStart(t.clientX, t.clientY);
      } else if (e.touches.length === 2) {
        this._dragState.active = false; // ピンチ開始時はドラッグ回転を止める
        this._pinchState.active = true;
        this._pinchState.lastDist = pinchDistance(e.touches);
      }
    }, { passive: false });

    canvasEl.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && !this._pinchState.active) {
        const t = e.touches[0];
        onDragMove(t.clientX, t.clientY);
      } else if (e.touches.length === 2) {
        onPinchMove(e.touches);
      }
    }, { passive: false });

    canvasEl.addEventListener('touchend', (e) => {
      onDragEnd();
      onPinchEnd();
      // 2本→1本に減った場合、残った指でドラッグ再開できるようにする
      if (e.touches.length === 1) {
        const t = e.touches[0];
        onDragStart(t.clientX, t.clientY);
      }
    });
    canvasEl.addEventListener('touchcancel', () => {
      onDragEnd();
      onPinchEnd();
    });

    // ホイールでズーム（distance調整）。PC環境向け。スマホは2本指ピンチで対応。
    canvasEl.addEventListener('wheel', (e) => {
      if (State.settings.cameraMode !== 'orbit') return;
      e.preventDefault();
      this._orbit.distance = clamp(
        this._orbit.distance + e.deltaY * 0.05,
        this.MIN_DISTANCE,
        this.MAX_DISTANCE
      );
    }, { passive: false });
  },

  // -----------------------------------------------------------
  // 定点ビューへのリセット（HUDのボタンから呼ばれる）
  //   preset: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom'
  // -----------------------------------------------------------
  setOrbitPreset(preset) {
    const presets = {
      back: { azimuth: 0, elevation: 0.2 },
      front: { azimuth: Math.PI, elevation: 0.2 },
      left: { azimuth: -Math.PI / 2, elevation: 0.15 },
      right: { azimuth: Math.PI / 2, elevation: 0.15 },
      top: { azimuth: 0, elevation: this.MAX_ELEVATION },
      bottom: { azimuth: 0, elevation: this.MIN_ELEVATION },
    };
    const p = presets[preset];
    if (!p) return;
    this._orbit.azimuth = p.azimuth;
    this._orbit.elevation = p.elevation;
  },

  // -----------------------------------------------------------
  // モード切替（'chase' | 'orbit'）
  // -----------------------------------------------------------
  toggleMode() {
    State.settings.cameraMode = State.settings.cameraMode === 'chase' ? 'orbit' : 'chase';
    savePersistedSettings({ cameraMode: State.settings.cameraMode });
  },

  // -----------------------------------------------------------
  // 毎フレーム呼び出し。camera/State.shipはグローバル（index.html側）
  // -----------------------------------------------------------
  update(camera) {
    const ship = State.ship;
    if (!ship || !ship.mesh) return;

    if (State.settings.cameraMode === 'orbit') {
      this._updateOrbit(camera, ship);
    } else {
      this._updateChase(camera, ship);
    }
  },

  // -----------------------------------------------------------
  // chase（追従）: 船の後方固定オフセットに位置しつつ、船の
  // クォータニオン全体（ロール含む）でカメラの上方向も回転させる。
  // 以前はcamera.lookAt()のデフォルトup(常に{0,1,0})のため、
  // 位置は追従してもカメラの傾き自体はロールに追従していなかった
  // （バグ報告：「視点が船のロールに追従しない」）。
  // -----------------------------------------------------------
  _updateChase(camera, ship) {
    const camOffset = rotateVecByQuat({ x: 0, y: 6, z: 24 }, ship.quaternion);
    camera.position.set(
      ship.position.x + camOffset.x,
      ship.position.y + camOffset.y,
      ship.position.z + camOffset.z
    );

    // 船のローカル上方向（+Y）をワールド座標に変換し、カメラのupに
    // 明示的に設定してからlookAtする。これによりlookAt()が
    // 「船が今向いている上方向」を基準に視界を組み立てるようになり、
    // 船がロールすればカメラの傾きも一緒に回転する。
    const upWorld = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    camera.up.set(upWorld.x, upWorld.y, upWorld.z);
    camera.lookAt(ship.position.x, ship.position.y, ship.position.z);
  },

  // -----------------------------------------------------------
  // orbit（自由視点）: 船を中心とした球面座標でカメラを配置。
  // 角度は「船のローカル座標系」を基準にしているため、船が回転・
  // 移動してもカメラは常に船との相対角度を保つ（船を見失わない）。
  // -----------------------------------------------------------
  _updateOrbit(camera, ship) {
    const { azimuth, elevation, distance } = this._orbit;

    // ローカル球面座標→ローカル直交座標（船の後方=+Zを基準に、
    // azimuth=0で真後ろ、elevationで上下）
    const horizontalDist = distance * Math.cos(elevation);
    const localOffset = {
      x: horizontalDist * Math.sin(azimuth),
      y: distance * Math.sin(elevation),
      z: horizontalDist * Math.cos(azimuth),
    };

    const worldOffset = rotateVecByQuat(localOffset, ship.quaternion);
    camera.position.set(
      ship.position.x + worldOffset.x,
      ship.position.y + worldOffset.y,
      ship.position.z + worldOffset.z
    );

    // orbitモードでも船のロールに応じてupを追従させる（真上/真下
    // 付近を除き、chaseと同じ理屈で自然な傾きになる）
    const upWorld = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    camera.up.set(upWorld.x, upWorld.y, upWorld.z);
    camera.lookAt(ship.position.x, ship.position.y, ship.position.z);
  },
};
