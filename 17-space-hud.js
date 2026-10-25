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
        <select class="space-arrival-mode" title="到着のしかた（自動航行）">
          <option value="orbit">軌道に乗る</option>
          <option value="L1">L1</option><option value="L2">L2</option><option value="L3">L3</option>
          <option value="L4">L4</option><option value="L5">L5</option>
        </select>
        <label class="space-orbit-alt-wrap" title="軌道の高度（地表から）。空欄なら天体全体が見える高さ"><input type="number" class="space-orbit-alt" min="0" step="any" placeholder="高度"><span>km</span></label>
        <button class="btn-space-autopilot" title="目的地へ自動でワープ (G)">🎯<span class="snb-text"> 自動航行</span></button>
        <button class="btn-space-warp" title="手動ワープ。スロットルで速度、操縦桿で向き (J)">⚡<span class="snb-text"> ワープ</span></button>
        <button class="btn-space-orbit-att" title="周回姿勢: 下を天体の中心へ、機首を進む向きへ向け続ける (O)">🛰<span class="snb-text"> 周回姿勢</span></button>
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
    this._els.orbitAttBtn = el.querySelector('.btn-space-orbit-att');
    this._els.orbitAttBtn.addEventListener('click', () => Navigation.toggleOrbitAttitude());
    this._els.select = el.querySelector('.space-target-select');

    this._fillTargetSelect();
    // v85: 自動航行の到着のしかた（軌道の高度・ラグランジュ点）
    this._els.mode = el.querySelector('.space-arrival-mode');
    this._els.alt = el.querySelector('.space-orbit-alt');
    this._els.altWrap = el.querySelector('.space-orbit-alt-wrap');
    {
      const saved = loadPersistedSettings().arrivalMode;
      if (saved && (saved.kind === 'orbit' || (saved.kind === 'lagrange' && saved.n >= 1 && saved.n <= 5))) Navigation.arrivalMode = saved;
      const m = Navigation.arrivalMode;
      this._els.mode.value = m.kind === 'lagrange' ? `L${m.n}` : 'orbit';
      this._els.alt.value = m.altitudeKm > 0 ? String(m.altitudeKm) : '';
    }
    const applyMode = () => {
      const v = this._els.mode.value;
      const alt = Number(this._els.alt.value);
      Navigation.arrivalMode = v === 'orbit'
        ? { kind: 'orbit', altitudeKm: this._els.alt.value !== '' && alt > 0 ? alt : null }
        : { kind: 'lagrange', n: Number(v.slice(1)) };
      savePersistedSettings({ arrivalMode: Navigation.arrivalMode });
      this._syncArrivalUi();
    };
    this._els.mode.addEventListener('change', () => { applyMode(); this._els.mode.blur(); });
    this._els.alt.addEventListener('change', applyMode);
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
      ['恒星', SolarSystem.bodies.filter((b) => b.type === 'star' && !b.sys).map((b) => [b.id, b.ja])],
      ['惑星', SolarSystem.bodies.filter((b) => b.type === 'planet' && !b.sys).map((b) => [b.id, b.ja])],
      ['衛星', SolarSystem.bodies.filter((b) => b.type === 'moon').map((b) => [b.id, `${b.ja}（${SolarSystem.byId[b.parent].ja}）`])],
      ['準惑星・小天体', SolarSystem.bodies.filter((b) => ['dwarf', 'asteroid', 'comet'].includes(b.type) && !b.sys).map((b) => [b.id, b.ja])],
    ];
    // v88: 系外の星系（恒星と惑星。ハビタブルゾーンの惑星に印）と、銀河のステーション
    for (const sys of (typeof DeepSpace !== 'undefined' ? DeepSpace.systems : [])) {
      const items = SolarSystem.bodies.filter((b) => b.sys === sys.id).map((b) => [b.id,
        b.type === 'station' ? `🛰 ${b.ja}` : b.type === 'star' ? `${b.ja}（恒星）` : `${b.ja}${b.hz ? '（ハビタブル）' : ''}`]);
      const dist = sys.distLy >= 1e4 ? `${Math.round(sys.distLy / 1e4).toLocaleString('ja-JP')}万光年` : `${sys.distLy < 100 ? sys.distLy.toFixed(1) : Math.round(sys.distLy).toLocaleString('ja-JP')}光年`;
      groups.push([sys.kind === 'galaxy' ? `銀河: ${sys.ja}（${dist}）` : `恒星系: ${sys.ja}（${dist}）`, items]);
    }
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
    this._syncArrivalUi();
  },

  // 天体が目的地のときだけ、到着のしかた・高度の欄を出す（恒星にはラグランジュ点が無い）
  _syncArrivalUi() {
    const t = Navigation.target;
    const b = t && t.kind === 'body' ? SolarSystem.byId[t.id] : null;
    const show = !!b;
    this._els.mode.style.display = show ? '' : 'none';
    const hasL = !!(b && Navigation.lagrangePrimary(b));
    for (const o of this._els.mode.options) if (o.value !== 'orbit') o.disabled = !hasL;
    if (!hasL && this._els.mode.value !== 'orbit') this._els.mode.value = 'orbit';
    this._els.altWrap.style.display = show && this._els.mode.value === 'orbit' ? '' : 'none';
    if (b && this._els.mode.value === 'orbit' && document.activeElement !== this._els.alt) {
      this._els.alt.placeholder = `高度（自動 ${Math.round((Navigation.arrivalDistance(b) - b.rM) / 1000).toLocaleString()}）`;
    }
  },

  toggleWarp() {
    if (Navigation.isDeparting()) { Navigation.cancelDeparture(); return; } // v88: 出港中に押したら中止
    if (Navigation.isWarping()) Navigation.disengageWarp(`${Navigation.driveName()}を解除しました`);
    else Navigation.engageWarp(false);
  },

  toggleAutopilot() {
    if (Navigation.isDeparting()) { Navigation.cancelDeparture(); return; } // v88: 出港中に押したら中止
    if (Navigation.isWarping() && Navigation.warp.autopilot) {
      Navigation.disengageWarp('自動航行を中止しました');
      return;
    }
    // v87: 通常航行での進入中は、その速さのまま手動に切り替える
    if (Navigation.isApproaching()) {
      Navigation.cancelApproach('自動航行を中止しました（その速さのまま手動の操縦に切り替えました）');
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
      else if (e.code === 'KeyO') Navigation.toggleOrbitAttitude();
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
    return `${ly < 100 ? ly.toFixed(2) : this.formatJaNumber(ly)} 光年`;
  },

  // v88: 大きな数を「万・億・兆」で
  formatJaNumber(n) {
    const units = [[1e16, '京'], [1e12, '兆'], [1e8, '億'], [1e4, '万']];
    for (const [v, u] of units) {
      if (n >= v) {
        const x = n / v;
        return `${x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : Math.round(x).toLocaleString('ja-JP')}${u}`;
      }
    }
    return Math.round(n).toLocaleString('ja-JP');
  },

  formatSpeed(v) {
    if (v < 1000) return `${v.toFixed(1)} m/s`;
    if (v < 0.01 * Astro.C) return `${(v / 1000).toLocaleString('ja-JP', { maximumFractionDigits: v < 1e5 ? 1 : 0 })} km/s`;
    const c = v / Astro.C;
    return `光速の${c < 10 ? c.toFixed(2) : this.formatJaNumber(c)}倍`;
  },

  // v85: RMIS世界の速度単位 IKn（1 IKn = 525 km/s）。重力場機関の艦の速度表示に添える
  IKN: 525000,
  formatIKn(v) {
    const n = v / this.IKN;
    return `${n < 10 ? n.toFixed(2) : n.toLocaleString('ja-JP', { maximumFractionDigits: 1 })} IKn`;
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
      else if (dom.type === 'star' && dom.sys) {
        // v88: 系外の星系の中
        const sys = typeof DeepSpace !== 'undefined' ? DeepSpace.systems.find((s) => s.id === dom.sys) : null;
        const near = info.nearest && info.nearest.type !== 'star' && info.nearestDist < 0.05 * Astro.AU ? info.nearest : null;
        loc = near ? `${near.ja} 上空 ${this.formatDistance(info.nearestDist)}`
          : sys && sys.kind === 'galaxy' ? `${sys.ja} ・ ${dom.ja}から ${this.formatDistance(SolarSystem.distance(Navigation._shipU, dom))}`
          : `${dom.ja}星系 ・ 恒星から ${this.formatDistance(SolarSystem.distance(Navigation._shipU, dom))}`;
      } else if (dom.id !== 'sun' || info.altitude < b.rM * 50) loc = `${b.ja} 上空 ${this.formatDistance(info.altitude)}`;
      else {
        const sun = SolarSystem.byId.sun;
        const sunDist = SolarSystem.distance(Navigation._shipU, sun);
        if (sunDist > 3000 * Astro.AU) {
          // v88: 太陽系の外
          const h = SolarSystem.uToHelio(Navigation._shipU);
          const gc = typeof GalaxyModel !== 'undefined' && GalaxyModel.centerU ? Math.hypot(h.x - GalaxyModel.centerU.x, h.y - GalaxyModel.centerU.y, h.z - GalaxyModel.centerU.z) / KPC_M : 0;
          loc = gc > 25 ? `銀河間空間 ・ 太陽から ${this.formatDistance(sunDist)}` : `恒星間空間 ・ 太陽から ${this.formatDistance(sunDist)}`;
        } else {
        const sunD = sunDist;
        loc = info.nearest && info.nearest.id !== 'sun' && info.nearestDist < 0.2 * Astro.AU
          ? `惑星間空間 ・ ${info.nearest.ja}まで ${this.formatDistance(info.nearestDist)}`
          : `惑星間空間 ・ 太陽から ${this.formatDistance(sunD)}`;
        }
      }
      this._els.location.textContent = `現在地: ${loc}`;
    }
    if (w.active) {
      const th = w.autopilot ? '' : ` ・ スロットル ${Math.round(w.throttle * 100)}%`;
      if (Navigation.isInterspace()) {
        // v86: 内空航行: 船速（IKn）・航路の圧縮比・通常空間で進む実効の速さ
        const c = w.compression || 1;
        const cText = c < 10 ? c.toFixed(1) : Math.round(c).toLocaleString('ja-JP');
        this._els.speed.textContent = `${w.autopilot ? '自動航行（内空）' : '内空航行'}中: 船速 ${this.formatIKn(w.shipSpeed || 0)} ・ 圧縮比 ×${cText} ・ 実効 ${this.formatSpeed(w.speed)}${th}`;
      } else {
        const ikn = ship.gravityDrive ? `（${this.formatIKn(w.speed)}）` : '';
        this._els.speed.textContent = `${w.autopilot ? '自動航行' : 'ワープ'}中: ${this.formatSpeed(w.speed)}${ikn}${th}`;
      }
    } else {
      const v = vecLength(ship.velocity);
      const ikn = ship.gravityDrive && v >= 1000 ? `（${this.formatIKn(v)}）` : '';
      this._els.speed.textContent = `速度: ${this.formatSpeed(v)}${ikn}${w.status ? ' ・ ' + w.status : ''}`;
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
          // v88: 巡航の速さは、その艦・その場所で出せる速さ（以前は太陽系内のワープの最高速で割っていたため、
          // 内空航法で 24 IKn × 3.5億倍の艦が大マゼラン雲へ行くとき、約4日のところ約80年と表示されていた）
          const vC = w.vCruise || Navigation.WARP_MAX_SPEED;
          const eta = Math.log(Math.max(dist, 1) / Math.max(a.arrivalDist * 0.06, 500)) / Navigation.WARP_K_TARGET
            + Math.max(0, dist - vC / Navigation.WARP_K_TARGET) / vC;
          text += ` ・ 到着まで 約${this.formatDuration(Math.max(1, eta))}`;
        }
      }
      this._els.target.textContent = text;
    } else {
      this._els.target.textContent = '目的地: 未設定（▼から選ぶか、星図で天体をタップ）';
    }
    // v86: 重力場機関の艦は「内空航行」
    const isIS = Navigation.isInterspace();
    const icon = isIS ? '🌀' : '⚡', name = isIS ? '内空航行' : 'ワープ';
    const html = w.active && !w.autopilot ? `${icon}<span class="snb-text"> ${name}を解除</span>` : `${icon}<span class="snb-text"> ${name}</span>`;
    if (this._els.warpBtn.innerHTML !== html) this._els.warpBtn.innerHTML = html;
    this._els.warpBtn.title = isIS
      ? '内空航行（重力場機関）。航路を圧縮して進む。スロットルで速さ、操縦桿で向き (J)'
      : '手動ワープ。スロットルで速度、操縦桿で向き (J)';
    this._els.warpBtn.classList.toggle('is-on', w.active && !w.autopilot);
    const autoOn = (w.active && w.autopilot) || Navigation.isApproaching() || (Navigation.departure && Navigation.departure.autopilot);
    this._els.autoBtn.innerHTML = autoOn ? '🎯<span class="snb-text"> 自動航行を中止</span>' : '🎯<span class="snb-text"> 自動航行</span>';
    this._els.autoBtn.classList.toggle('is-on', autoOn);
    this._els.orbitAttBtn.classList.toggle('is-on', Navigation.isOrbitAttitude());
    this._els.labelBtn.classList.toggle('is-off', !this.showLabels);
    this._els.orbitBtn.classList.toggle('is-off', !Universe.settings.showOrbits);
    this.syncTargetSelect();

    // 地表接近の警告
    const warnAge = performance.now() - Navigation.lastCollisionWarning;
    const contactAge = typeof Collision !== 'undefined' ? performance.now() - Collision.lastContactAt : Infinity;
    if (contactAge < 1500) {
      // v79: ドッキングポートとの接触（23-collision.js）
      this._els.warning.textContent = '⚠ ドッキングポートに接触しました';
      this._els.warning.style.display = 'block';
    } else if (warnAge < 1500 && Navigation.collisionBody) {
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
      // v88: 系外の天体は、その星系の中にいるとき（恒星・ステーションは目的地のときも）
      if (show && b.sys && b.id !== targetId) {
        const host = b.type === 'star' ? b : SolarSystem.byId[b.parent];
        show = Math.hypot(camU.x - host.pos.x, camU.y - host.pos.y, camU.z - host.pos.z) < host.soiM;
      }
      // 太陽系の天体は、太陽系から遠く離れたら出さない
      if (show && !b.sys && b.id !== targetId) show = SolarSystem.distance(camU, SolarSystem.byId.sun) < 3000 * Astro.AU;
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
