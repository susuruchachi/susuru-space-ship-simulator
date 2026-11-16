// =============================================================
// 32-voyage.js
// v89: 定期航路（客船の航海）と、航海中の出来事
//
// サイドメニューの「定期航路」から行き先を選ぶと、乗客を乗せた航海が始まる（自動航行で出港する。手動に切り替えてもよい）。
// 目的地に着くと、3つの点で採点される:
//   定時性   40点: ダイヤ（その艦の機関で、ふつうに着ける時間の見積もりに余裕を足したもの）に間に合ったか
//   乗り心地 40点: 急な回頭・横揺れ・（噴射で進む艦は）強い加速、出来事での揺れが少ないほど高い
//   もてなし 20点: 航海中の出来事での判断（救難信号に応える、乗客の願いを聞く、など）
// 航海中には、出来事（流星群・機関の不調・救難信号・急病人・恒星フレア・乗客の願い）が起き、どうするかを選ぶ。
// 選び方で、足止めの時間・乗り心地・もてなしの点が変わる。選ばないと、時間切れで安全な方を選ぶ。
// 成績（航路ごとの最高点）と運賃の合計は、端末に覚える。
// =============================================================

const VOYAGE_STORAGE_KEY = 'spaceSimVoyage';
const VOYAGE_DESTS = ['moon', 'mercury', 'venus', 'mars', 'ceres', 'jupiter', 'saturn', 'titan', 'uranus', 'neptune', 'pluto'];

// 出来事。options: label 選ぶ言葉 / note 何が起きるか / hold 足止め [s] / comfort 乗り心地 ± / service もてなし ±
//   risk: { p 確率, text, comfort, hold } うまくいかなかったとき / rush: ダイヤを早める（急病人）
const VOYAGE_EVENTS = [
  {
    id: 'meteor', title: '流星群', text: '進路の先に、流星群が広がっています。',
    options: [
      { label: '速度を落として通り抜ける', note: '15秒の足止め・安全', hold: 15, safe: true, done: '速度を落として、流星群を無事に通り抜けました。' },
      { label: 'このまま突っ切る', note: '足止めなし。4割で船体に当たる', done: '流星群を無傷で突っ切りました。', risk: { p: 0.4, text: '流星が船体に当たりました。船内が大きく揺れました。', comfort: -18, hold: 6 } },
    ],
  },
  {
    id: 'engine', title: '機関の不調', text: '機関室から報告: 機関の出力が安定しません。',
    options: [
      { label: '止めて点検する', note: '20秒の足止め・確実に直る', hold: 20, safe: true, done: '点検が終わり、機関は元どおりになりました。' },
      { label: 'だましだまし進む', note: '足止めなし。3割で止まってしまう', done: '機関はなんとか持ちこたえました。', risk: { p: 0.3, text: '機関が止まりました。船内が揺れ、復旧に時間がかかりました。', comfort: -10, hold: 28 } },
    ],
  },
  {
    id: 'distress', title: '救難信号', text: '近くの小型船から、救難信号を受け取りました。',
    options: [
      { label: '救助に向かう', note: '25秒の足止め・もてなし +8', hold: 25, service: 8, done: '乗員を救助しました。乗客から拍手が起きました。' },
      { label: '近くの船に任せて先を急ぐ', note: '足止めなし・もてなし −6', service: -6, safe: true, done: '救助をほかの船に任せました。乗客は少し不安そうです。' },
    ],
  },
  {
    id: 'medical', title: '急病人', text: '船医から報告: 乗客に急病人が出ました。早く港へ着きたいところです。',
    options: [
      { label: '全速で急ぐ', note: 'ダイヤが 15% 早まる。間に合えば もてなし +8、揺らすと響く', rush: 0.85, service: 8, done: '全速で港を目指します。揺れに気をつけてください。' },
      { label: '船内で手当てを続ける', note: 'ダイヤはそのまま・乗り心地 −5', comfort: -5, safe: true, done: '船医が手当てを続けます。' },
    ],
  },
  {
    id: 'flare', title: '恒星フレア', text: '恒星の表面で大きなフレアが起きました。強い放射が来ます。',
    options: [
      { label: '遮蔽して、通り過ぎるのを待つ', note: '12秒の足止め・安全', hold: 12, safe: true, done: '放射をやり過ごしました。' },
      { label: 'かまわず進む', note: '足止めなし・乗り心地 −12（計器が乱れ、船内が不安に）', comfort: -12, done: '放射の中を進みました。船内の灯りがちらつき、乗客が不安がっています。' },
    ],
  },
  {
    id: 'view', title: '乗客の願い', text: '乗客から: 「この先の眺めを、ゆっくり見たい」。',
    options: [
      { label: '速度を落として眺めを見せる', note: '10秒の足止め・もてなし +6', hold: 10, service: 6, done: '乗客は窓の外の眺めを楽しんでいます。' },
      { label: 'ダイヤを優先する', note: '足止めなし', safe: true, done: 'ダイヤどおりに進みます。' },
    ],
  },
];

