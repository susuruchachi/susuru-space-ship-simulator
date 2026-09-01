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

  // v72: 「二本指スワイプ／シフト+左クリックドラッグで視点をずらせる
  // ようにしてほしい」との要望を受けて追加。orbitモードの注視点は
  // 従来ship.position固定だったが、そこにこのオフセットを足すことで、
  // 船から注視点自体を自由に離せる「真のパン」にする。船のローカル
  // 座標系で保持することで、船が移動・回転してもパンでずらした
  // ズレ量がそのまま保たれる（ワールド座標の差分として保持すると、
  // 船が動くたびに視界に対する相対的なズレが変わってしまい、
  // パン操作をしていないのに視界がズレて見える）。
  // カメラ位置・注視点の両方に同じオフセットを加えるため、パン操作は
  // 視点をずらすだけでカメラの向き（船を見る角度）自体は変えない。
  _panOffsetLocal: { x: 0, y: 0, z: 0 },

  _dragState: {
    active: false,
    lastX: 0,
    lastY: 0,
    panMode: false, // true: シフト押下中のドラッグ=パン、false: 通常ドラッグ=視点回転
  },

  // 2本指ピンチズーム/パン用の状態
  _pinchState: {
    active: false,
    lastDist: 0,
    lastMidX: 0,
    lastMidY: 0,
  },

  // ドラッグ感度・制限
  DRAG_SENSITIVITY: 0.006,
  PINCH_SENSITIVITY: 0.05,
  PAN_SENSITIVITY: 0.0015, // ドラッグ1pxかつdistance=1あたりのワールド移動量。distanceに比例させ、ズーム倍率が変わっても画面上の動きの体感速度を揃える
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
    const onDragStart = (x, y, panMode) => {
      if (State.settings.cameraMode !== 'orbit') return;
      this._dragState.active = true;
      this._dragState.panMode = !!panMode;
      this._dragState.lastX = x;
      this._dragState.lastY = y;
    };

    const onDragMove = (x, y) => {
      if (!this._dragState.active) return;
      const dx = x - this._dragState.lastX;
      const dy = y - this._dragState.lastY;
      this._dragState.lastX = x;
      this._dragState.lastY = y;

      if (this._dragState.panMode) {
        this._applyScreenPan(dx, dy);
        return;
      }

      this._orbit.azimuth -= dx * this.DRAG_SENSITIVITY;
      this._orbit.elevation = clamp(
        this._orbit.elevation + dy * this.DRAG_SENSITIVITY,
        this.MIN_ELEVATION,
        this.MAX_ELEVATION
      );
    };

    const onDragEnd = () => {
      this._dragState.active = false;
      this._dragState.panMode = false;
    };

    // 2本指の距離（ピンチ）
    const pinchDistance = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const pinchMidpoint = (touches) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    });

    const onPinchMove = (touches) => {
      if (State.settings.cameraMode !== 'orbit') return;
      const dist = pinchDistance(touches);
      const mid = pinchMidpoint(touches);
      if (!this._pinchState.active) {
        this._pinchState.active = true;
        this._pinchState.lastDist = dist;
        this._pinchState.lastMidX = mid.x;
        this._pinchState.lastMidY = mid.y;
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
      // v72: 二本指スワイプ（2本の指の中点の移動）でパンできるように。
      // ピンチ（指の間隔の変化）とスワイプ（中点の移動）は同時に
      // 発生しうる一般的なジェスチャーなので、両方を同フレームで処理する。
      const midDx = mid.x - this._pinchState.lastMidX;
      const midDy = mid.y - this._pinchState.lastMidY;
      this._pinchState.lastMidX = mid.x;
      this._pinchState.lastMidY = mid.y;
      this._applyScreenPan(midDx, midDy);
    };

    const onPinchEnd = () => {
      this._pinchState.active = false;
    };

    canvasEl.addEventListener('mousedown', (e) => onDragStart(e.clientX, e.clientY, e.shiftKey));
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
        const mid = pinchMidpoint(e.touches);
        this._pinchState.lastMidX = mid.x;
        this._pinchState.lastMidY = mid.y;
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
  // v72: 画面上のドラッグ量(dx, dy)を、現在のカメラの向きを基準にした
  // 「画面右方向」「画面上方向」のワールドベクトルに変換し、
  // _panOffsetへ加算する。distanceに比例させることで、カメラが
  // 近い時は小さく・遠い時は大きく動く（画面上の見た目の移動量が
  // 距離によらず揃う）。
  // -----------------------------------------------------------
  _applyScreenPan(dx, dy) {
    const ship = State.ship;
    if (!ship || !ship.mesh) return;
    const { azimuth, elevation, distance } = this._orbit;

    // 船からカメラへ向かう方向（正規化済み想定でよい単位ベクトル）
    const forward = {
      x: Math.cos(elevation) * Math.sin(azimuth),
      y: Math.sin(elevation),
      z: Math.cos(elevation) * Math.cos(azimuth),
    };
    const worldUpRef = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    // right = forward × worldUpRef を正規化
    let right = {
      x: forward.y * worldUpRef.z - forward.z * worldUpRef.y,
      y: forward.z * worldUpRef.x - forward.x * worldUpRef.z,
      z: forward.x * worldUpRef.y - forward.y * worldUpRef.x,
    };
    const rightLen = Math.hypot(right.x, right.y, right.z) || 1;
    right = { x: right.x / rightLen, y: right.y / rightLen, z: right.z / rightLen };
    // up = right × forward を正規化（カメラのその場のup、真上/真下付近でのねじれを避ける）
    let up = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x,
    };
    const upLen = Math.hypot(up.x, up.y, up.z) || 1;
    up = { x: up.x / upLen, y: up.y / upLen, z: up.z / upLen };

    const scale = distance * this.PAN_SENSITIVITY;
    // v73: パンの向きが逆との報告を受けて符号を反転。
    // 右へドラッグ(dx>0)したら注視点も右へ動く(景色が指と逆方向に
    // 流れる、一般的なカメラパン操作の感覚)。
    // 上へドラッグ(dy<0、clientYは上ほど小さい)したら注視点は下へ
    // 動くようにするため、dyの符号を反転させる。
    const worldDelta = {
      x: (right.x * dx - up.x * dy) * scale,
      y: (right.y * dx - up.y * dy) * scale,
      z: (right.z * dx - up.z * dy) * scale,
    };
    // ワールド座標の移動量を、船のローカル座標系に変換してから
    // _panOffsetLocalへ加算する（保持理由は_panOffsetLocalのコメント参照）。
    const inverseQuat = conjugateQuat(ship.quaternion);
    const localDelta = rotateVecByQuat(worldDelta, inverseQuat);
    this._panOffsetLocal.x += localDelta.x;
    this._panOffsetLocal.y += localDelta.y;
    this._panOffsetLocal.z += localDelta.z;
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
    // v72: 定点ビューへ戻す操作なので、パンでずらした注視点も
    // 船中心へ戻す。ここでリセットしないと「正面ボタンを押したのに
    // 船が画面端に寄ったまま」になり、定点リセットの意図と食い違う。
    this._panOffsetLocal = { x: 0, y: 0, z: 0 };
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
    // v72: パンオフセット（船のローカル座標系で保持）をワールドへ
    // 変換し、注視点・カメラ位置の両方に同じだけ加える。カメラ位置に
    // も同じ量を足すことで、パンしても船との距離(distance)や見る
    // 角度自体は変わらず、視界全体が平行にずれる。
    const panWorld = rotateVecByQuat(this._panOffsetLocal, ship.quaternion);
    const targetX = ship.position.x + panWorld.x;
    const targetY = ship.position.y + panWorld.y;
    const targetZ = ship.position.z + panWorld.z;

    camera.position.set(
      targetX + worldOffset.x,
      targetY + worldOffset.y,
      targetZ + worldOffset.z
    );

    // orbitモードでも船のロールに応じてupを追従させる（真上/真下
    // 付近を除き、chaseと同じ理屈で自然な傾きになる）
    const upWorld = rotateVecByQuat({ x: 0, y: 1, z: 0 }, ship.quaternion);
    camera.up.set(upWorld.x, upWorld.y, upWorld.z);
    camera.lookAt(targetX, targetY, targetZ);
  },
};
