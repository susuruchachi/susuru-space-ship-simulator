// =============================================================
// 17-space-hud.js
// 宇宙航行用のHUD: 現在地・速度・目的地の表示、ワープ/自動航行/星図の
// ボタン、天体名ラベル、目的地マーカー、出典表示
//
// v77: 太陽系の実装に合わせて新設。06-hud.js（艦の操縦・ドッキング用）とは
// 役割を分け、こちらは「宇宙のどこにいて、どこへ行くか」だけを扱う。
// =============================================================

const SpaceHud = {
  _root: null,
  _els: {},
  _labels: {},
  _lastTextUpdate: 0,
  showLabels: true,

  init(domRoot) {
    this._root = domRoot;
    this.showLabels = loadPersistedSettings().showBodyLabels ?? true;
    this._buildLabelLayer(domRoot);
    this._buildNavPanel(domRoot);
    this._buildWarning(domRoot);
    this._buildCredits();
    this._bindKeys();
  },

  // -----------------------------------------------------------
  // 画面上部中央のナビゲーションパネル
  // -----------------------------------------------------------
  _buildNavPanel(domRoot) {
    const el = document.createElement('div');
    el.className = 'space-nav-panel';
    el.innerHTML = `
      <div class="space-nav-info">
        <div class="space-nav-line space-nav-location">-</div>
        <div class="space-nav-line space-nav-speed">-</div>
        <div class="space-nav-line space-nav-target">目的地: 未設定</div>
      </div>
      <div class="space-nav-buttons">
        <button class="btn-space-map" title="星図を開く (M)">🗺<span class="snb-text"> 星図</span></button>
        <select class="space-target-select" title="目的地"></select>
        <button class="btn-space-autopilot" title="目的地へ自動でワープ (G)">🎯<span class="snb-text"> 自動航行</span></button>
        <button class="btn-space-warp" title="手動ワープ。スロットルで速度、操縦桿で向き (J)">⚡<span class="snb-text"> ワープ</span></button>
        <button class="btn-space-labels" title="天体名の表示 (L)">🏷</button>
        <button class="btn-space-orbits" title="軌道線の表示">◯</button>
        <button class="btn-space-compact" title="パネルを小さく/大きく">▴</button>
      </div>
    `;
    domRoot.appendChild(el);
    this._els.panel = el;
    this._els.location = el.querySelector('.space-nav-location');
    this._els.speed = el.querySelector('.space-nav-speed');
    this._els.target = el.querySelector('.space-nav-target');
    this._els.warpBtn = el.querySelector('.btn-space-warp');
    this._els.autoBtn = el.querySelector('.btn-space-autopilot');
    this._els.labelBtn = el.querySelector('.btn-space-labels');
    this._els.select = el.querySelector('.space-target-select');

    this._fillTargetSelect();
    this._els.select.addEventListener('change', () => {
      const v = this._els.select.value;
      if (!v) Navigation.setTarget(null);
      else if (v === 'home') Navigation.setTarget({ kind: 'home' });
      else Navigation.setTarget({ kind: 'body', id: v });
      this._els.select.blur();
    });
    el.querySelector('.btn-space-map').addEventListener('click', () => {
      if (typeof StarMap !== 'undefined') StarMap.toggle();
    });
    this._els.warpBtn.addEventListener('click', () => this.toggleWarp());
    this._els.autoBtn.addEventListener('click', () => this.toggleAutopilot());
    this._els.labelBtn.addEventListener('click', () => {
      this.showLabels = !this.showLabels;
      savePersistedSettings({ showBodyLabels: this.showLabels });
    });
    this._els.orbitBtn = el.querySelector('.btn-space-orbits');
    Universe.settings.showOrbits = !!loadPersistedSettings().showOrbitLines;
    this._els.orbitBtn.addEventListener('click', () => {
      Universe.settings.showOrbits = !Universe.settings.showOrbits;
      savePersistedSettings({ showOrbitLines: Universe.settings.showOrbits });
    });
    // 狭い画面（スマホ）では最初から小さく表示し、▴/▾で切り替えられるようにする
    const persisted = loadPersistedSettings().spaceNavCompact;
    const narrow = window.innerWidth < 900 || window.innerHeight < 500;
    this._compact = persisted ?? narrow;
    const compactBtn = el.querySelector('.btn-space-compact');
    const applyCompact = () => {
      el.classList.toggle('is-compact', this._compact);
      compactBtn.textContent = this._compact ? '▾' : '▴';
    };
    compactBtn.addEventListener('click', () => {
      this._compact = !this._compact;
      savePersistedSettings({ spaceNavCompact: this._compact });
      applyCompact();
    });
    applyCompact();
  },

  _fillTargetSelect() {
    const sel = this._els.select;
    const groups = [
      ['', [['', '目的地を選択']]],
      ['母港', [['home', '母港（地球周回軌道）']]],
      ['恒星', SolarSystem.bodies.filter((b) => b.type === 'star').map((b) => [b.id, b.ja])],
      ['惑星', SolarSystem.bodies.filter((b) => b.type === 'planet').map((b) => [b.id, b.ja])],
      ['衛星', SolarSystem.bodies.filter((b) => b.type === 'moon').map((b) => [b.id, `${b.ja}（${SolarSystem.byId[b.parent].ja}）`])],
      ['準惑星・小天体', SolarSystem.bodies.filter((b) => ['dwarf', 'asteroid', 'comet'].includes(b.type)).map((b) => [b.id, b.ja])],
    ];
    sel.innerHTML = '';
    for (const [label, items] of groups) {
      const parent = label ? document.createElement('optgroup') : sel;
      if (label) parent.label = label;
      for (const [v, text] of items) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = text;
        parent.appendChild(o);
      }
      if (label) sel.appendChild(parent);
    }
  },

  syncTargetSelect() {
    const t = Navigation.target;
    const v = !t ? '' : t.kind === 'home' ? 'home' : t.id;
    if (this._els.select.value !== v) this._els.select.value = v;
  },

  toggleWarp() {
    if (Navigation.isWarping()) Navigation.disengageWarp('ワープを解除しました');
    else Navigation.engageWarp(false);
  },

  toggleAutopilot() {
    if (Navigation.isWarping() && Navigation.warp.autopilot) {
      Navigation.disengageWarp('自動航行を中止しました');
      return;
    }
    if (!Navigation.target) {
      Navigation.warp.status = '先に目的地を選んでください';
      this._els.select.focus();
      return;
    }
    Navigation.engageWarp(true);
  },

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (e.code === 'KeyJ') this.toggleWarp();
      else if (e.code === 'KeyG') this.toggleAutopilot();
      else if (e.code === 'KeyL') {
        this.showLabels = !this.showLabels;
        savePersistedSettings({ showBodyLabels: this.showLabels });
      } else if (e.code === 'KeyM' && typeof StarMap !== 'undefined') StarMap.toggle();
    });
  },

  _buildWarning(domRoot) {
    const el = document.createElement('div');
    el.className = 'space-warning';
    domRoot.appendChild(el);
    this._els.warning = el;
  },

  // 出典（CC BY のテクスチャ・写真は見える場所にクレジットを表示する）
  _buildCredits() {
    const el = document.createElement('div');
    el.className = 'space-credits';
    el.innerHTML = '天の川: ESO/S. Brunier ・ 惑星: Solar System Scope, NASA ・ 星表: ESA Hipparcos <a href="#" class="space-credits-more">出典</a>';
    document.body.appendChild(el);
    el.querySelector('.space-credits-more').addEventListener('click', (e) => {
      e.preventDefault();
      this._showCreditsDialog();
    });
  },

  _showCreditsDialog() {
    let dlg = document.querySelector('.space-credits-dialog');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.className = 'space-credits-dialog';
      dlg.innerHTML = `
        <div class="space-credits-body">
          <h3>宇宙データの出典</h3>
          <ul>
            <li>天の川の全天写真: <b>ESO/S. Brunier</b> "The Milky Way panorama" (CC BY 4.0)。星表との位置合わせ・明るい星の除去を行って使用。</li>
            <li>惑星・月・太陽のテクスチャ: <b>Solar System Scope</b> (solarsystemscope.com, CC BY 4.0)</li>
            <li>衛星・冥王星・カロンのテクスチャ: <b>NASA</b> 3D Resources（パブリックドメイン）。未撮影の領域は補完。</li>
            <li>ケレス・ベスタのテクスチャ: 探査機ドーンの全球モザイク（<b>NASA/JPL-Caltech/UCLA/MPS/DLR/IDA</b>、USGS Astrogeology 配布）。極域の未撮影部分は補完。</li>
            <li>恒星: <b>ESA Hipparcos</b> 星表 (CDS I/239)。恒星名: IAU WGSN。</li>
            <li>惑星の軌道: JPL (E.M. Standish) "Keplerian Elements for Approximate Positions of the Major Planets"。月: Meeus『天文アルゴリズム』。衛星: JPL Horizons の暦に当てはめた平均軌道要素。自転: IAU WGCCRE。</li>
            <li>小天体（準惑星・小惑星帯・トロヤ群・太陽系外縁天体など）の軌道要素: JPL Small-Body Database</li>
            <li>銀河系の渦巻腕: Reid et al. (2019, ApJ 885, 131) の年周視差による測定。局所銀河群の位置・距離: 文献値（推定図を含む）。</li>
          </ul>
          <button class="space-credits-close">閉じる</button>
        </div>`;
      document.body.appendChild(dlg);
      dlg.querySelector('.space-credits-close').addEventListener('click', () => { dlg.style.display = 'none'; });
    }
    dlg.style.display = 'flex';
  },

  // -----------------------------------------------------------
  // ラベル・目的地マーカー
  // -----------------------------------------------------------
  _buildLabelLayer(domRoot) {
    const layer = document.createElement('div');
    layer.className = 'space-label-layer';
    domRoot.appendChild(layer);
    this._els.labelLayer = layer;

    const marker = document.createElement('div');
    marker.className = 'space-target-marker';
    marker.innerHTML = '<div class="stm-corner tl"></div><div class="stm-corner tr"></div><div class="stm-corner bl"></div><div class="stm-corner br"></div><div class="stm-text"></div>';
    layer.appendChild(marker);
    this._els.marker = marker;
    this._els.markerText = marker.querySelector('.stm-text');

    const arrow = document.createElement('div');
    arrow.className = 'space-target-arrow';
    arrow.textContent = '➤';
    layer.appendChild(arrow);
    this._els.arrow = arrow;
  },

  _labelFor(b) {
    let el = this._labels[b.id];
    if (!el) {
      el = document.createElement('div');
      el.className = `space-label space-label-${b.type}`;
      el.textContent = b.ja;
      this._els.labelLayer.appendChild(el);
      this._labels[b.id] = el;
    }
    return el;
  },

  // -----------------------------------------------------------
  // 表示用の書式
  // -----------------------------------------------------------
  formatDistance(m) {
    if (!Number.isFinite(m)) return '-';
    const a = Math.abs(m);
    if (a < 1000) return `${a.toFixed(0)} m`;
    if (a < 1e9) return `${Math.round(a / 1000).toLocaleString('ja-JP')} km`;
    if (a < 0.05 * Astro.LY) {
      const au = a / Astro.AU;
      return `${au < 10 ? au.toFixed(3) : au.toFixed(1)} au`;
    }
    const ly = a / Astro.LY;
    return `${ly < 100 ? ly.toFixed(2) : Math.round(ly).toLocaleString('ja-JP')} 光年`;
  },

  formatSpeed(v) {
    if (v < 1000) return `${v.toFixed(1)} m/s`;
    if (v < 0.01 * Astro.C) return `${(v / 1000).toLocaleString('ja-JP', { maximumFractionDigits: v < 1e5 ? 1 : 0 })} km/s`;
    const c = v / Astro.C;
    return `光速の${c < 10 ? c.toFixed(2) : Math.round(c).toLocaleString('ja-JP')}倍`;
  },

  formatDuration(sec) {
    if (!Number.isFinite(sec)) return '-';
    if (sec < 60) return `${Math.ceil(sec)}秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒`;
    if (sec < 86400 * 2) return `${(sec / 3600).toFixed(1)}時間`;
    if (sec < 86400 * 365 * 2) return `${(sec / 86400).toFixed(1)}日`;
    return `${(sec / 86400 / 365.25).toFixed(1)}年`;
  },

  // -----------------------------------------------------------
  // 毎フレーム
  // -----------------------------------------------------------
  update() {
    if (!this._els.panel) return;
    const mapOpen = typeof StarMap !== 'undefined' && StarMap.isOpen();
    this._els.panel.style.display = mapOpen ? 'none' : '';
    const now = performance.now();
    if (now - this._lastTextUpdate > 120) {
      this._lastTextUpdate = now;
      this._updateTexts();
    }
    this._updateLabels(mapOpen);
  },

  _updateTexts() {
    const ship = State.ship;
    if (!ship) return;
    const info = Navigation.locationInfo();
    const w = Navigation.warp;
    if (info) {
      const b = info.body;
      const dom = info.dominant;
      let loc;
      if (Navigation.isHome()) loc = `母港 ・ 地球 上空 ${this.formatDistance(info.altitude)}`;
      else if (dom.id !== 'sun' || info.altitude < b.rM * 50) loc = `${b.ja} 上空 ${this.formatDistance(info.altitude)}`;
      else {
        const sunD = Math.hypot(Navigation._shipU.x, Navigation._shipU.y, Navigation._shipU.z);
        loc = info.nearest && info.nearest.id !== 'sun' && info.nearestDist < 0.2 * Astro.AU
          ? `惑星間空間 ・ ${info.nearest.ja}まで ${this.formatDistance(info.nearestDist)}`
          : `惑星間空間 ・ 太陽から ${this.formatDistance(sunD)}`;
      }
      this._els.location.textContent = `現在地: ${loc}`;
    }
    if (w.active) {
      const th = w.autopilot ? '' : ` ・ スロットル ${Math.round(w.throttle * 100)}%`;
      this._els.speed.textContent = `${w.autopilot ? '自動航行' : 'ワープ'}中: ${this.formatSpeed(w.speed)}${th}`;
    } else {
      this._els.speed.textContent = `速度: ${this.formatSpeed(vecLength(ship.velocity))}${w.status ? ' ・ ' + w.status : ''}`;
    }
    const t = Navigation.target;
    if (t) {
      const a = Navigation.targetArrival();
      const u = Navigation._shipU;
      let text = `目的地: ${Navigation.targetLabel()}`;
      if (a) {
        const d = Math.hypot(a.center.x - u.x, a.center.y - u.y, a.center.z - u.z);
        text += ` ・ ${this.formatDistance(d)}`;
        if (w.active && w.autopilot && w.targetDistance) {
          // 到着点までの距離とワープの減速の仕方（距離比例）から大まかな残り時間
          const dist = w.targetDistance;
          const eta = Math.log(Math.max(dist, 1) / Math.max(a.arrivalDist * 0.06, 500)) / Navigation.WARP_K_TARGET
            + Math.max(0, dist - Navigation.WARP_MAX_SPEED / Navigation.WARP_K_TARGET) / Navigation.WARP_MAX_SPEED;
          text += ` ・ 到着まで 約${this.formatDuration(Math.max(1, eta))}`;
        }
      }
      this._els.target.textContent = text;
    } else {
      this._els.target.textContent = '目的地: 未設定（▼から選ぶか、星図で天体をタップ）';
    }
    this._els.warpBtn.innerHTML = w.active && !w.autopilot ? '⚡<span class="snb-text"> ワープ解除</span>' : '⚡<span class="snb-text"> ワープ</span>';
    this._els.warpBtn.classList.toggle('is-on', w.active && !w.autopilot);
    this._els.autoBtn.innerHTML = w.active && w.autopilot ? '🎯<span class="snb-text"> 自動航行を中止</span>' : '🎯<span class="snb-text"> 自動航行</span>';
    this._els.autoBtn.classList.toggle('is-on', w.active && w.autopilot);
    this._els.labelBtn.classList.toggle('is-off', !this.showLabels);
    this._els.orbitBtn.classList.toggle('is-off', !Universe.settings.showOrbits);
    this.syncTargetSelect();

    // 地表接近の警告
    const warnAge = performance.now() - Navigation.lastCollisionWarning;
    if (warnAge < 1500 && Navigation.collisionBody) {
      this._els.warning.textContent = `⚠ ${Navigation.collisionBody.ja}に近づきすぎています。これ以上は降下できません`;
      this._els.warning.style.display = 'block';
    } else {
      this._els.warning.style.display = 'none';
    }
  },

  _updateLabels(mapOpen) {
    const layer = this._els.labelLayer;
    const screen = Universe.frameInfo.bodyScreen;
    const target = Navigation.target;
    const targetId = target ? (target.kind === 'home' ? 'earth' : target.id) : null;
    const camU = Universe.cameraUniversePos();
    // ラベルを出す候補: 惑星・太陽・月・準惑星は常に、衛星は親の近くだけ
    const placed = [];
    for (const b of SolarSystem.bodies) {
      const el = this._labelFor(b);
      const si = screen[b.id];
      let show = !mapOpen && this.showLabels && si && si.onScreen;
      if (show && b.type === 'moon' && b.id !== 'moon') {
        const p = SolarSystem.byId[b.parent];
        const dp = Math.hypot(camU.x - p.pos.x, camU.y - p.pos.y, camU.z - p.pos.z);
        show = dp < p.soiM * 1.5;
      }
      if (show && (b.type === 'asteroid' || b.type === 'comet') && b.id !== targetId) show = si.dist < 0.3 * Astro.AU;
      // 大きく写っている天体（画面の大部分を占める）にはラベルを出さない
      if (show && si.pxRadius > 260) show = false;
      // 手前の天体に隠れている場合は出さない
      if (show) show = !this._isOccluded(b, si);
      // 近すぎるラベル同士は間引く（大きい天体を優先）
      if (show) {
        for (const p of placed) {
          if (Math.abs(p.x - si.x) < 60 && Math.abs(p.y - si.y) < 16) { show = false; break; }
        }
      }
      if (!show) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      placed.push(si);
      el.style.display = 'block';
      const off = Math.max(6, si.pxRadius + 4);
      el.style.transform = `translate(${Math.round(si.x + off)}px, ${Math.round(si.y - 8)}px)`;
      el.classList.toggle('is-target', b.id === targetId);
    }

    // 目的地マーカー
    const marker = this._els.marker;
    const arrow = this._els.arrow;
    if (!targetId || mapOpen) {
      marker.style.display = 'none';
      arrow.style.display = 'none';
      return;
    }
    const si = screen[targetId];
    if (!si) return;
    const W = window.innerWidth, H = window.innerHeight;
    let sx = si.x, sy = si.y;
    if (target.kind === 'home') {
      // 母港: ローカル原点を画面に投影
      const p = Navigation.localToUniverse({ x: 0, y: 0, z: 0 }, Navigation.homeFrame);
      const rel = new THREE.Vector3(p.x - camU.x, p.y - camU.y, p.z - camU.z).applyMatrix4(Universe.camera.matrixWorldInverse);
      const inFront = rel.z < 0;
      rel.applyMatrix4(Universe.camera.projectionMatrix);
      sx = (rel.x * 0.5 + 0.5) * W;
      sy = (-rel.y * 0.5 + 0.5) * H;
      si._homeOnScreen = inFront && Math.abs(rel.x) <= 1 && Math.abs(rel.y) <= 1;
      si._homeInFront = inFront;
    }
    const onScreen = target.kind === 'home' ? si._homeOnScreen : si.onScreen;
    const inFront = target.kind === 'home' ? si._homeInFront : si.inFront;
    if (onScreen) {
      const size = target.kind === 'home' ? 30 : Math.max(26, Math.min(400, si.pxRadius * 2 + 14));
      marker.style.display = 'block';
      marker.style.width = `${size}px`;
      marker.style.height = `${size}px`;
      marker.style.transform = `translate(${Math.round(sx - size / 2)}px, ${Math.round(sy - size / 2)}px)`;
      const u = Navigation._shipU;
      const a = Navigation.targetArrival();
      const d = a ? Math.hypot(a.center.x - u.x, a.center.y - u.y, a.center.z - u.z) : 0;
      this._els.markerText.textContent = `${Navigation.targetLabel()} ${this.formatDistance(d)}`;
      arrow.style.display = 'none';
    } else {
      marker.style.display = 'none';
      // 画面の端に方向を示す矢印
      let dx = sx - W / 2, dy = sy - H / 2;
      if (!inFront) { dx = -dx; dy = -dy; }
      const ang = Math.atan2(dy, dx);
      const r = Math.min(W, H) * 0.42;
      arrow.style.display = 'block';
      arrow.style.transform = `translate(${Math.round(W / 2 + Math.cos(ang) * r - 10)}px, ${Math.round(H / 2 + Math.sin(ang) * r - 10)}px) rotate(${ang}rad)`;
    }
  },

  _isOccluded(b, si) {
    const screen = Universe.frameInfo.bodyScreen;
    for (const o of SolarSystem.bodies) {
      if (o === b) continue;
      const so = screen[o.id];
      if (!so || !so.inFront || so.dist >= si.dist || so.pxRadius < 3) continue;
      if (Math.hypot(so.x - si.x, so.y - si.y) < so.pxRadius) return true;
    }
    return false;
  },
};
