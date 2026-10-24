// =============================================================
// 26-post-fx.js
// v84: 光のにじみ（ブルーム）
//
// 画面全体をいったん画面外の描画先（_target）に描き、明るい部分だけを
// ぼかして重ねる（three.js r128 の UnrealBloomPass）。
//   - 描画先は、使えれば半精度の浮動小数（1より明るい値をそのまま持てる）にする。
//     しきい値を1にして、日の当たった白い面や雲（1以下）はにじませず、光る面
//     （放射の強さで1より明るくなる。01-state-and-config.js applyEmissiveStrength）や、
//     噴射の粒が重なって明るくなったところだけをにじませる。
//     浮動小数の描画先が使えない端末では、しきい値を少し下げて同じように使う。
//   - 画面の解像度が低い（1倍）ときは、描画先でもアンチエイリアス（4倍）をかける。
//     高精細画面（2倍）では、ギザギザが目立たないのでメモリを節約してかけない。
//   - 設定（State.settings.bloomEnabled）で切ると、従来どおり画面に直接描く。
//
// 使い方: PostFx.render(renderer, draw) — draw() は今の描画先に1フレーム分描く関数。
// =============================================================

const PostFx = {
  STRENGTH: 0.45,
  RADIUS: 0.3,
  THRESHOLD_HDR: 1.0,
  THRESHOLD_LDR: 0.96,

  enabled: false,
  _target: null,
  _bloom: null,
  _hdr: false,

  init(renderer, enabled) {
    this.enabled = false;
    if (!enabled) return;
    if (typeof THREE.UnrealBloomPass !== 'function' || typeof THREE.LuminosityHighPassShader === 'undefined' || typeof THREE.CopyShader === 'undefined') {
      console.warn('ブルームに必要なライブラリが読み込まれていません。ブルームなしで表示します。');
      return;
    }
    try {
      const caps = renderer.capabilities;
      const ext = renderer.extensions;
      this._hdr = !!(caps.isWebGL2 && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')));
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      const params = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: this._hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      };
      const msaa = caps.isWebGL2 && typeof THREE.WebGLMultisampleRenderTarget === 'function' && renderer.getPixelRatio() < 1.5;
      this._target = msaa
        ? new THREE.WebGLMultisampleRenderTarget(size.x, size.y, params)
        : new THREE.WebGLRenderTarget(size.x, size.y, params);
      if (msaa) this._target.samples = 4;
      this._target.texture.generateMipmaps = false;
      // ぼかしは画面の半分の解像度から（さらに内部で半分ずつ）にして軽くする
      this._bloom = new THREE.UnrealBloomPass(
        new THREE.Vector2(Math.max(2, size.x / 2), Math.max(2, size.y / 2)),
        this.STRENGTH, this.RADIUS, this._hdr ? this.THRESHOLD_HDR : this.THRESHOLD_LDR
      );
      this._bloom.renderToScreen = true;
      this.enabled = true;
    } catch (e) {
      console.warn('ブルームを準備できませんでした。ブルームなしで表示します。', e);
      this.dispose();
    }
  },

  setSize(renderer) {
    if (!this.enabled) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this._target.setSize(size.x, size.y);
    this._bloom.setSize(Math.max(2, size.x / 2), Math.max(2, size.y / 2));
  },

  render(renderer, draw) {
    if (!this.enabled) {
      renderer.setRenderTarget(null);
      draw();
      return;
    }
    renderer.setRenderTarget(this._target);
    draw();
    this._bloom.render(renderer, null, this._target, 0, false);
    renderer.setRenderTarget(null);
  },

  dispose() {
    if (this._target) this._target.dispose();
    if (this._bloom) {
      for (const rt of [this._bloom.renderTargetBright, ...this._bloom.renderTargetsHorizontal, ...this._bloom.renderTargetsVertical]) rt.dispose();
    }
    this._target = null;
    this._bloom = null;
    this.enabled = false;
  },
};
