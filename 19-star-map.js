// =============================================================
// 19-star-map.js
// 星図: 太陽系の天体 → 近くの恒星 → 銀河系 → 局所銀河群 までを
// 一つの画面でズームして見渡し、行き先を選ぶ
//
// v77: 新設。描画そのものは 15-universe-render.js（Universe）に任せ、
// ここでは「星図用のカメラ」の位置・向きと、ラベル・情報パネル・
// 操作（ドラッグ回転・ピンチ/ホイールでズーム・2本指/シフトでパン）だけを扱う。
// =============================================================

const StarMap = {
  _open: false,
  _root: null,
  _els: {},
  _labels: new Map(),
  focus: { kind: 'body', id: 'sun' },
  _focusU: null,          // 注視点の宇宙座標（アニメーション中の値）
  _cam: { az: 0.6, el: 0.55, dist: 6e12 },
  _anim: null,            // 注視点・距離の補間
  _pan: { x: 0, y: 0, z: 0 },
  selected: null,
  _drag: null,
  _pinch: null,
  MIN_DIST: 1e3,
  MAX_DIST: 3e23,

  init() {
    const root = document.createElement('div');
    root.className = 'star-map-root';
    root.innerHTML = `
      <div class="star-map-header">
        <div class="star-map-title">🗺 星図</div>
        <div class="star-map-scale"></div>
        <button class="star-map-close" title="閉じる (M)">✕ 閉じる</button>
      </div>
      <div class="star-map-presets">
        <button data-preset="ship">自艦</button>
        <button data-preset="earth">地球と月</button>
        <button data-preset="inner">内惑星</button>
        <button data-preset="outer">太陽系</button>
        <button data-preset="kuiper">太陽系外縁</button>
        <button data-preset="stars">近くの恒星</button>
        <button data-preset="exo">系外の星系</button>
        <button data-preset="galaxy">銀河系</button>
        <button data-preset="localgroup">局所銀河群</button>
      </div>
      <div class="star-map-time">
        <span class="star-map-date"></span>
        <button data-ts="0" title="一時停止">⏸</button>
        <button data-ts="1" title="実時間">×1</button>
        <button data-ts="3600" title="1秒で1時間">1時間/秒</button>
        <button data-ts="86400" title="1秒で1日">1日/秒</button>
        <button data-ts="2592000" title="1秒で30日">30日/秒</button>
        <button data-ts="31557600" title="1秒で1年">1年/秒</button>
        <button data-ts="now" title="現在の日時に戻す">今</button>
      </div>
      <div class="star-map-labels"></div>
      <div class="star-map-legend" style="display:none"></div>
      <div class="star-map-info" style="display:none"></div>
      <div class="star-map-hint">ドラッグ: 回転 ・ ホイール/ピンチ: ズーム ・ シフト+ドラッグ/2本指: 移動 ・ 天体名をタップで選択</div>
    `;
    document.body.appendChild(root);
    this._root = root;
    this._els.scale = root.querySelector('.star-map-scale');
    this._els.labels = root.querySelector('.star-map-labels');
    this._els.info = root.querySelector('.star-map-info');
    this._els.date = root.querySelector('.star-map-date');
    this._els.legend = root.querySelector('.star-map-legend');
    root.querySelector('.star-map-close').addEventListener('click', () => this.close());
    root.querySelectorAll('.star-map-presets button').forEach((b) => {
      b.addEventListener('click', () => this.applyPreset(b.dataset.preset));
    });
    root.querySelectorAll('.star-map-time button').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.ts === 'now') SimClock.resetToNow();
        else SimClock.timeScale = Number(b.dataset.ts);
        this._refreshTimeButtons();
      });
    });
    this._bindPointer(root);
    this._buildLabelEntries();
    // v88: 宇宙座標の原点が付け替わったら、星図のカメラの位置も同じだけずらす
    SolarSystem.onOriginShift((d) => {
      const sh = (p) => { if (p) { p.x -= d.x; p.y -= d.y; p.z -= d.z; } };
      sh(this._focusU);
      if (this._anim) sh(this._anim.from);
      if (this._lastCam) sh(this._lastCam.pos);
    });
  },

  isOpen() {
    return this._open;
  },

  toggle() {
    if (this._open) this.close();
    else this.open();
  },

  open() {
    if (!this._root) this.init();
    this._open = true;
    this._root.style.display = 'block';
    document.body.classList.add('map-open');
    if (typeof SmallBodies !== 'undefined') SmallBodies.load();
    // 最初は自艦のいる天体系を見渡す
    const u = Navigation.shipUniverse();
    const dom = SolarSystem.dominantBody(u);
    if (Navigation.target && Navigation.target.kind === 'body') this.selected = { kind: 'body', id: Navigation.target.id };
    if (dom.id === 'sun') this.applyPreset('outer', true);
    else if (dom.type === 'star' && dom.sys) this.setFocus({ kind: 'body', id: dom.id }, this._systemViewDist(dom), true);
    else this.setFocus({ kind: 'body', id: dom.id }, Math.max(dom.soiM * 0.6, dom.rM * 12), true);
    this._refreshTimeButtons();
    this._renderInfo();
  },

  close() {
    this._open = false;
    if (this._root) this._root.style.display = 'none';
    document.body.classList.remove('map-open');
    Universe.setMapMode(false);
    if (typeof SmallBodies !== 'undefined') SmallBodies.hide();
    // 早送りしたまま操縦画面に戻ると混乱しやすいので実時間に戻す（日時はそのまま）
    SimClock.timeScale = 1;
  },

  // -----------------------------------------------------------
  // 注視点
  // -----------------------------------------------------------
  _focusPoint(f) {
    const fo = f || this.focus;
    if (fo.kind === 'body') return { ...SolarSystem.byId[fo.id].pos };
    if (fo.kind === 'ship') return Navigation.shipUniverse();
    if (fo.kind === 'star') {
      const i = fo.index;
      const d = StarCatalog.dists[i] * Astro.PC;
      return SolarSystem.helioToU({ x: StarCatalog.dirs[i * 3] * d, y: StarCatalog.dirs[i * 3 + 1] * d, z: StarCatalog.dirs[i * 3 + 2] * d });
    }
    // v88: 星表・銀河は太陽中心の座標で持っているので、宇宙座標（原点は艦のいる星系）に直す
    if (fo.kind === 'galaxyLabel') return SolarSystem.helioToU(GalaxyModel.labelUniverse(fo.label));
    if (fo.kind === 'localGroup') return SolarSystem.helioToU(fo.obj.center);
    if (fo.kind === 'point') return { ...fo.u };
    return { x: 0, y: 0, z: 0 };
  },

  setFocus(f, dist, instant) {
    const from = this._focusU ? { ...this._focusU } : this._focusPoint(f);
    this.focus = f;
    this._pan = { x: 0, y: 0, z: 0 };
    const d = Math.max(this.MIN_DIST, Math.min(this.MAX_DIST, dist || this._cam.dist));
    if (instant) {
      this._focusU = this._focusPoint(f);
      this._cam.dist = d;
      this._anim = null;
    } else {
      this._anim = { t: 0, dur: 0.9, from, fromDist: this._cam.dist, toDist: d };
    }
  },

  applyPreset(name, instant) {
    const AU = Astro.AU, LY = Astro.LY;
    switch (name) {
      case 'ship': {
        const u = Navigation.shipUniverse();
        const dom = SolarSystem.dominantBody(u);
        this.setFocus({ kind: 'ship' }, dom.id === 'sun' ? 2 * AU : Math.max(dom.rM * 8, 2e7), instant);
        break;
      }
      case 'earth': this.setFocus({ kind: 'body', id: 'earth' }, 1.2e9, instant); break;
      case 'inner': this.setFocus({ kind: 'body', id: 'sun' }, 4.2 * AU, instant); this._cam.el = 0.9; break;
      case 'outer': this.setFocus({ kind: 'body', id: 'sun' }, 70 * AU, instant); this._cam.el = 0.75; break;
      case 'kuiper': this.setFocus({ kind: 'body', id: 'sun' }, 250 * AU, instant); this._cam.el = 0.6; break;
      case 'stars': this.setFocus({ kind: 'body', id: 'sun' }, 40 * LY, instant); this._cam.el = 0.45; break;
      case 'exo': this.setFocus({ kind: 'body', id: 'sun' }, 110 * LY, instant); this._cam.el = 0.5; break;
      case 'galaxy': this.setFocus({ kind: 'body', id: 'sun' }, 75000 * LY, instant); this._cam.el = 1.0; break;
      case 'localgroup': {
        // 銀河系とアンドロメダ銀河の間を中心に、2つを結ぶ線を横から見る
        const m31 = GalaxyModel.localGroup.find((g) => g.id === 'm31');
        const c = SolarSystem.helioToU(m31 ? { x: m31.center.x * 0.45, y: m31.center.y * 0.45, z: m31.center.z * 0.45 } : { x: 0, y: 0, z: 0 });
        this.setFocus({ kind: 'point', u: c }, 3.6e6 * LY, instant);
        this._cam.el = 0.45;
        if (m31) this._cam.az = this._azimuthPerpendicularTo(m31.center);
        break;
      }
      default: break;
    }
  },

  // カメラの視線が方向 v に（なるべく）垂直になる方位角
  _azimuthPerpendicularTo(v) {
    const up = this._upVector();
    let ref = new THREE.Vector3(1, 0, 0).sub(up.clone().multiplyScalar(up.x)).normalize();
    const side = new THREE.Vector3().crossVectors(up, ref).normalize();
    const dirV = new THREE.Vector3(v.x, v.y, v.z).normalize();
    let best = 0, bestScore = Infinity;
    for (let a = 0; a < Math.PI * 2; a += 0.02) {
      const d = ref.clone().multiplyScalar(Math.cos(this._cam.el) * Math.cos(a))
        .add(side.clone().multiplyScalar(Math.cos(this._cam.el) * Math.sin(a)))
        .add(up.clone().multiplyScalar(Math.sin(this._cam.el)));
      const sc = Math.abs(d.dot(dirV));
      if (sc < bestScore) { bestScore = sc; best = a; }
    }
    return best;
  },

  // -----------------------------------------------------------
  // カメラ
  // -----------------------------------------------------------
  // 縮尺に応じて「上」を黄道の北（太陽系）→ 銀河の北（銀河系）へ切り替える
  _upVector() {
    const ly = this._cam.dist / Astro.LY;
    const t = Math.max(0, Math.min(1, (Math.log10(Math.max(ly, 1e-9)) - Math.log10(0.5)) / (Math.log10(200) - Math.log10(0.5))));
    const ecl = new THREE.Vector3(0, 1, 0);
    const g = Astro.galToThree(0, 90);
    const gal = new THREE.Vector3(g.x, g.y, g.z);
    return ecl.multiplyScalar(1 - t).add(gal.multiplyScalar(t)).normalize();
  },

  _cameraState() {
    const up = this._upVector();
    // up に垂直な基準方向（春分点方向を射影）
    let ref = new THREE.Vector3(1, 0, 0).sub(up.clone().multiplyScalar(up.x)).normalize();
    if (ref.lengthSq() < 1e-6) ref = new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3().crossVectors(up, ref).normalize();
    const { az, el, dist } = this._cam;
    const dir = ref.clone().multiplyScalar(Math.cos(el) * Math.cos(az))
      .add(side.multiplyScalar(Math.cos(el) * Math.sin(az)))
      .add(up.clone().multiplyScalar(Math.sin(el)));
    const F = this._focusU;
    const target = { x: F.x + this._pan.x, y: F.y + this._pan.y, z: F.z + this._pan.z };
    const pos = { x: target.x + dir.x * dist, y: target.y + dir.y * dist, z: target.z + dir.z * dist };
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(dir.x, dir.y, dir.z), new THREE.Vector3(0, 0, 0), up);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    return { pos, target, quat: q, up };
  },

  update(dt) {
    if (!this._open) return;
    // 注視点の補間
    const goal = this._focusPoint();
    if (this._anim) {
      const a = this._anim;
      a.t += dt / a.dur;
      const k = a.t >= 1 ? 1 : 1 - Math.pow(1 - a.t, 3);
      this._focusU = {
        x: a.from.x + (goal.x - a.from.x) * k,
        y: a.from.y + (goal.y - a.from.y) * k,
        z: a.from.z + (goal.z - a.from.z) * k,
      };
      this._cam.dist = Math.exp(Math.log(a.fromDist) + (Math.log(a.toDist) - Math.log(a.fromDist)) * k);
      if (a.t >= 1) this._anim = null;
    } else {
      this._focusU = goal;
    }
    const st = this._cameraState();
    this._lastCam = st;
    // 基準天体: 注視している天体（精度のため）。それ以外は太陽
    const anchor = this.focus.kind === 'body' && !this._anim ? SolarSystem.byId[this.focus.id] : SolarSystem.byId.sun;
    const fov = typeof camera !== 'undefined' && camera ? camera.fov : 60;
    Universe.setView({
      anchorId: anchor.id,
      offset: { x: st.pos.x - anchor.pos.x, y: st.pos.y - anchor.pos.y, z: st.pos.z - anchor.pos.z },
      quat: st.quat,
      fov,
      aspect: window.innerWidth / window.innerHeight,
    });
    const sbAlpha = typeof SmallBodies !== 'undefined' && SmallBodies.isReady() ? this._smallBodyAlpha() : 0;
    Universe.setMapMode(true, (b) => this._orbitVisible(b), (b) => this._bodyMagCap(b), this._cam.dist * 2e-3, 1 - 0.6 * sbAlpha);
    if (typeof SmallBodies !== 'undefined') SmallBodies.update(sbAlpha);
  },

  // 小惑星帯などの点の濃さ（太陽系全体を見渡す縮尺のときだけ表示）
  _smallBodyAlpha() {
    const lg = Math.log10(Math.max(this._cam.dist / Astro.AU, 1e-9));
    const fadeIn = (lg - Math.log10(0.25)) / (Math.log10(0.8) - Math.log10(0.25));
    const fadeOut = (Math.log10(4000) - lg) / (Math.log10(4000) - Math.log10(1500));
    return Math.max(0, Math.min(1, fadeIn, fadeOut));
  },

  // 軌道線を出すかどうか（縮尺に合わせて間引く）
  // v88: 系外の天体なら、その星系を見ているか
  _nearSystem(b) {
    const host = b.type === 'star' ? b : SolarSystem.byId[b.parent];
    return !!(host && this._focusU && Math.hypot(this._focusU.x - host.pos.x, this._focusU.y - host.pos.y, this._focusU.z - host.pos.z) < Math.max(host.soiM || 0, 1e13));
  },
  // 系外の星系を見渡す距離（いちばん外の惑星の軌道の3倍）
  _systemViewDist(star) {
    let a = 0;
    for (const c of star.children) a = Math.max(a, c.orbitRadiusM || 0);
    return Math.max(a * 3, star.rM * 30, 1e9);
  },

  _orbitVisible(b) {
    const d = this._cam.dist;
    const AU = Astro.AU;
    if (d > 3000 * AU) return false;
    if (b.sys) return this._nearSystem(b);
    if (b.type === 'moon') {
      const p = SolarSystem.byId[b.parent];
      const camU = this._lastCam ? this._lastCam.pos : p.pos;
      const dp = Math.hypot(camU.x - p.pos.x, camU.y - p.pos.y, camU.z - p.pos.z);
      return dp < p.soiM * 3 && d < p.soiM * 4;
    }
    if (b.type === 'asteroid' || b.type === 'comet') return d < 60 * AU;
    if (b.type === 'dwarf') return d < 1500 * AU;
    return true;
  },

  // 星図での光点の最低限の明るさ（null=表示しない）
  _bodyMagCap(b) {
    const d = this._cam.dist;
    const AU = Astro.AU;
    if (d > 8000 * AU) return null;
    if (b.sys) return this._nearSystem(b) ? 1.0 : null;
    if (b.type === 'planet') return 1.0;
    if (b.type === 'dwarf') return 2.5;
    if (b.type === 'asteroid' || b.type === 'comet') return d < 60 * AU ? 3.0 : null;
    if (b.type === 'moon') return this._orbitVisible(b) ? 2.5 : null;
    return null;
  },

  // -----------------------------------------------------------
  // ラベル
  // -----------------------------------------------------------
  _buildLabelEntries() {
    this._entries = [];
    // v88: 局所銀河群の銀河の名前を先に（重なったときに、ステーションの名前より優先して出す）
    if (typeof GalaxyModel !== 'undefined') {
      for (const g of GalaxyModel.localGroup) {
        this._entries.push({ key: `l:${g.id}`, kind: 'localGroup', obj: g, text: g.ja, cls: 'sm-galaxy' });
      }
    }
    for (const b of SolarSystem.bodies) {
      this._entries.push({ key: `b:${b.id}`, kind: 'body', id: b.id, text: b.ja, cls: `sm-${b.type}` });
    }
    // 恒星: 名前のある星のうち、距離がわかるもの
    for (const nm of StarCatalog.names) {
      if (!(StarCatalog.dists[nm.index] > 0)) continue;
      this._entries.push({ key: `s:${nm.index}`, kind: 'star', index: nm.index, text: nm.ja || nm.en, cls: 'sm-starname' });
    }
    if (typeof GalaxyModel !== 'undefined') {
      for (const L of GalaxyModel.labels) {
        if (L.isSun) continue;
        this._entries.push({ key: `g:${L.id}`, kind: 'galaxyLabel', label: L, text: L.ja, cls: L.isArm ? 'sm-arm' : 'sm-gc' });
      }
    }
    if (typeof SmallBodies !== 'undefined') {
      for (const r of SmallBodies.REGIONS) {
        this._entries.push({ key: `r:${r.id}`, kind: 'region', region: r, text: r.ja, cls: 'sm-region' });
      }
    }
    this._entries.push({ key: 'ship', kind: 'ship', text: '▲ 自艦', cls: 'sm-ship' });
    this._entries.push({ key: 'home', kind: 'home', text: '⌂ 母港', cls: 'sm-home' });
  },

  _entryUniverse(e) {
    switch (e.kind) {
      case 'body': return SolarSystem.byId[e.id].pos;
      case 'star': return this._focusPoint({ kind: 'star', index: e.index });
      case 'galaxyLabel': return SolarSystem.helioToU(GalaxyModel.labelUniverse(e.label));
      case 'localGroup': return SolarSystem.helioToU(e.obj.center);
      case 'region': return SmallBodies.regionUniverse(e.region);
      case 'ship': return Navigation.shipUniverse();
      case 'home': return Navigation.frameOrigin(Navigation.homeFrame);
      default: return null;
    }
  },

  // ラベルを出すかどうか（縮尺に応じて）
  _entryVisible(e, distFromCam) {
    const d = this._cam.dist;
    const AU = Astro.AU, LY = Astro.LY;
    switch (e.kind) {
      case 'body': {
        const b = SolarSystem.byId[e.id];
        // v88: 系外の天体。恒星は恒星を見渡す縮尺で、ステーションは局所銀河群の縮尺でも、
        // 惑星はその星系を見ているときだけ
        if (b.sys) {
          const near = this._nearSystem(b);
          const galaxy = typeof DeepSpace !== 'undefined' && DeepSpace.systems.find((s) => s.id === b.sys && s.kind === 'galaxy');
          if (b.type === 'star') return (near && d < 2 * LY) || (!galaxy && d > 0.3 * LY && d < 6000 * LY && distFromCam < d * 3);
          if (b.type === 'station') return near || d > 60000 * LY;
          return near && d < 3000 * AU;
        }
        if (b.type === 'star') return d < 2 * LY;
        if (b.type === 'planet') return d < 3000 * AU;
        if (b.type === 'dwarf') return d < 2000 * AU && (b.id !== 'sedna' || d > 20 * AU);
        if (b.type === 'asteroid' || b.type === 'comet') return d < 40 * AU;
        if (b.type === 'moon') return this._orbitVisible(b);
        return false;
      }
      case 'star': {
        if (d < 0.3 * LY || d > 6000 * LY) return false;
        const starDist = StarCatalog.dists[e.index] * 3.26156 * LY;
        // ズームに応じて近い星から順に名前を出す
        return starDist < d * 1.6 && distFromCam < d * 3;
      }
      case 'galaxyLabel': return d > 8000 * LY && d < 1e6 * LY;
      case 'localGroup': return d > 60000 * LY;
      case 'region': return SmallBodies.isReady() && d > e.region.minAU * AU && d < e.region.maxAU * AU;
      case 'ship': return d < 300 * AU;
      case 'home': return d < 2e9;
      default: return false;
    }
  },

  _labelEl(e) {
    let el = this._labels.get(e.key);
    if (!el) {
      el = document.createElement('div');
      el.className = `sm-label ${e.cls}`;
      el.textContent = e.text;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._select(e);
      });
      this._els.labels.appendChild(el);
      this._labels.set(e.key, el);
    }
    return el;
  },

  _updateLabels() {
    const cam = Universe.camera;
    const camU = this._lastCam.pos;
    const W = window.innerWidth, H = window.innerHeight;
    const v = new THREE.Vector3();
    const placed = [];
    const selKey = this.selected ? this._selectedKey() : null;
    for (const e of this._entries) {
      const el = this._labelEl(e);
      const u = this._entryUniverse(e);
      let show = false;
      let x = 0, y = 0;
      if (u) {
        const dist = Math.hypot(u.x - camU.x, u.y - camU.y, u.z - camU.z);
        show = this._entryVisible(e, dist) || e.key === selKey;
        if (show) {
          v.set(u.x - camU.x, u.y - camU.y, u.z - camU.z).applyMatrix4(cam.matrixWorldInverse);
          if (v.z >= 0) show = false;
          else {
            v.applyMatrix4(cam.projectionMatrix);
            x = (v.x * 0.5 + 0.5) * W;
            y = (-v.y * 0.5 + 0.5) * H;
            if (x < -50 || x > W + 50 || y < -20 || y > H + 20) show = false;
          }
        }
        // 重なりの間引き（選択中のものは常に表示）
        if (show && e.key !== selKey) {
          for (const p of placed) {
            if (Math.abs(p.x - x) < 70 && Math.abs(p.y - y) < 14) { show = false; break; }
          }
        }
      }
      if (!show) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      placed.push({ x, y });
      el.style.display = 'block';
      el.style.transform = `translate(${Math.round(x + 6)}px, ${Math.round(y - 8)}px)`;
      el.classList.toggle('is-selected', e.key === selKey);
      el.classList.toggle('is-target', this._isTargetEntry(e));
    }
  },

  _isTargetEntry(e) {
    const t = Navigation.target;
    if (!t) return false;
    if (t.kind === 'home') return e.kind === 'home';
    return e.kind === 'body' && e.id === t.id;
  },

  _selectedKey() {
    const s = this.selected;
    if (!s) return null;
    if (s.kind === 'body') return `b:${s.id}`;
    if (s.kind === 'star') return `s:${s.index}`;
    if (s.kind === 'galaxyLabel') return `g:${s.label.id}`;
    if (s.kind === 'localGroup') return `l:${s.obj.id}`;
    if (s.kind === 'region') return `r:${s.region.id}`;
    return s.kind;
  },

  _select(e) {
    if (e.kind === 'body') this.selected = { kind: 'body', id: e.id };
    else if (e.kind === 'star') this.selected = { kind: 'star', index: e.index };
    else if (e.kind === 'galaxyLabel') this.selected = { kind: 'galaxyLabel', label: e.label };
    else if (e.kind === 'localGroup') this.selected = { kind: 'localGroup', obj: e.obj };
    else if (e.kind === 'region') this.selected = { kind: 'region', region: e.region };
    else if (e.kind === 'ship') this.selected = { kind: 'ship' };
    else if (e.kind === 'home') this.selected = { kind: 'home' };
    this._renderInfo();
  },

  // -----------------------------------------------------------
  // 情報パネル
  // -----------------------------------------------------------
  _renderInfo() {
    const box = this._els.info;
    const s = this.selected;
    if (!s) { box.style.display = 'none'; return; }
    const fmtD = (m) => SpaceHud.formatDistance(m);
    const shipU = Navigation.shipUniverse();
    let html = '';
    let actions = [];
    if (s.kind === 'body') {
      const b = SolarSystem.byId[s.id];
      const typeJa = { star: '恒星', planet: '惑星', dwarf: '準惑星', moon: '衛星', asteroid: '小惑星', comet: '彗星', station: '宇宙ステーション' }[b.type];
      const parent = b.parent ? SolarSystem.byId[b.parent] : null;
      const dShip = SolarSystem.distance(shipU, b);
      const dSun = SolarSystem.distance(b.pos, SolarSystem.byId.sun);
      const R = b.meanRadiusM < 1e4 ? `${(b.meanRadiusM / 1000).toFixed(1)}` : Math.round(b.meanRadiusM / 1000).toLocaleString('ja-JP');
      html += `<div class="smi-title">${b.ja}${b.en !== b.ja ? ` <span class="smi-en">${b.en}</span>` : ''}</div>`;
      // v88: 系外の天体
      const sub = b.sys ? (b.type === 'planet' ? `（${parent.ja}を回る${b.hz ? '・ハビタブルゾーン' : ''}）` : b.type === 'station' ? `（${b.galaxy}・${b.area}）` : `（地球から ${fmtD(dSun)}）`)
        : parent ? `（${parent.ja}の衛星）` : '';
      html += `<div class="smi-type">${typeJa}${sub}</div>`;
      html += `<div class="smi-row">半径: ${R} km</div>`;
      if (b.sys && b.type !== 'star') html += `<div class="smi-row">${parent.ja}からの距離: ${fmtD(SolarSystem.distance(b.pos, parent))}</div>`;
      if (b.type !== 'star' && !b.sys) html += `<div class="smi-row">太陽からの距離: ${fmtD(dSun)}</div>`;
      html += `<div class="smi-row">自艦からの距離: ${fmtD(dShip)}</div>`;
      html += `<div class="smi-desc">${b.desc || ''}</div>`;
      actions = [['target', '🎯 目的地に設定'], ['go', '⚡ 自動航行で向かう'], ['focus', '◎ ここを中心に']];
    } else if (s.kind === 'star') {
      const i = s.index;
      const nm = StarCatalog.nameByIndex[i];
      const dPc = StarCatalog.dists[i];
      html += `<div class="smi-title">${nm ? (nm.ja || nm.en) : '恒星'} ${nm && nm.ja ? `<span class="smi-en">${nm.en}</span>` : ''}</div>`;
      if (nm && nm.bayer) html += `<div class="smi-type">${nm.bayer}</div>`;
      html += `<div class="smi-row">距離: ${(dPc * 3.26156).toFixed(dPc * 3.26 < 100 ? 2 : 0)} 光年</div>`;
      html += `<div class="smi-row">地球から見た明るさ: ${StarCatalog.mags[i].toFixed(2)} 等</div>`;
      const absMag = StarCatalog.mags[i] - 5 * Math.log10(dPc / 10);
      html += `<div class="smi-row">絶対等級: ${absMag.toFixed(2)} 等（太陽は4.83等）</div>`;
      html += `<div class="smi-desc">光がここから地球に届くまで約${(dPc * 3.26156).toFixed(dPc * 3.26 < 100 ? 1 : 0)}年かかります。</div>`;
      actions = [['focus', '◎ ここを中心に']];
    } else if (s.kind === 'galaxyLabel') {
      const L = s.label;
      html += `<div class="smi-title">${L.ja}</div>`;
      if (L.id === 'gc') {
        html += '<div class="smi-desc">銀河系の中心。太陽の約400万倍の質量をもつ超大質量ブラックホール「いて座A*」がある。太陽系からの距離 約2万6600光年。</div>';
      } else if (L.isArm) {
        html += '<div class="smi-desc">銀河系の渦巻腕。位置は電波望遠鏡で測った星形成領域の年周視差（Reid et al. 2019）に基づく。観測が難しい銀河の反対側は推定。</div>';
      }
      actions = [['focus', '◎ ここを中心に']];
    } else if (s.kind === 'localGroup') {
      const g = s.obj;
      html += `<div class="smi-title">${g.ja}</div>`;
      html += `<div class="smi-row">距離: ${Math.round(g.distM / Astro.LY).toLocaleString('ja-JP')} 光年</div>`;
      html += `<div class="smi-row">大きさ（半径）: 約${Math.round(g.radiusM / Astro.LY).toLocaleString('ja-JP')} 光年</div>`;
      actions = [['focus', '◎ ここを中心に']];
      // v88: この銀河の宇宙ステーション
      const st = typeof GALAXY_STATIONS !== 'undefined' ? GALAXY_STATIONS.find((x) => x.galaxyId === g.id) : null;
      if (st) {
        html += `<div class="smi-desc">🛰 ${st.ja}（${st.area}）: ${st.desc}</div>`;
        actions = [['stationTarget', `🎯 ${st.ja}を目的地に`], ['stationGo', '⚡ 自動航行で向かう'], ['focus', '◎ ここを中心に']];
      }
    } else if (s.kind === 'region') {
      const r = s.region;
      const n = SmallBodies.counts[r.group] || 0;
      html += `<div class="smi-title">${r.ja}</div>`;
      html += `<div class="smi-row">表示中の天体: ${n.toLocaleString('ja-JP')}個</div>`;
      html += `<div class="smi-desc">${r.desc}</div>`;
      actions = [['focus', '◎ ここを中心に']];
    } else if (s.kind === 'ship') {
      html += '<div class="smi-title">自艦</div>';
      const info = Navigation.locationInfo();
      if (info) html += `<div class="smi-row">${info.body.ja}から ${fmtD(info.altitude)}</div>`;
      actions = [['focus', '◎ ここを中心に']];
    } else if (s.kind === 'home') {
      html += '<div class="smi-title">母港（地球周回軌道）</div>';
      html += `<div class="smi-desc">ドッキングポートのある母港。地球の高度${Navigation.HOME_ALTITUDE_KM.toLocaleString('ja-JP')}kmにある。</div>`;
      actions = [['target', '🎯 目的地に設定'], ['go', '⚡ 自動航行で戻る']];
    }
    html += '<div class="smi-actions">' + actions.map(([k, t]) => `<button data-act="${k}">${t}</button>`).join('') + '<button data-act="close">✕</button></div>';
    box.innerHTML = html;
    box.style.display = 'block';
    box.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._doAction(btn.dataset.act);
      });
    });
  },

  _doAction(act) {
    const s = this.selected;
    if (!s) return;
    if (act === 'close') { this.selected = null; this._renderInfo(); return; }
    if (act === 'focus') {
      if (s.kind === 'body') {
        const b = SolarSystem.byId[s.id];
        const d = b.type === 'star' ? (b.sys ? this._systemViewDist(b) : 30 * b.rM) : b.type === 'station' ? b.rM * 8 : b.type === 'moon' ? b.rM * 8 : Math.max(b.rM * 8, (b.rings ? b.rings.outer * 1000 * 4 : 0));
        this.setFocus({ kind: 'body', id: s.id }, Math.max(d, 2e5));
      } else if (s.kind === 'star') {
        this.setFocus({ kind: 'star', index: s.index }, Math.min(this._cam.dist, 8 * Astro.LY));
      } else if (s.kind === 'galaxyLabel') {
        this.setFocus({ kind: 'galaxyLabel', label: s.label }, this._cam.dist);
      } else if (s.kind === 'localGroup') {
        this.setFocus({ kind: 'localGroup', obj: s.obj }, s.obj.radiusM * 6);
      } else if (s.kind === 'region') {
        // トロヤ群はその場所を、それ以外は太陽を中心に全体を見渡す
        const r = s.region;
        if (r.group === 'trojan') this.setFocus({ kind: 'point', u: SmallBodies.regionUniverse(r) }, r.focusAU * Astro.AU);
        else this.setFocus({ kind: 'body', id: 'sun' }, r.focusAU * Astro.AU);
      } else if (s.kind === 'ship') {
        this.applyPreset('ship');
      }
      return;
    }
    // v88: 銀河の宇宙ステーションへ
    if ((act === 'stationTarget' || act === 'stationGo') && s.kind === 'localGroup') {
      const st = GALAXY_STATIONS.find((x) => x.galaxyId === s.obj.id);
      if (!st) return;
      this.selected = { kind: 'body', id: st.id };
      return this._doAction(act === 'stationGo' ? 'go' : 'target');
    }
    if (act === 'target' || act === 'go') {
      if (s.kind === 'body') Navigation.setTarget({ kind: 'body', id: s.id });
      else if (s.kind === 'home') Navigation.setTarget({ kind: 'home' });
      SpaceHud.syncTargetSelect();
      if (act === 'go') {
        this.close();
        if (Navigation.isWarping()) Navigation.disengageWarp('');
        Navigation.engageWarp(true);
      }
      this._renderInfo();
    }
  },

  // -----------------------------------------------------------
  // 表示の更新（毎フレーム、update の後）
  // -----------------------------------------------------------
  postRender() {
    if (!this._open || !this._lastCam) return;
    this._updateLabels();
    const now = performance.now();
    if (!this._lastText || now - this._lastText > 200) {
      this._lastText = now;
      // 縮尺: 画面の高さが何に相当するか
      const h = 2 * this._cam.dist * Math.tan((Universe.camera.fov * Math.PI) / 360);
      this._els.scale.textContent = `画面の縦幅 ≈ ${SpaceHud.formatDistance(h)}`;
      const d = SimClock.toDate();
      this._els.date.textContent = d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      if (this.selected && (this.selected.kind === 'body' || this.selected.kind === 'ship')) this._renderInfoDistancesOnly();
      this._updateLegend();
    }
  },

  // 小天体の色分けの凡例
  _updateLegend() {
    const el = this._els.legend;
    const show = typeof SmallBodies !== 'undefined' && SmallBodies.isReady() && this._smallBodyAlpha() > 0.05;
    el.style.display = show ? 'flex' : 'none';
    if (!show || el.childElementCount) return;
    for (const [key, g] of Object.entries(SmallBodies.GROUPS)) {
      const n = SmallBodies.counts[key] || 0;
      if (!n) continue;
      const c = g.color.map((v) => Math.round(v * 255)).join(',');
      const item = document.createElement('span');
      item.className = 'sml-item';
      item.innerHTML = `<i style="background: rgb(${c})"></i>${g.ja} ${n.toLocaleString('ja-JP')}`;
      el.appendChild(item);
    }
  },

  _renderInfoDistancesOnly() {
    // 距離表示だけ更新（ボタンのフォーカスなどを壊さないよう、再描画は控えめに）
    if (!this._infoTick) this._infoTick = 0;
    this._infoTick++;
    if (this._infoTick % 5 === 0) this._renderInfo();
  },

  _refreshTimeButtons() {
    if (!this._root) return;
    this._root.querySelectorAll('.star-map-time button[data-ts]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.ts !== 'now' && Number(b.dataset.ts) === SimClock.timeScale);
    });
  },

  // -----------------------------------------------------------
  // 操作
  // -----------------------------------------------------------
  _bindPointer(root) {
    const isUi = (t) => t.closest('.star-map-header, .star-map-presets, .star-map-time, .star-map-info, .star-map-legend, .sm-label');
    root.addEventListener('mousedown', (e) => {
      if (isUi(e.target)) return;
      this._drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2, moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this._drag.moved = true;
      if (this._drag.pan) this._applyPan(dx, dy);
      else this._applyRotate(dx, dy);
    });
    window.addEventListener('mouseup', () => { this._drag = null; });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('wheel', (e) => {
      if (isUi(e.target)) return;
      e.preventDefault();
      this._applyZoom(Math.exp(e.deltaY * 0.0015));
    }, { passive: false });

    const dist2 = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    root.addEventListener('touchstart', (e) => {
      if (isUi(e.target)) return;
      e.preventDefault();
      if (e.touches.length === 1) {
        this._drag = { x: e.touches[0].clientX, y: e.touches[0].clientY, pan: false };
        this._pinch = null;
      } else if (e.touches.length === 2) {
        this._drag = null;
        this._pinch = { d: dist2(e.touches), m: mid(e.touches) };
      }
    }, { passive: false });
    root.addEventListener('touchmove', (e) => {
      if (isUi(e.target)) return;
      e.preventDefault();
      if (e.touches.length === 1 && this._drag) {
        const t = e.touches[0];
        this._applyRotate(t.clientX - this._drag.x, t.clientY - this._drag.y);
        this._drag.x = t.clientX; this._drag.y = t.clientY;
      } else if (e.touches.length === 2 && this._pinch) {
        const d = dist2(e.touches), m = mid(e.touches);
        if (d > 0) this._applyZoom(this._pinch.d / d);
        this._applyPan(m.x - this._pinch.m.x, m.y - this._pinch.m.y);
        this._pinch = { d, m };
      }
    }, { passive: false });
    root.addEventListener('touchend', (e) => {
      if (e.touches.length === 0) { this._drag = null; this._pinch = null; }
      else if (e.touches.length === 1) {
        this._pinch = null;
        this._drag = { x: e.touches[0].clientX, y: e.touches[0].clientY, pan: false };
      }
    });
  },

  _applyRotate(dx, dy) {
    this._cam.az -= dx * 0.006;
    this._cam.el = Math.max(-1.45, Math.min(1.45, this._cam.el + dy * 0.006));
  },

  _applyZoom(factor) {
    const minD = this._minDistForFocus();
    this._cam.dist = Math.max(minD, Math.min(this.MAX_DIST, this._cam.dist * factor));
    if (this._anim) this._anim.toDist = this._cam.dist;
  },

  _minDistForFocus() {
    if (this.focus.kind === 'body') {
      const b = SolarSystem.byId[this.focus.id];
      return Math.max(b.rM, b.rpM, b.rbM) * 1.6;
    }
    return this.MIN_DIST;
  },

  _applyPan(dx, dy) {
    if (!this._lastCam) return;
    const q = this._lastCam.quat;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const k = this._cam.dist * 0.0018;
    this._pan.x += (-right.x * dx + up.x * dy) * k;
    this._pan.y += (-right.y * dx + up.y * dy) * k;
    this._pan.z += (-right.z * dx + up.z * dy) * k;
  },
};
