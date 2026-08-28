// =============================================================
// 02-input.js
// 入力ハンドラ（タッチ + キーボード 両対応）
// State.input を更新するだけで、物理側は入力元を意識しない
// =============================================================

const InputSystem = {
  _keys: new Set(),
  _touchSticks: {
    // 左スティック(v04): 左右+上下ストレイフ専用（前後はthrottleLeverへ分離）
    move: { active: false, id: null, originX: 0, originY: 0, dx: 0, dy: 0 },
    // 右スティック: 回転 (yaw + pitch)
    look: { active: false, id: null, originX: 0, originY: 0, dx: 0, dy: 0 },
  },
  // v04: スロットルレバー。バネ戻り式スティックと違い、指を離しても
  // _ratio は最後の位置を保持し続ける（保持型/detent無しレバー）
  _throttleLever: {
    active: false,
    id: null,
    el: null,
    handleEl: null,
    labelEl: null,
    ratio: 0, // -1..1、保持値。0=推力なし、+1=フル前進、-1=フル後進
  },
  _rollLeftEl: null,
  _rollRightEl: null,
  _boostEl: null,
  _rollInput: 0,

  init(domRoot) {
    this._bindKeyboard();
    this._bindTouch(domRoot);
  },

  // -----------------------------------------------------------
  // キーボード
  //   移動: W/S 前後, A/D ヨー, Q/E ロール, R/F ピッチ
  //   左右ストレイフ/上下ストレイフ: 矢印キー
  //   ブースト: Shift
  // キーボードのW/Sはタッチのスロットルレバーと違い、押している間
  // だけ効く従来通りのモメンタリー入力（保持機構はタッチ専用）。
  // -----------------------------------------------------------
  _bindKeyboard() {
    window.addEventListener('keydown', (e) => this._keys.add(e.code));
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
  },

  _readKeyboard() {
    const k = this._keys;
    const axis = (negCode, posCode) =>
      (k.has(posCode) ? 1 : 0) - (k.has(negCode) ? 1 : 0);

    return {
      thrustForward: axis('KeyS', 'KeyW'),
      thrustStrafeX: axis('ArrowLeft', 'ArrowRight'),
      thrustStrafeY: axis('ArrowDown', 'ArrowUp'),
      rotateYaw: axis('KeyD', 'KeyA'),
      rotatePitch: axis('KeyR', 'KeyF'),
      rotateRoll: axis('KeyQ', 'KeyE'),
      boost: k.has('ShiftLeft') || k.has('ShiftRight'),
    };
  },

  // -----------------------------------------------------------
  // タッチ（デュアルスティック + スロットルレバー + ロール補助ボタン）
  //   domRootの子要素に .stick-move / .stick-look / .throttle-lever /
  //   .btn-roll-left / .btn-roll-right / .btn-boost がある想定
  //   （06-hud.js側でDOM生成）
  // -----------------------------------------------------------
  _bindTouch(domRoot) {
    if (!domRoot) return;

    const moveEl = domRoot.querySelector('.stick-move');
    const lookEl = domRoot.querySelector('.stick-look');
    const throttleEl = domRoot.querySelector('.throttle-lever');
    this._rollLeftEl = domRoot.querySelector('.btn-roll-left');
    this._rollRightEl = domRoot.querySelector('.btn-roll-right');
    this._boostEl = domRoot.querySelector('.btn-boost');

    if (moveEl) this._bindStick(moveEl, this._touchSticks.move);
    if (lookEl) this._bindStick(lookEl, this._touchSticks.look);
    if (throttleEl) this._bindThrottleLever(throttleEl);
  },

  _bindStick(el, stickState) {
    const radius = 48; // スティック可動半径(px)、06-hud.jsのCSSと合わせる

    const onStart = (clientX, clientY, id) => {
      const rect = el.getBoundingClientRect();
      stickState.active = true;
      stickState.id = id;
      stickState.originX = rect.left + rect.width / 2;
      stickState.originY = rect.top + rect.height / 2;
      stickState.dx = 0;
      stickState.dy = 0;
    };

    const onMove = (clientX, clientY) => {
      if (!stickState.active) return;
      let dx = clientX - stickState.originX;
      let dy = clientY - stickState.originY;
      const len = Math.hypot(dx, dy);
      if (len > radius) {
        dx = (dx / len) * radius;
        dy = (dy / len) * radius;
      }
      stickState.dx = dx / radius; // -1..1
      stickState.dy = dy / radius; // -1..1
    };

    const onEnd = () => {
      stickState.active = false;
      stickState.id = null;
      stickState.dx = 0;
      stickState.dy = 0;
    };

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      onStart(t.clientX, t.clientY, t.identifier);
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === stickState.id) onMove(t.clientX, t.clientY);
      }
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickState.id) onEnd();
      }
    });
    el.addEventListener('touchcancel', onEnd);
  },

  // -----------------------------------------------------------
  // スロットルレバー（v04）: 縦方向ドラッグでratioを更新するが、
  // _bindStick()のスティックと違い、指を離してもonEndでratioを
  // ゼロに戻さない（保持型）。ハンドルの表示位置とラベルテキストも
  // ここで直接更新する（06-hud.jsのHUD.update()を待たずに反映）。
  // -----------------------------------------------------------
  _bindThrottleLever(el) {
    const lever = this._throttleLever;
    lever.el = el;
    lever.handleEl = el.querySelector('.throttle-lever-handle');
    lever.labelEl = el.querySelector('.throttle-lever-label');

    const applyRatioFromClientY = (clientY) => {
      const rect = el.getBoundingClientRect();
      // レバー内側の可動範囲（ハンドル自身の高さぶんを両端から除く）
      const handleHalf = lever.handleEl ? lever.handleEl.offsetHeight / 2 : 14;
      const top = rect.top + handleHalf;
      const bottom = rect.bottom - handleHalf;
      const usable = Math.max(1, bottom - top);
      const clampedY = clamp(clientY, top, bottom);
      // 上端(top)=+1(フル前進)、下端(bottom)=-1(フル後進)になるよう反転
      const normalized = 1 - ((clampedY - top) / usable) * 2;
      lever.ratio = clamp(normalized, -1, 1);
      this._updateThrottleVisual();
    };

    const onStart = (clientY, id) => {
      lever.active = true;
      lever.id = id;
      applyRatioFromClientY(clientY);
    };

    const onMove = (clientY) => {
      if (!lever.active) return;
      applyRatioFromClientY(clientY);
    };

    const onEnd = () => {
      // 保持型: activeフラグは下ろすが、ratioはそのまま維持する
      // （ここがバネ戻り式の_bindStick()との唯一かつ本質的な違い）
      lever.active = false;
      lever.id = null;
    };

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      onStart(t.clientY, t.identifier);
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === lever.id) onMove(t.clientY);
      }
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === lever.id) onEnd();
      }
    });
    el.addEventListener('touchcancel', onEnd);

    // マウスでもテストできるようフォールバック
    el.addEventListener('mousedown', (e) => onStart(e.clientY, 'mouse'));
    window.addEventListener('mousemove', (e) => {
      if (lever.id === 'mouse') onMove(e.clientY);
    });
    window.addEventListener('mouseup', () => {
      if (lever.id === 'mouse') onEnd();
    });

    this._updateThrottleVisual();
  },

  // ハンドルの縦位置とラベル(%)表示をratioに合わせて更新
  _updateThrottleVisual() {
    const lever = this._throttleLever;
    if (!lever.el) return;

    if (lever.handleEl) {
      // ratio +1(上端)..-1(下端) を top:0%..100% にマッピング
      const topPercent = ((1 - lever.ratio) / 2) * 100;
      lever.handleEl.style.top = `${topPercent}%`;
    }
    if (lever.labelEl) {
      lever.labelEl.textContent = `${Math.round(lever.ratio * 100)}%`;
    }
  },

  _readTouch() {
    const move = this._touchSticks.move;
    const look = this._touchSticks.look;

    let roll = 0;
    if (this._rollLeftEl) {
      roll += this._isPressed(this._rollLeftEl) ? -1 : 0;
    }
    if (this._rollRightEl) {
      roll += this._isPressed(this._rollRightEl) ? 1 : 0;
    }

    return {
      thrustForward: this._throttleLever.ratio, // v04: 保持型スロットルレバーの値をそのまま使う
      thrustStrafeX: move.dx,
      thrustStrafeY: -move.dy, // 上に倒す=上昇
      rotateYaw: look.dx,
      rotatePitch: -look.dy,
      rotateRoll: roll,
      boost: this._boostEl ? this._isPressed(this._boostEl) : false,
    };
  },

  _isPressed(el) {
    return el.dataset.pressed === 'true';
  },

  // -----------------------------------------------------------
  // 毎フレーム呼び出し。キーボード/タッチのうち入力があった方を
  // 単純合算（同時操作は非対応、絶対値が大きい方を優先）。
  //
  // thrustForwardのみ例外: タッチのスロットルレバーは指を離しても
  // 値を保持し続ける仕様のため、単純に「絶対値が大きい方」で
  // pickすると、キーボードでW/Sを離した瞬間(kb=0)にレバー保持値
  // (tc≠0)が正しく採用される一方、キーボードで軽く逆入力しても
  // レバーの大きな保持値に負けて反応しない、といった直感に反する
  // 挙動になり得る。そのため thrustForward はキーボード入力が
  // 実際に押されている間だけキーボード優先、それ以外は常に
  // スロットルレバーの保持値を使う。
  // -----------------------------------------------------------
  update() {
    const kb = this._readKeyboard();
    const tc = this._readTouch();

    const pick = (a, b) => (Math.abs(a) >= Math.abs(b) ? a : b);
    const kbForwardActive = this._keys.has('KeyW') || this._keys.has('KeyS');

    State.input.thrustForward = kbForwardActive ? kb.thrustForward : tc.thrustForward;
    State.input.thrustStrafeX = pick(kb.thrustStrafeX, tc.thrustStrafeX);
    State.input.thrustStrafeY = pick(kb.thrustStrafeY, tc.thrustStrafeY);
    State.input.rotateYaw = pick(kb.rotateYaw, tc.rotateYaw);
    State.input.rotatePitch = pick(kb.rotatePitch, tc.rotatePitch);
    State.input.rotateRoll = pick(kb.rotateRoll, tc.rotateRoll);
    State.input.boost = kb.boost || tc.boost;
  },
};