const Voyage = {
  active: null,   // 航海中: { dest, from, sched, t, comfort, service, hold, events:[...], log:[...] }
  _store: null,

  init() {
    this._load();
    this._buildUi();
    setInterval(() => { try { this._syncUi(); } catch (e) { /* ignore */ } }, 250);
  },

  _load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(VOYAGE_STORAGE_KEY) || 'null'); } catch (e) { /* ignore */ }
    this._store = s && typeof s === 'object' ? { income: Number(s.income) || 0, count: Number(s.count) || 0, best: s.best && typeof s.best === 'object' ? s.best : {} } : { income: 0, count: 0, best: {} };
  },
  _save() { try { localStorage.setItem(VOYAGE_STORAGE_KEY, JSON.stringify(this._store)); } catch (e) { /* ignore */ } },

  // 乗客の数（艦の大きさから）
  passengers(ship) {
    const L = (ship && ship.size) || 50;
    return Math.round(clamp(L * L * 0.02, 12, 6000));
  },
  // いまいる場所の名前と、航路の出発地のキー
  _here() {
    if (typeof Navigation === 'undefined' || !Navigation.frame) return { key: 'space', label: '宇宙' };
    if (Navigation.frame.isHome) return { key: 'home', label: '母港' };
    const info = Navigation.locationInfo ? Navigation.locationInfo() : null;
    const b = info && info.body ? info.body : (typeof SolarSystem !== 'undefined' ? SolarSystem.byId[Navigation.frame.bodyId] : null);
    return b ? { key: b.id, label: b.ja || b.id } : { key: 'space', label: '宇宙' };
  },
  // 行き先の一覧（いまいる場所は除く）
  destinations() {
    const here = this._here();
    const out = [];
    if (here.key !== 'home') out.push({ kind: 'home', key: 'home', label: '母港' });
    if (typeof SolarSystem !== 'undefined') for (const id of VOYAGE_DESTS) {
      const b = SolarSystem.byId[id];
      if (b && id !== here.key) out.push({ kind: 'body', id, key: id, label: b.ja || id });
    }
    return out;
  },
  // 目的地までの距離 [m]
  _distanceTo(tg) {
    const a = Navigation.targetArrival(tg);
    if (!a) return 0;
    const u = Navigation.shipUniverse();
    return Math.hypot(a.point.x - u.x, a.point.y - u.y, a.point.z - u.z);
  },
  // ふつうに着ける時間の見積もり [s]: 出港 → 向きを合わせる → 加速（速さは対数で上がる）→ 目的地の手前で距離に比例して減速 → 通常航行で進入
  estimate(tg, ship) {
    const N = Navigation;
    const D = Math.max(1, this._distanceTo(tg));
    let t = 0;
    if (N._nearPort && N._nearPort(ship)) t += N.DEPART_DIST / N.DEPART_SPEED + 4; // 出港（前進で 3 km）
    t += 12; // 機首を目的地へ向ける
    const inter = ship.interspace && ship.gravityDrive && N.isInterspace !== undefined && ship.interspace.maxSpeed > 0 && ship.interspace.maxCompression > 0;
    const vMax = inter ? ship.interspace.maxSpeed * ship.interspace.maxCompression : N.WARP_MAX_SPEED;
    const vPeak = Math.max(N.WARP_MIN_SPEED, Math.min(vMax, D * N.WARP_K_TARGET));
    t += Math.log10(vPeak / N.WARP_MIN_SPEED) / N.WARP_ACCEL_DECADES + 3; // 加速
    if (inter) t += (ship.interspace.maxSpeed / SHIP_IKN) / N.IS_ACCEL_IKN * 0.5; // 内空航法: 船速が上がるまで
    t += D / vPeak; // 巡航
    // 減速: 速さ = 残りの距離 × K（距離が e 分の 1 になるのに 1/K 秒）
    const dDrop = N.dropDistance ? N.dropDistance(ship) : 0;
    const dEnd = Math.max(dDrop, N.ARRIVAL_DISTANCE);
    t += Math.log(Math.max(1.0001, (vPeak / N.WARP_K_TARGET) / dEnd)) / N.WARP_K_TARGET;
    // 通常航行での進入（止まり切れる速さで）
    if (dDrop > 0) { const vN = Math.min(N.normalMaxSpeed(ship), Math.sqrt(2 * N.brakeAccel(ship) * dDrop)); t += (2 * dDrop) / Math.max(1, vN) + 6; }
    else t += 6;
    return t;
  },
  // ダイヤ [s]（見積もりに余裕を足す）
  schedule(tg, ship) { return Math.ceil((this.estimate(tg, ship) * 1.15 + 15) / 5) * 5; },
  routeKey(from, tg) { return `${from}>${tg.key || tg.id || 'home'}`; },

  start(dest) {
    const ship = State.ship;
    if (!ship || this.active || typeof Navigation === 'undefined') return false;
    if (typeof PRACTICE_MODE !== 'undefined' && PRACTICE_MODE) return false;
    const tg = dest.kind === 'home' ? { kind: 'home' } : { kind: 'body', id: dest.id };
    const here = this._here();
    Navigation.arrivalMode = { kind: 'orbit', altitudeKm: null };
    Navigation.setTarget(tg);
    if (typeof SpaceHud !== 'undefined' && SpaceHud._syncTargetSelect) { try { SpaceHud._syncTargetSelect(); } catch (e) { /* ignore */ } }
    const sched = this.schedule(tg, ship);
    const dist = this._distanceTo(tg);
    // 出来事: 航海の長さに応じて 1〜3 回。起きる時刻は、ダイヤの 15%〜70% のあいだ
    //   起きる時刻は、ふつうに着ける見積もりの 15%〜65% のあいだ（着いたあとに残らないように）
    const est = this.estimate(tg, ship);
    const n = est < 50 ? 1 : est < 110 ? 2 : 3;
    const pool = VOYAGE_EVENTS.slice().sort(() => Math.random() - 0.5).slice(0, n);
    const events = pool.map((ev, i) => ({ ev, at: est * (0.15 + (0.5 * (i + Math.random() * 0.8)) / n) })).sort((a, b) => a.at - b.at);
    this.active = {
      tg, dest, from: here, key: this.routeKey(here.key, dest), sched, sched0: sched, dist, t: 0,
      comfort: 100, service: 10, hold: 0, rush: false, events, card: null, log: [], pax: this.passengers(ship),
      prevV: null, prevFrame: null, hardT: (typeof Planetfall !== 'undefined' && Planetfall._hardT) || 0,
    };
    this._closePanel();
    this._toast(`出港: ${here.label} → ${dest.label}（乗客 ${this.active.pax.toLocaleString()} 名・ダイヤ ${this._fmt(sched)}）`);
    Navigation.engageWarp(true);
    this._syncUi(true);
    return true;
  },
  abort(reason) {
    if (!this.active) return;
    this.active = null;
    if (typeof Navigation !== 'undefined') Navigation.voyageSpeedCap = Infinity;
    this._hideCard();
    this._toast(reason || '航海を中止しました');
    this._syncUi(true);
  },

  // 毎フレーム（index.html animateFrame）
  update(dt) {
    const V = this.active;
    const ship = State.ship;
    if (!V || !ship || !(dt > 0)) return;
    const N = Navigation;
    // 目的地を変えたら中止
    const t = N.target;
    if (!t || t.kind !== V.tg.kind || (t.kind === 'body' && t.id !== V.tg.id)) { this.abort('目的地を変えたので、航海を中止しました'); return; }
    V.t += dt;
    // 足止め（出来事）: ワープ・内空航行の速さを抑える
    //   ワープ・内空航行でないとき（出港・進入の途中）は、足止めの時間をそのまま遅れとして加える
    if (V.hold > 0 && !N.isWarping()) { V.t += V.hold; V.hold = 0; }
    if (V.hold > 0) { V.hold = Math.max(0, V.hold - dt); N.voyageSpeedCap = this.HOLD_SPEED; }
    else N.voyageSpeedCap = Infinity;
    // --- 乗り心地 ---
    // 自動航行・出港・進入で艦が自分で動いているあいだは、操縦の揺れとして数えない（その艦のふつうの動き）
    const auto = !!(N.departure || N.approach || N.arrivalHold || (N.isWarping() && N.warp.autopilot) || ship.autoDockingEnabled);
    const k = (V.rush ? 1.6 : 1) * (auto ? 0 : 1); // 急病人を運んでいるときは、揺れが響く
    const w = Math.hypot(ship.angularVelocity.x, ship.angularVelocity.y, ship.angularVelocity.z);
    if (w > this.TURN_OK) V.comfort -= (w - this.TURN_OK) * dt * 7 * k;
    // 噴射で進む艦は、強い加速も（重力場機関の艦は、場が加速を打ち消すので感じない）。ワープ中・フレームの付け替えのときは見ない
    if (!ship.gravityDrive && !N.isWarping() && V.prevV && V.prevFrame === N.frame) {
      const g = ship.gravityAccel || { x: 0, y: 0, z: 0 };
      const ax = (ship.velocity.x - V.prevV.x) / dt - g.x, ay = (ship.velocity.y - V.prevV.y) / dt - g.y, az = (ship.velocity.z - V.prevV.z) / dt - g.z;
      const G = Math.hypot(ax, ay, az) / 9.80665;
      if (G > this.ACCEL_OK_G && G < 500) V.comfort -= Math.min(4, G - this.ACCEL_OK_G) * dt * 1.2 * k;
    }
    V.prevV = { x: ship.velocity.x, y: ship.velocity.y, z: ship.velocity.z };
    V.prevFrame = N.frame;
    // 地面・水面に激しくぶつかった
    if (typeof Planetfall !== 'undefined' && Planetfall._hardT && Planetfall._hardT !== V.hardT) { V.hardT = Planetfall._hardT; V.comfort -= 20; this._toast('激しい衝撃で、乗客が投げ出されました（乗り心地 −20）'); }
    V.comfort = clamp(V.comfort, 0, 100);
    // --- 出来事 ---
    if (V.card) {
      V.card.left -= dt;
      if (V.card.left <= 0) { const i = V.card.ev.options.findIndex((o) => o.safe); this.choose(i >= 0 ? i : 0, true); }
    } else if (V.events.length && V.t >= V.events[0].at && V.hold <= 0 && !N.approach) {
      const e = V.events.shift(); V.card = { ev: e.ev, left: this.CHOICE_TIME }; this._showCard();
    }
  },
  HOLD_SPEED: 30000,  // 足止めのあいだの速さの上限 [m/s]
  TURN_OK: 0.12,      // これより速く回ると、乗り心地が下がる [rad/s]
  ACCEL_OK_G: 1.5,    // これより強い加速で、乗り心地が下がる [G]
  CHOICE_TIME: 14,    // 出来事の選ぶ時間 [s]

  // 出来事の選択
  choose(i, timeout) {
    const V = this.active;
    if (!V || !V.card) return;
    const ev = V.card.ev, o = ev.options[i];
    V.card = null;
    let text = o.done || '';
    let comfort = o.comfort || 0, service = o.service || 0, hold = o.hold || 0;
    if (o.risk && Math.random() < o.risk.p) { text = o.risk.text; comfort += o.risk.comfort || 0; hold += o.risk.hold || 0; }
    if (o.rush) { V.rush = true; V.sched = Math.max(V.t + 15, Math.round(V.t + (V.sched - V.t) * o.rush)); V.rushService = service; service = 0; }
    V.comfort = clamp(V.comfort + comfort, 0, 100);
    V.service = clamp(V.service + service, 0, 20);
    V.hold += hold;
    const eff = [];
    if (hold) eff.push(`足止め ${Math.round(hold)}秒`);
    if (comfort) eff.push(`乗り心地 ${comfort > 0 ? '+' : ''}${Math.round(comfort)}`);
    if (service) eff.push(`もてなし ${service > 0 ? '+' : ''}${service}`);
    if (o.rush) eff.push(`ダイヤ ${this._fmt(V.sched)} に前倒し`);
    V.log.push({ title: ev.title, choice: o.label, text, eff: eff.join('・'), timeout: !!timeout });
    this._hideCard();
    this._toast(`${timeout ? '（時間切れ）' : ''}${text}${eff.length ? `（${eff.join('・')}）` : ''}`, 6000);
  },

  // 目的地に着いた（16-navigation.js _arrive から）
  onArrive() {
    const V = this.active;
    if (!V) return;
    const t = Navigation.target;
    if (!t || t.kind !== V.tg.kind || (t.kind === 'body' && t.id !== V.tg.id)) return;
    Navigation.voyageSpeedCap = Infinity;
    this._hideCard();
    // 定時性: ダイヤまでは満点。遅れるほど下がり、ダイヤの 1.6 倍で 0 点
    const late = V.t - V.sched;
    const punctual = late <= 0 ? 40 : Math.max(0, 40 * (1 - late / (V.sched * 0.6)));
    if (V.rush && late <= 0) V.service = clamp(V.service + (V.rushService || 0), 0, 20); // 急病人: 間に合った
    const comfort = (V.comfort / 100) * 40;
    const service = V.service;
    const score = Math.round(punctual + comfort + service);
    const rank = score >= 90 ? 'S' : score >= 78 ? 'A' : score >= 62 ? 'B' : score >= 45 ? 'C' : 'D';
    // 運賃: 乗客の数 × 距離（遠いほど高いが、伸びはゆるやか）× 成績
    const AU = 1.495978707e11;
    const fare = Math.round(V.pax * (40 + 60 * Math.log10(1 + (V.dist / AU) * 20)) * (0.4 + 0.6 * score / 100));
    const S = this._store;
    const prev = S.best[V.key];
    const best = !prev || score > prev.score;
    if (best) S.best[V.key] = { score, rank, time: Math.round(V.t) };
    S.income += fare; S.count += 1;
    this._save();
    const res = { V, late, punctual, comfort, service, score, rank, fare, best, prev };
    this.active = null;
    this._showResult(res);
    this._syncUi(true);
  },

  // ---------------------------------------------------------
  // 画面
  // ---------------------------------------------------------
  _fmt(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; },
  _buildUi() {
    const mk = (cls, parent) => { const el = document.createElement('div'); el.className = cls; el.style.display = 'none'; (parent || document.body).appendChild(el); return el; };
    this._hud = mk('voyage-hud');
    this._card = mk('voyage-card');
    this._panel = mk('voyage-panel');
    this._toastEl = mk('voyage-toast');
    for (const el of [this._card, this._panel]) for (const ev of ['mousedown', 'touchstart', 'wheel', 'click']) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  },
  // サイドメニューに「定期航路」（サイドメニューは HUD が作るので、できてから足す）
  _ensureMenu() {
    if (this._menuBox) return;
    const menu = document.querySelector('.side-menu-panel');
    if (menu) {
      const title = document.createElement('div');
      title.className = 'side-menu-section-title voyage-menu-title';
      title.textContent = '定期航路（客船の航海）';
      const box = document.createElement('div');
      box.className = 'voyage-menu';
      const first = menu.querySelector('.side-menu-section-title.side-menu-practice-only') || menu.children[2] || null;
      menu.insertBefore(title, first);
      menu.insertBefore(box, first);
      this._menuBox = box;
    }
  },
  _toast(text, ms) {
    const el = this._toastEl;
    if (!el) return;
    el.textContent = text;
    el.style.display = '';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { el.style.display = 'none'; }, ms || 4500);
  },
  _syncUi(force) {
    const V = this.active;
    const practice = typeof PRACTICE_MODE !== 'undefined' && PRACTICE_MODE;
    this._ensureMenu();
    // サイドメニュー
    const box = this._menuBox;
    if (box) {
      const key = `${!!V}|${practice}|${this._store.count}|${this._store.income}`;
      if (force || key !== this._menuKey) {
        this._menuKey = key;
        box.innerHTML = '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'voyage-menu-btn';
        if (practice) { btn.textContent = '演習モードでは使えません'; btn.disabled = true; }
        else if (V) { btn.textContent = '航海を中止する'; btn.addEventListener('click', () => this.abort()); }
        else { btn.textContent = '行き先を選んで出港'; btn.addEventListener('click', () => this._openPanel()); }
        box.appendChild(btn);
        const info = document.createElement('div');
        info.className = 'voyage-menu-info';
        info.textContent = `これまでの航海 ${this._store.count} 回・運賃の合計 ${this._store.income.toLocaleString()}`;
        box.appendChild(info);
      }
    }
    // 航海中の表示（航行のメニューの下。大気圏の表示があれば、その下）
    const hud = this._hud;
    if (!V) { hud.style.display = 'none'; return; }
    const left = V.sched - V.t;
    const late = left < 0;
    hud.style.display = '';
    hud.classList.toggle('late', late);
    hud.classList.toggle('hold', V.hold > 0);
    const txt = `航海 ${V.from.label}→${V.dest.label}・${late ? `遅れ ${this._fmt(-left)}` : `ダイヤまで ${this._fmt(left)}`}・乗り心地 ${Math.round(V.comfort)}・もてなし ${Math.round(V.service)}/20${V.hold > 0 ? `・足止め ${Math.ceil(V.hold)}秒` : ''}${V.rush ? '・急病人を搬送中' : ''}`;
    if (hud.textContent !== txt) hud.textContent = txt;
    let top = 8;
    for (const sel of ['.space-nav-panel', '.planetfall-hud', '.vp-info']) {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top < window.innerHeight * 0.5) top = Math.max(top, r.bottom + 6);
    }
    hud.style.top = `${Math.round(top)}px`;
    // 出来事の残り時間
    if (V.card && this._cardBar) this._cardBar.style.width = `${Math.max(0, (V.card.left / this.CHOICE_TIME) * 100)}%`;
  },
  _openPanel() {
    const ship = State.ship;
    const p = this._panel;
    if (!ship || !p) return;
    const here = this._here();
    p.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'voyage-panel-head';
    head.innerHTML = `<b>定期航路</b><span>出発: ${here.label}・乗客 ${this.passengers(ship).toLocaleString()} 名</span>`;
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'voyage-close'; close.textContent = '×';
    close.addEventListener('click', () => this._closePanel());
    head.appendChild(close);
    p.appendChild(head);
    const note = document.createElement('div');
    note.className = 'voyage-panel-note';
    note.textContent = '行き先を選ぶと、自動航行で出港します（手動に切り替えてもかまいません）。ダイヤどおりに、揺らさずに着くほど高い成績。途中の出来事では、どうするかを選びます。';
    p.appendChild(note);
    const list = document.createElement('div');
    list.className = 'voyage-list';
    for (const d of this.destinations()) {
      const tg = d.kind === 'home' ? { kind: 'home' } : { kind: 'body', id: d.id };
      let sched = 0, dist = 0;
      try { const keep = Navigation.arrivalMode; Navigation.arrivalMode = { kind: 'orbit', altitudeKm: null }; sched = this.schedule(tg, ship); dist = this._distanceTo(tg); Navigation.arrivalMode = keep; } catch (e) { continue; }
      const best = this._store.best[this.routeKey(here.key, d)];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'voyage-route';
      const dtxt = typeof SpaceHud !== 'undefined' && SpaceHud.formatDistance ? SpaceHud.formatDistance(dist) : `${Math.round(dist / 1000).toLocaleString()} km`;
      b.innerHTML = `<span class="vr-name">${here.label} → ${d.label}</span><span class="vr-sub">${dtxt}・ダイヤ ${this._fmt(sched)}</span><span class="vr-best${best ? ` rank-${best.rank}` : ''}">${best ? `${best.rank} ${best.score}点` : '—'}</span>`;
      b.addEventListener('click', () => this.start(d));
      list.appendChild(b);
    }
    p.appendChild(list);
    p.style.display = '';
    // サイドメニューは閉じる（行き先の一覧が隠れないように）
    const sm = document.querySelector('.hud-side-menu');
    if (sm && sm.classList.contains('is-open')) { sm.classList.remove('is-open'); const tab = sm.querySelector('.side-menu-tab'); if (tab) tab.textContent = '☰'; }
  },
  _closePanel() { if (this._panel) this._panel.style.display = 'none'; },
  _showCard() {
    const V = this.active, c = this._card;
    if (!V || !V.card || !c) return;
    const ev = V.card.ev;
    c.innerHTML = `<div class="vc-title">${ev.title}</div><div class="vc-text">${ev.text}</div><div class="vc-bar"><i></i></div>`;
    this._cardBar = c.querySelector('.vc-bar i');
    ev.options.forEach((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vc-opt';
      b.innerHTML = `<b>${o.label}</b><small>${o.note || ''}</small>`;
      b.addEventListener('click', () => this.choose(i));
      c.appendChild(b);
    });
    c.style.display = '';
  },
  _hideCard() { if (this._card) this._card.style.display = 'none'; },
  _showResult(r) {
    const p = this._panel, V = r.V;
    if (!p) return;
    p.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'voyage-panel-head';
    head.innerHTML = `<b>到着: ${V.dest.label}</b><span>${V.from.label} → ${V.dest.label}</span>`;
    p.appendChild(head);
    const body = document.createElement('div');
    body.className = 'voyage-result';
    const row = (name, val, max, note) => `<div class="vres-row"><span>${name}</span><i><em style="width:${Math.round((val / max) * 100)}%"></em></i><b>${Math.round(val)}/${max}</b><small>${note}</small></div>`;
    body.innerHTML = `<div class="vres-rank rank-${r.rank}">${r.rank}<small>${r.score}点${r.best ? '・この航路の最高記録' : r.prev ? `（最高 ${r.prev.score}点）` : ''}</small></div>`
      + row('定時性', r.punctual, 40, r.late <= 0 ? `${this._fmt(V.t)} で到着（ダイヤ ${this._fmt(V.sched)}。${this._fmt(-r.late)} の余裕）` : `${this._fmt(V.t)} で到着（ダイヤ ${this._fmt(V.sched)} から ${this._fmt(r.late)} の遅れ）`)
      + row('乗り心地', r.comfort, 40, `乗り心地 ${Math.round(V.comfort)}/100`)
      + row('もてなし', r.service, 20, V.log.length ? V.log.map((l) => `${l.title}: ${l.choice}`).join(' ／ ') : '出来事なし')
      + `<div class="vres-fare">乗客 ${V.pax.toLocaleString()} 名・運賃 <b>${r.fare.toLocaleString()}</b>（合計 ${this._store.income.toLocaleString()}）</div>`;
    p.appendChild(body);
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'voyage-ok'; ok.textContent = '閉じる';
    ok.addEventListener('click', () => this._closePanel());
    p.appendChild(ok);
    p.style.display = '';
  },
};
