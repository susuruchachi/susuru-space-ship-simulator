// =============================================================
// 22-ship-designer.js
// 艦船建造画面（ship-builder.html）の「艦の設計」編集
//
// v78: 新設。大きさ（10m〜5000m）・質量・主エンジンの推力と位置・重心・
// 逆噴射・姿勢スラスター（船体表面に吸着）を編集し、名前を付けて
// 何隻でも保存できるようにする。設計データの形・物理への変換・保存先は
// 21-ship-design.js、3Dビューとモデルの読み込みは 09-ship-builder.js
// （window.ShipBuilderCore）が担当する。
//
// v81: 主エンジンを複数持てるようにし、部品（主エンジン・姿勢スラスター・
// 重心）を3Dビュー上の移動ギズモ（X/Y/Z の矢印と中央のつまみ）で
// 動かせるようにした。
//
// 座標はすべて「設計座標」（建造画面のワールド座標。船体の中心が原点、
// 艦首-Z・上+Y・右+X、単位m）。
// =============================================================

(function () {
  const core = window.ShipBuilderCore;
  if (!core) return;
  const $ = (id) => document.getElementById(id);

  let design = null;        // 編集中の設計
  let modelDirty = false;   // 船体モデルを読み込み/外してから未保存か
  let dirty = false;        // 何か変更してから未保存か
  let selectedPodId = null;
  let selectedMainId = null; // v81: パネルで編集中の主エンジン
  let active = null;         // v81: ギズモを出している部品 { kind: 'pod' | 'main' | 'cog' | 'retro', id }
  let selectedRetroId = null; // v84: 選んでいる逆噴射ノズル
  let placing = null;        // v84: 船体をタップして置くもの 'pod' | 'retro'（null なら置かない）
  let hullVersion = 0;      // 船体の形が変わるたびに+1（表面の三角形キャッシュの無効化）
  let triCache = null;
  let pendingLegacyScale = null; // 旧方式（艦種ごと）のモデルの倍率。大きさの引き継ぎに使う

  // -----------------------------------------------------------
  // 表示用の書式
  // -----------------------------------------------------------
  function fmtNum(v, sig) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return v.toExponential(2).replace('e+', '×10^');
    if (a >= 1000) return Math.round(v).toLocaleString('ja-JP');
    const d = sig === undefined ? (a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3) : sig;
    return v.toFixed(d);
  }
  function fmtForce(N) {
    const a = Math.abs(N);
    if (a >= 1e12) return `${(N / 1e12).toPrecision(3)} TN`;
    if (a >= 1e9) return `${(N / 1e9).toPrecision(3)} GN`;
    if (a >= 1e6) return `${(N / 1e6).toPrecision(3)} MN`;
    if (a >= 1e3) return `${(N / 1e3).toPrecision(3)} kN`;
    return `${N.toPrecision(3)} N`;
  }
  function fmtLen(m) {
    if (Math.abs(m) >= 1000) return `${(m / 1000).toPrecision(3)} km`;
    return `${fmtNum(m)} m`;
  }
  function fmtTime(s) {
    if (!Number.isFinite(s)) return '—';
    if (s >= 3600) return `${(s / 3600).toFixed(1)} 時間`;
    if (s >= 120) return `${(s / 60).toFixed(1)} 分`;
    return `${s.toFixed(s < 10 ? 1 : 0)} 秒`;
  }
  // 入力欄に入れる数値（そこそこの有効桁で、指数表記にしない）
  function inputValue(v) {
    if (!Number.isFinite(v)) return '';
    const a = Math.abs(v);
    if (a === 0) return '0';
    const digits = Math.max(0, 4 - Math.floor(Math.log10(a)) - 1);
    return String(Number(v.toFixed(Math.min(digits, 6))));
  }

  // -----------------------------------------------------------
  // 3D: 箱の仮船体・目印（重心・エンジン・スラスター）
  // -----------------------------------------------------------
  const scene = core.scene;
  let boxHull = null;
  const markers = new THREE.Group();
  scene.add(markers);
  const MAT = {
    cog: new THREE.MeshBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true }),
    main: new THREE.MeshBasicMaterial({ color: 0x6cf0ff, depthTest: false, transparent: true }),
    mainSel: new THREE.MeshBasicMaterial({ color: 0xff7a3a, depthTest: false, transparent: true }),
    retro: new THREE.MeshBasicMaterial({ color: 0xb7a6ff, depthTest: false, transparent: true }),
    retroSel: new THREE.MeshBasicMaterial({ color: 0xff7a3a, depthTest: false, transparent: true }),
    // v84: ノズルの口（実際の直径）と、全開のときの噴射のおよその大きさ
    mainMouth: new THREE.MeshBasicMaterial({ color: 0x6cf0ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    retroMouth: new THREE.MeshBasicMaterial({ color: 0xb7a6ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    mainPlume: new THREE.MeshBasicMaterial({ color: 0x6db8ff, transparent: true, opacity: 0.16, depthWrite: false }),
    retroPlume: new THREE.MeshBasicMaterial({ color: 0xb7a6ff, transparent: true, opacity: 0.16, depthWrite: false }),
    pod: new THREE.MeshBasicMaterial({ color: 0xffd27a, depthTest: false, transparent: true }),
    podSel: new THREE.MeshBasicMaterial({ color: 0xff7a3a, depthTest: false, transparent: true }),
    hit: new THREE.MeshBasicMaterial({ visible: false }),
  };

  function disposeGroup(g) {
    while (g.children.length) {
      const c = g.children.pop();
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && !Object.values(MAT).includes(o.material)) o.material.dispose();
      });
    }
  }

  function rebuildBoxHull() {
    if (boxHull) {
      scene.remove(boxHull);
      boxHull.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      boxHull = null;
    }
    if (core.getModelRoot() || !design) return;
    const d = design.hull.dims;
    const geo = new THREE.BoxGeometry(d.x, d.y, d.z);
    boxHull = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x6688aa, metalness: 0.4, roughness: 0.5 }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.5 }));
    boxHull.add(edges);
    scene.add(boxHull);
  }

  function lineMesh(points, color, dashed, scaleForDash) {
    const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: scaleForDash, gapSize: scaleForDash * 0.6, depthTest: false, transparent: true })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 10;
    return line;
  }

  // 噴射の向き（exhaust）を示す円錐。dir の向きに尖る
  function cone(pos, dir, len, radius, mat) {
    const geo = new THREE.ConeGeometry(radius, len, 12);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(pos.x + dir.x * len / 2, pos.y + dir.y * len / 2, pos.z + dir.z * len / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dir.x, dir.y, dir.z).normalize());
    m.renderOrder = 11;
    return m;
  }

  // v84: ノズルの口（実際の直径の円）と、全開のときの噴射のおよその大きさ（半透明の円すい台）。
  // dir は噴射の向き
  function nozzleMouth(pos, dir, plume, mouthMat, plumeMat) {
    const g = new THREE.Group();
    const r = plume.diameter / 2;
    const disc = new THREE.Mesh(new THREE.RingGeometry(r * 0.72, r, 32), mouthMat);
    disc.renderOrder = 9;
    const ringPts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ringPts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0 });
    }
    const ring = lineMesh(ringPts, mouthMat.color.getHex(), false);
    const mouth = new THREE.Group();
    mouth.add(disc, ring);
    mouth.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dir.x, dir.y, dir.z).normalize());
    g.add(mouth);
    // v85: 全開のときの炎（機関の種類ごとの形。27-engine-plumes.js）
    const fl = EnginePlumes.create(plume.engineType);
    fl.update(1, 0.4);
    fl.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dir.x, dir.y, dir.z).normalize());
    fl.object.scale.setScalar(plume.diameter);
    g.add(fl.object);
    g.position.set(pos.x, pos.y, pos.z);
    return g;
  }

  function rebuildMarkers() {
    disposeGroup(markers);
    if (!design) return;
    validateSelection();
    const size = design.hull.size;
    const dims = design.hull.dims;
    const u = Math.max(size * 0.018, 0.08); // 目印の基本サイズ
    const c = design.cog;

    // 重心: 球＋3軸の短い線
    const cogM = new THREE.Mesh(new THREE.SphereGeometry(u * 1.1, 16, 12), MAT.cog);
    cogM.position.set(c.x, c.y, c.z);
    cogM.renderOrder = 12;
    markers.add(cogM);
    for (const ax of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]) {
      markers.add(lineMesh([
        { x: c.x - ax.x * u * 3, y: c.y - ax.y * u * 3, z: c.z - ax.z * u * 3 },
        { x: c.x + ax.x * u * 3, y: c.y + ax.y * u * 3, z: c.z + ax.z * u * 3 },
      ], 0xffb347, false));
    }
    const cogHit = new THREE.Mesh(new THREE.SphereGeometry(u * 2.4, 8, 6), MAT.hit);
    cogHit.position.set(c.x, c.y, c.z);
    cogHit.userData.part = { kind: 'cog', id: null };
    markers.add(cogHit);

    // 主エンジン: 1基ずつ噴射口（後ろ向きの円錐）。推力線は全エンジンの
    // 推力の中心を通る（全基を同じ出力で吹かしたときの合力の線）
    const multi = design.mains.length > 1;
    for (const e of design.mains) {
      const sel = e.id === selectedMainId && (multi || (active && active.kind === 'main'));
      const g = new THREE.Group();
      g.add(cone({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, u * 3, u * 1.4, sel ? MAT.mainSel : MAT.main));
      const hit = new THREE.Mesh(new THREE.SphereGeometry(u * 2.6, 8, 6), MAT.hit);
      hit.position.set(0, 0, u * 1.5);
      hit.userData.part = { kind: 'main', id: e.id };
      g.add(hit);
      g.position.set(e.position.x, e.position.y, e.position.z);
      markers.add(g);
      markers.add(nozzleMouth(e.position, { x: 0, y: 0, z: 1 }, { ...shipDesignPlumeEstimate(design, e, 'main'), engineType: e.engineType }, MAT.mainMouth, MAT.mainPlume));
    }
    const tc = shipDesignThrustCenter(design);
    markers.add(lineMesh([
      { x: tc.x, y: tc.y, z: -dims.z * 0.75 },
      { x: tc.x, y: tc.y, z: dims.z * 0.75 },
    ], 0x6cf0ff, true, u * 1.5));
    // 重心から推力線までのずれ
    const off = Math.hypot(c.x - tc.x, c.y - tc.y);
    if (off > size * 1e-4) {
      markers.add(lineMesh([{ x: c.x, y: c.y, z: c.z }, { x: tc.x, y: tc.y, z: c.z }], 0xff6a4a, false));
    }

    // v85: 重力場の密度境界面（重力場機関を積んだ艦だけ）
    if (hasGravityEngine()) {
      const R = Math.max(dims.x, dims.z) * 0.9;
      const plane = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({
        color: 0x7fd4ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false,
      }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(0, design.boundary.height ?? 0, 0);
      plane.renderOrder = 7;
      markers.add(plane);
      const ringPts = [];
      for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; ringPts.push({ x: Math.cos(a) * R, y: design.boundary.height ?? 0, z: Math.sin(a) * R }); }
      markers.add(lineMesh(ringPts, 0x7fd4ff, false));
    }

    // 逆噴射（v84: ノズルごとに選んで動かせる）
    for (const n of design.retro.nozzles) {
      const sel = n.id === selectedRetroId;
      const g = new THREE.Group();
      g.add(cone({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, u * 2.2, u * 0.9, sel ? MAT.retroSel : MAT.retro));
      const hit = new THREE.Mesh(new THREE.SphereGeometry(u * 2.4, 8, 6), MAT.hit);
      hit.position.set(0, 0, -u * 1.1);
      hit.userData.part = { kind: 'retro', id: n.id };
      g.add(hit);
      g.position.set(n.position.x, n.position.y, n.position.z);
      markers.add(g);
    }

    // 姿勢スラスター: 小さな箱＋5つの噴射口
    for (const pod of design.rcs.pods) {
      const sel = pod.id === selectedPodId;
      const g = new THREE.Group();
      g.userData.podId = pod.id;
      const box = new THREE.Mesh(new THREE.BoxGeometry(u * 1.3, u * 1.3, u * 1.3), sel ? MAT.podSel : MAT.pod);
      box.renderOrder = 12;
      g.add(box);
      for (const nz of rcsPodNozzleDirections(pod.normal)) {
        g.add(cone({ x: 0, y: 0, z: 0 }, nz.dir, u * (nz.key === 'out' ? 1.8 : 1.3), u * 0.35, sel ? MAT.podSel : MAT.pod));
      }
      // タップで選びやすいよう、見えない大きめの当たり判定
      const hit = new THREE.Mesh(new THREE.SphereGeometry(u * 2.4, 8, 6), MAT.hit);
      hit.userData.part = { kind: 'pod', id: pod.id };
      g.add(hit);
      g.position.set(pod.position.x, pod.position.y, pod.position.z);
      markers.add(g);
    }
    placeGizmo();
  }

  // -----------------------------------------------------------
  // 船体の形（表面の三角形）と、表面への吸着
  // -----------------------------------------------------------
  function getHullTriangles() {
    if (triCache && triCache.version === hullVersion) return triCache;
    const pts = [];
    const root = core.getModelRoot();
    if (root) {
      // 親（回転・スケールを掛ける補正ノード）の行列も更新してから読む
      root.updateWorldMatrix(true, true);
      const v = new THREE.Vector3();
      root.traverse((node) => {
        if (!node.isMesh || !node.geometry || !node.visible) return;
        const pos = node.geometry.attributes && node.geometry.attributes.position;
        if (!pos) return;
        const idx = node.geometry.index;
        const m = node.matrixWorld;
        const count = idx ? idx.count : pos.count;
        for (let i = 0; i + 2 < count; i += 3) {
          for (let j = 0; j < 3; j++) {
            v.fromBufferAttribute(pos, idx ? idx.getX(i + j) : i + j).applyMatrix4(m);
            pts.push(v.x, v.y, v.z);
          }
        }
      });
    } else if (design) {
      // 箱の仮船体: 12枚の三角形
      const h = { x: design.hull.dims.x / 2, y: design.hull.dims.y / 2, z: design.hull.dims.z / 2 };
      const geo = new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2);
      const pos = geo.attributes.position, idx = geo.index;
      for (let i = 0; i < idx.count; i++) {
        const k = idx.getX(i);
        pts.push(pos.getX(k), pos.getY(k), pos.getZ(k));
      }
      geo.dispose();
    }
    const tris = new Float32Array(pts);
    const n = Math.floor(tris.length / 9);
    const sph = new Float32Array(n * 4); // 外接球（中心・半径）で遠い三角形を飛ばす
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const cx = (tris[o] + tris[o + 3] + tris[o + 6]) / 3;
      const cy = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3;
      const cz = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
      let r = 0;
      for (let j = 0; j < 3; j++) {
        r = Math.max(r, Math.hypot(tris[o + j * 3] - cx, tris[o + j * 3 + 1] - cy, tris[o + j * 3 + 2] - cz));
      }
      sph[t * 4] = cx; sph[t * 4 + 1] = cy; sph[t * 4 + 2] = cz; sph[t * 4 + 3] = r;
    }
    triCache = { version: hullVersion, tris, sph, count: n };
    return triCache;
  }

  // 三角形ABC上で点Pに最も近い点（Ericson "Real-Time Collision Detection" 5.1.5）
  function closestOnTri(px, py, pz, T, o, out) {
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
    const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz); return;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
  }

  // 点 p にいちばん近い船体表面上の点と、そこでの外向きの法線
  function snapToHull(p) {
    const H = getHullTriangles();
    if (!H.count) return null;
    const T = H.tris, S = H.sph;
    let best = Infinity, bestTri = -1;
    const q = [0, 0, 0], bq = [0, 0, 0];
    for (let t = 0; t < H.count; t++) {
      const dc = Math.hypot(p.x - S[t * 4], p.y - S[t * 4 + 1], p.z - S[t * 4 + 2]) - S[t * 4 + 3];
      if (dc > 0 && dc * dc >= best) continue;
      closestOnTri(p.x, p.y, p.z, T, t * 9, q);
      const d2 = (p.x - q[0]) ** 2 + (p.y - q[1]) ** 2 + (p.z - q[2]) ** 2;
      if (d2 < best) { best = d2; bestTri = t; bq[0] = q[0]; bq[1] = q[1]; bq[2] = q[2]; }
    }
    if (bestTri < 0) return null;
    const o = bestTri * 9;
    const e1 = { x: T[o + 3] - T[o], y: T[o + 4] - T[o + 1], z: T[o + 5] - T[o + 2] };
    const e2 = { x: T[o + 6] - T[o], y: T[o + 7] - T[o + 1], z: T[o + 8] - T[o + 2] };
    let n = vecNormalize(vecCross(e1, e2));
    // 向きは「船体の中心から外へ」に合わせる。点が船体の外側にあれば
    // 点の方向（表面から点へ向かう向き）を優先する。
    const point = { x: bq[0], y: bq[1], z: bq[2] };
    const away = { x: p.x - point.x, y: p.y - point.y, z: p.z - point.z };
    const ref = vecLength(away) > design.hull.size * 1e-3 && isOutsideBox(p) ? away : point;
    if (vecDot(n, ref) < 0) n = vecScale(n, -1);
    if (!Number.isFinite(n.x) || vecLength(n) < 0.5) n = vecNormalize(point);
    return { position: point, normal: n };
  }

  function isOutsideBox(p) {
    const h = design.hull.dims;
    return Math.abs(p.x) > h.x / 2 || Math.abs(p.y) > h.y / 2 || Math.abs(p.z) > h.z / 2;
  }

  // 船体の外形（頂点）から、正確なバウンディングボックスを求める
  function preciseModelBox(root) {
    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    root.traverse((node) => {
      if (!node.isMesh || !node.geometry || !node.visible) return;
      const pos = node.geometry.attributes && node.geometry.attributes.position;
      if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
        box.expandByPoint(v);
      }
    });
    return box;
  }

  // モデルを設計の大きさに合わせ、中心を原点に置き直す。
  //   opts.native: 設計の大きさに合わせず、モデルの寸法（1単位 = 1m）のまま使う
  //     （5m〜5000m に収まらないときだけ、その範囲に収まるよう拡大・縮小する）
  function refitHullToModel(opts) {
    const root = core.getModelRoot();
    if (!root || !design) return;
    const a = core.adjust;
    a.scale = 1;
    a.offset = { x: 0, y: 0, z: 0 };
    core.applyAdjust();
    const box = preciseModelBox(root);
    if (box.isEmpty()) return;
    const s0 = new THREE.Vector3(), c0 = new THREE.Vector3();
    box.getSize(s0);
    box.getCenter(c0);
    const max0 = Math.max(s0.x, s0.y, s0.z, 1e-9);
    if (pendingLegacyScale) {
      design.hull.size = clamp(max0 * pendingLegacyScale, SHIP_DESIGN_SIZE_MIN, SHIP_DESIGN_SIZE_MAX);
      pendingLegacyScale = null;
    } else if (opts && opts.native) {
      design.hull.size = clamp(max0, SHIP_DESIGN_SIZE_MIN, SHIP_DESIGN_SIZE_MAX);
    }
    const k = design.hull.size / max0;
    a.scale = k;
    a.offset = { x: -c0.x * k, y: -c0.y * k, z: -c0.z * k };
    core.applyAdjust();
    design.hull.scale = k;
    design.hull.offset = { ...a.offset };
    design.hull.rotationDeg = { ...a.rotationDeg };
    design.hull.dims = { x: s0.x * k, y: s0.y * k, z: s0.z * k };
    hullVersion++;
  }

  // 姿勢スラスターと逆噴射ノズルを、いちばん近い船体表面へ寄せる（逆噴射ノズルを
  // 自分で動かしていなければ、艦首の左右2か所に置き直す）
  function resnapPods() {
    for (const pod of design.rcs.pods) {
      const s = snapToHull(pod.position);
      if (s) { pod.position = s.position; pod.normal = s.normal; }
    }
    if (!design.retro.custom) {
      autoPlaceRetro();
      return;
    }
    for (const n of design.retro.nozzles) {
      const s = snapToHull(n.position);
      if (s) { n.position = s.position; n.normal = s.normal; }
    }
  }

  // v84: 逆噴射ノズルの初期配置（重心をはさんだ艦首の左右2か所）を、艦首の表面に置く
  // （自分で動かしていない間は、重心を動かすとそれに合わせて動く。直径の設定は残す）
  function autoPlaceRetro() {
    const nozzles = defaultRetroNozzles(design.hull.dims, design.cog);
    const old = new Map(design.retro.nozzles.map((n) => [n.id, n]));
    for (const n of nozzles) {
      const z = bowSurfaceZ(n.position.x, n.position.y);
      const s = snapToHull({ x: n.position.x, y: n.position.y, z });
      n.position = { x: n.position.x, y: n.position.y, z };
      if (s) n.normal = s.normal;
      if (old.has(n.id)) n.diameter = old.get(n.id).diameter;
    }
    design.retro.nozzles = nozzles;
    design.retro.custom = false;
    validateSelection();
  }

  function nextRetroId() {
    let n = 1;
    const used = new Set(design.retro.nozzles.map((x) => x.id));
    while (used.has(`r${n}`)) n++;
    return `r${n}`;
  }

  // 自動配置: 艦首寄り・艦尾寄りの断面の上下左右（計8基）を船体表面に吸着
  function autoPlacePods() {
    const d = design.hull.dims;
    const targets = [];
    for (const z of [-d.z * 0.38, d.z * 0.38]) {
      targets.push({ x: 0, y: d.y, z }, { x: 0, y: -d.y, z }, { x: d.x, y: 0, z }, { x: -d.x, y: 0, z });
    }
    const pods = [];
    targets.forEach((t, i) => {
      const s = snapToHull(t);
      if (s) pods.push({ id: `p${i + 1}`, position: s.position, normal: s.normal });
    });
    design.rcs.pods = pods;
    selectedPodId = null;
    if (active && active.kind === 'pod') active = null;
  }

  function nextPodId() {
    let n = 1;
    const used = new Set(design.rcs.pods.map((p) => p.id));
    while (used.has(`p${n}`)) n++;
    return `p${n}`;
  }

  // -----------------------------------------------------------
  // 当たり判定の確認表示（ゲーム中の艦とポートの衝突判定に使う形）
  // -----------------------------------------------------------
  let collisionDebugOn = false;
  let collisionDebugObj = null;
  function refreshCollisionDebug() {
    if (collisionDebugObj) {
      scene.remove(collisionDebugObj);
      collisionDebugObj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      collisionDebugObj = null;
    }
    if (!collisionDebugOn || !design) return;
    const target = core.getModelRoot() || boxHull;
    if (!target) return;
    const shape = computeCollisionShape(target, scene, 48);
    collisionDebugObj = buildCollisionShapeDebugObject(shape, 0xff8833);
    scene.add(collisionDebugObj);
    core.setStatus(shape ? `当たり判定: 直方体${shape.boxes.length}個（格子の1マス ${fmtLen(shape.cell)}）` : '');
  }
  $('collisionDebugBtn').addEventListener('click', () => {
    collisionDebugOn = !collisionDebugOn;
    $('collisionDebugBtn').classList.toggle('active', collisionDebugOn);
    refreshCollisionDebug();
  });

  // -----------------------------------------------------------
  // 大きさ・寸法
  // -----------------------------------------------------------
  // 大きさを変える: 船体と、重心・エンジン・スラスターの位置を原点を中心に一様に拡大縮小
  function setSize(newSize) {
    const size = clamp(Number(newSize) || design.hull.size, SHIP_DESIGN_SIZE_MIN, SHIP_DESIGN_SIZE_MAX);
    const k = size / design.hull.size;
    if (!Number.isFinite(k) || Math.abs(k - 1) < 1e-9) { syncUi(); return; }
    const sc = (p) => ({ x: p.x * k, y: p.y * k, z: p.z * k });
    design.hull.size = size;
    design.hull.dims = sc(design.hull.dims);
    design.cog = sc(design.cog);
    scalePartsBy(k);
    const df = core.getDockingFace();
    if (df) core.setDockingFace({ ...df, offsetU: df.offsetU * k, offsetV: df.offsetV * k });
    if ($('sizeScalesSpec').checked) scaleSpecBySize(k);
    if (core.getModelRoot()) {
      const a = core.adjust;
      a.scale *= k;
      a.offset = sc(a.offset);
      core.applyAdjust();
      design.hull.scale = a.scale;
      design.hull.offset = { ...a.offset };
    }
    hullVersion++;
    afterShapeChange(true);
  }

  // 大きさが k 倍になったときの部品の位置・ノズルの直径（直径を自分で決めたものだけ。自動は大きさに合わせて変わる）
  function scalePartsBy(k) {
    const sc = (p) => ({ x: p.x * k, y: p.y * k, z: p.z * k });
    for (const e of design.mains) {
      e.position = sc(e.position);
      if (e.diameter > 0) e.diameter *= k;
    }
    for (const n of design.retro.nozzles) {
      n.position = sc(n.position);
      if (n.diameter > 0) n.diameter *= k;
    }
    for (const pod of design.rcs.pods) pod.position = sc(pod.position);
  }

  // 大きさが k 倍になったときの性能: 質量は体積に比例、推力は質量に比例
  // （加速度を保つ）、角速度は控えめに
  function scaleSpecBySize(k) {
    const k3 = k * k * k;
    design.mass *= k3;
    for (const e of design.mains) e.thrust *= k3;
    design.retro.thrust *= k3;
    design.rcs.thrust *= k3;
    for (const pod of design.rcs.pods) if (pod.thrust > 0) pod.thrust *= k3;
    design.maxAngularSpeed = clamp(design.maxAngularSpeed / Math.sqrt(k), 0.002, 6);
  }

  // 補正前（倍率1）のモデルの最大寸法（読み込み時の大きさの判定用）
  function preciseModelBoxMax() {
    const root = core.getModelRoot();
    if (!root) return design.hull.size;
    const a = core.adjust;
    const s = a.scale;
    return design.hull.size / Math.max(s, 1e-12);
  }

  function setBoxRatio(axis, percent) {
    if (core.getModelRoot()) return;
    const r = clamp(percent / 100, 0.02, 1);
    design.hull.boxRatio[axis] = r;
    design.hull.boxRatio.z = 1;
    const old = design.hull.dims[axis];
    design.hull.dims[axis] = design.hull.size * r;
    // スラスターは新しい箱の表面へ（同じ側に留まるよう比率で移してから吸着）
    const k = design.hull.dims[axis] / Math.max(old, 1e-9);
    for (const pod of design.rcs.pods) pod.position[axis] *= k;
    for (const n of design.retro.nozzles) n.position[axis] *= k;
    const half = design.hull.dims[axis] / 2;
    for (const e of design.mains) e.position[axis] = clamp(e.position[axis] * k, -half, half);
    hullVersion++;
    resnapPods();
    afterShapeChange(false);
  }

  function afterShapeChange(frame) {
    core.setSceneScale(design.hull.size);
    rebuildBoxHull();
    rebuildMarkers();
    refreshCollisionDebug();
    core.rebuildDockingFaceGizmo();
    if (frame) frameCamera();
    markDirty();
    syncUi();
  }

  function frameCamera() {
    core.frameCameraOnBox({ x: 0, y: 0, z: 0 }, design.hull.dims);
  }

  // -----------------------------------------------------------
  // 位置の入力欄（X/Y/Z: スライダー＋数値）
  // -----------------------------------------------------------
  function makePosRows(container, getVec, setVec, onCommit) {
    container.innerHTML = '';
    const rows = {};
    for (const ax of ['x', 'y', 'z']) {
      const row = document.createElement('div');
      row.className = 'pos-row';
      row.innerHTML = `<div class="axis-label">${ax.toUpperCase()}</div><input type="range" step="any"><input type="number" class="num-input" step="any">`;
      const range = row.querySelector('input[type="range"]');
      const num = row.querySelector('input[type="number"]');
      range.addEventListener('input', () => {
        const v = { ...getVec() };
        v[ax] = Number(range.value);
        num.value = inputValue(v[ax]);
        setVec(v, false);
      });
      range.addEventListener('change', () => { if (onCommit) onCommit(); });
      num.addEventListener('change', () => {
        const v = { ...getVec() };
        v[ax] = Number(num.value) || 0;
        setVec(v, true);
        if (onCommit) onCommit();
      });
      rows[ax] = { range, num };
      container.appendChild(row);
    }
    return {
      sync(extentScale) {
        const v = getVec();
        if (!v) return;
        const dims = design.hull.dims;
        for (const ax of ['x', 'y', 'z']) {
          const lim = Math.max(dims[ax] / 2 * (extentScale || 1.3), design.hull.size * 0.02);
          rows[ax].range.min = String(-lim);
          rows[ax].range.max = String(lim);
          rows[ax].range.step = String(design.hull.size / 2000);
          rows[ax].range.value = String(v[ax]);
          if (document.activeElement !== rows[ax].num) rows[ax].num.value = inputValue(v[ax]);
        }
      },
    };
  }

  const mainPos = makePosRows($('mainPosRows'), () => {
    const e = selectedMain();
    return e ? e.position : { x: 0, y: 0, z: 0 };
  }, (v) => {
    const e = selectedMain();
    if (!e) return;
    e.position = v;
    onPhysicsEdit();
  });
  const cogPos = makePosRows($('cogPosRows'), () => design.cog, (v) => {
    design.cog = v;
    onPhysicsEdit();
  });
  const podPos = makePosRows($('podPosRows'), () => {
    const pod = selectedPod();
    return pod ? pod.position : { x: 0, y: 0, z: 0 };
  }, (v, commit) => {
    const pod = selectedPod();
    if (!pod) return;
    pod.position = v;
    if (commit) snapSelectedPod();
    onPhysicsEdit();
  }, () => {
    snapSelectedPod();
    onPhysicsEdit();
  });

  const retroPos = makePosRows($('retroPosRows'), () => {
    const n = selectedRetro();
    return n ? n.position : { x: 0, y: 0, z: 0 };
  }, (v, commit) => {
    const n = selectedRetro();
    if (!n) return;
    n.position = v;
    design.retro.custom = true;
    if (commit) snapSurfacePart(n);
    onPhysicsEdit();
  }, () => {
    const n = selectedRetro();
    if (n) snapSurfacePart(n);
    onPhysicsEdit();
  });

  function selectedPod() {
    return design && design.rcs.pods.find((p) => p.id === selectedPodId) || null;
  }
  function selectedRetro() {
    return design && design.retro.nozzles.find((n) => n.id === selectedRetroId) || null;
  }
  // 船体の表面に置く部品（姿勢スラスター・逆噴射ノズル）
  function isSurfaceKind(kind) { return kind === 'pod' || kind === 'retro'; }
  function surfacePart(kind, id) {
    if (!design) return null;
    if (kind === 'pod') return design.rcs.pods.find((x) => x.id === id) || null;
    if (kind === 'retro') return design.retro.nozzles.find((x) => x.id === id) || null;
    return null;
  }
  function snapSurfacePart(part) {
    const s = snapToHull(part.position);
    if (s) { part.position = s.position; part.normal = s.normal; }
  }

  function findMain(id) {
    return design && design.mains.find((e) => e.id === id) || null;
  }
  function selectedMain() {
    if (!design || !design.mains.length) return null;
    return findMain(selectedMainId) || design.mains[0];
  }

  function snapSelectedPod() {
    const pod = selectedPod();
    if (!pod) return;
    const s = snapToHull(pod.position);
    if (s) { pod.position = s.position; pod.normal = s.normal; }
  }

  // -----------------------------------------------------------
  // 画面の値を設計に合わせる
  // -----------------------------------------------------------
  function syncUi() {
    if (!design) return;
    $('designName').value = design.name;
    document.getElementById('classBadge').textContent = design.name;
    const hasModel = !!core.getModelRoot();
    $('modelLine').textContent = hasModel
      ? `モデル: ${design.hull.modelFileName || '（読み込み済み）'}`
      : 'モデルなし（箱の仮船体）';
    $('removeModelBtn').style.display = hasModel ? '' : 'none';
    $('boxShapeRows').style.display = hasModel ? 'none' : '';
    $('rotationRows').style.display = hasModel ? '' : 'none';
    const br = design.hull.boxRatio;
    $('boxW').value = String(Math.round(br.x * 100));
    $('boxWVal').textContent = `${Math.round(br.x * 100)}%`;
    $('boxH').value = String(Math.round(br.y * 100));
    $('boxHVal').textContent = `${Math.round(br.y * 100)}%`;

    $('sizeSlider').value = String(Math.log10(design.hull.size));
    if (document.activeElement !== $('sizeInput')) $('sizeInput').value = inputValue(design.hull.size);
    const d = design.hull.dims;
    $('dimsLine').textContent = `全長 ${fmtLen(d.z)} × 全幅 ${fmtLen(d.x)} × 全高 ${fmtLen(d.y)}`;

    if (document.activeElement !== $('massInput')) $('massInput').value = inputValue(design.mass / 1000);
    if (document.activeElement !== $('maxSpeedInput')) $('maxSpeedInput').value = design.maxSpeed > 0 ? inputValue(design.maxSpeed) : '';
    if (document.activeElement !== $('maxAccelInput')) $('maxAccelInput').value = design.maxAccel > 0 ? inputValue(design.maxAccel) : '';
    if (document.activeElement !== $('maxAngInput')) $('maxAngInput').value = inputValue(design.maxAngularSpeed * 180 / Math.PI);
    if (document.activeElement !== $('inertiaInput')) $('inertiaInput').value = inputValue(design.inertiaFactor);
    const selMain = selectedMain();
    if (document.activeElement !== $('mainThrustInput')) $('mainThrustInput').value = selMain ? inputValue(selMain.thrust / 1000) : '';
    if (document.activeElement !== $('retroThrustInput')) $('retroThrustInput').value = inputValue(design.retro.thrust / 1000);
    if (document.activeElement !== $('rcsThrustInput')) $('rcsThrustInput').value = inputValue(design.rcs.thrust / 1000);
    const g = 9.80665;
    const mainTotal = shipDesignMainThrust(design);
    const aMain = mainTotal / design.mass;
    const nMain = design.mains.length;
    $('mainAccelLine').textContent = `${nMain > 1 ? `主エンジン${nMain}基の合計 ${fmtForce(mainTotal)}・` : ''}主エンジンだけでの加速度 ${fmtNum(aMain)} m/s²（${fmtNum(aMain / g, 2)} G）`;
    const aRetro = design.retro.thrust / design.mass;
    $('retroAccelLine').textContent = `逆噴射だけでの減速度 ${fmtNum(aRetro)} m/s²（${fmtNum(aRetro / g, 2)} G）`;
    const tc = shipDesignThrustCenter(design);
    const off = Math.hypot(design.cog.x - tc.x, design.cog.y - tc.y);
    const offEl = $('mainOffsetLine');
    if (off < design.hull.size * 1e-4) {
      offEl.textContent = '推力線は重心を通っています（主エンジンだけでは回転しない）。';
      offEl.classList.remove('warn');
    } else {
      offEl.textContent = `推力線と重心のずれ ${fmtLen(off)}（主エンジン全開で ${fmtForce(mainTotal * off).replace('N', 'N·m')} の回転力）`;
      offEl.classList.add('warn');
    }
    for (const id of ['faceOffU', 'faceOffV']) {
      const el = $(id);
      const lim = Math.max(20, Math.round(design.hull.size / 2));
      el.min = String(-lim);
      el.max = String(lim);
      el.step = String(Math.max(0.1, design.hull.size / 1000));
    }
    renderMainList();
    cogPos.sync(1.3);
    $('cogGizmoBtn').classList.toggle('active', !!(active && active.kind === 'cog'));
    renderPodList();
    renderRetroList();
    syncBoundaryUi();
    if (document.activeElement !== $('gyroTorqueInput')) $('gyroTorqueInput').value = design.gyro.torque > 0 ? inputValue(design.gyro.torque / 1000) : '';
    {
      const I = buildShipSpecFromDesign(design).inertiaTensor;
      const tau = design.gyro.torque;
      const t90 = (Iax) => (tau > 0 ? fmtTime(Math.sqrt((4 * (Math.PI / 2) * Iax) / tau)) : '—');
      $('gyroLine').textContent = tau > 0
        ? `ジャイロだけで90°向きを変える時間（最大角速度の制限なし）: ピッチ ${t90(I.x)}・ヨー ${t90(I.y)}・ロール ${t90(I.z)}`
        : 'ジャイロなし（向きを変えるのは姿勢スラスターだけ）';
    }
    schedulePerf();
  }

  // v81: 主エンジンの一覧（チップ）と、選んだエンジンの編集欄
  function renderMainList() {
    const list = $('mainList');
    list.innerHTML = '';
    const sel = selectedMain();
    design.mains.forEach((e, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const on = sel && e.id === sel.id;
      chip.className = `pod-chip main-chip${on ? ' selected' : ''}`;
      chip.textContent = `${i + 1}. ${mainSideLabel(e)}・${fmtForce(e.thrust)}・Ø${fmtLen(shipDesignNozzleDiameter(design, e, 'main'))}`;
      chip.addEventListener('click', () => {
        // 選んでいるエンジンのチップをもう一度押すとギズモを出し入れ
        if (on && active && active.kind === 'main' && active.id === e.id) setActive(null);
        else setActive('main', e.id);
      });
      list.appendChild(chip);
    });
    $('mainRemoveBtn').disabled = design.mains.length <= 1;
    $('mainEditor').style.display = sel ? '' : 'none';
    if (sel) {
      const i = design.mains.indexOf(sel);
      $('mainEditorTitle').textContent = design.mains.length > 1 ? `${i + 1}基目（${mainSideLabel(sel)}）` : '主エンジン（1基）';
      syncDiameterField($('mainDiaInput'), $('mainDiaLine'), sel, 'main');
      $('mainEngineType').value = sel.engineType || 'rocket';
      mainPos.sync(1.5);
    }
  }

  // v84: ノズルの直径の欄（空欄 = 自動）と、全開のときの噴射の大きさの目安
  function syncDiameterField(input, line, part, kind) {
    const auto = shipDesignAutoNozzleDiameter(design, kind);
    input.placeholder = `自動（${inputValue(auto)}）`;
    if (document.activeElement !== input) input.value = part.diameter > 0 ? inputValue(part.diameter) : '';
    const p = shipDesignPlumeEstimate(design, part, kind);
    line.textContent = `ノズルの口 Ø${fmtLen(p.diameter)}${part.diameter > 0 ? '' : '（自動）'}・全開の噴射は太さ 約${fmtLen(p.width)}、長さ 約${fmtLen(p.length)}（ビューの炎）`;
  }
  function diameterFromInput(input) {
    const v = Number(input.value);
    return input.value === '' || !(v > 0) ? null : v;
  }

  // v84: 逆噴射ノズルの一覧と、選んだノズルの編集欄
  function renderRetroList() {
    const list = $('retroList');
    list.innerHTML = '';
    design.retro.nozzles.forEach((n, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `pod-chip retro-chip${n.id === selectedRetroId ? ' selected' : ''}`;
      chip.textContent = `${i + 1}. ${retroSideLabel(n)}`;
      chip.addEventListener('click', () => setActive(n.id === selectedRetroId ? null : 'retro', n.id));
      list.appendChild(chip);
    });
    const n = selectedRetro();
    $('retroEditor').style.display = n ? '' : 'none';
    if (n) {
      const i = design.retro.nozzles.indexOf(n);
      $('retroEditorTitle').textContent = `${i + 1}つ目（${retroSideLabel(n)}）`;
      retroPos.sync(1.6);
    }
  }

  // 「艦首・左」のような、前から見た位置の説明
  function retroSideLabel(n) {
    const d = design.hull.dims;
    const tx = d.x * 0.05, ty = d.y * 0.05;
    const h = n.position.x > tx ? '右' : n.position.x < -tx ? '左' : '';
    const v = n.position.y > ty ? '上' : n.position.y < -ty ? '下' : '';
    const zr = n.position.z / Math.max(d.z / 2, 1e-9);
    const along = zr < -0.5 ? '艦首' : zr > 0.5 ? '艦尾寄り' : '中央';
    return `${along}・${(h + v) || '中央'}`;
  }

  // 「右上」「中央」のような、艦尾から見たエンジンの位置の説明
  function mainSideLabel(e) {
    const d = design.hull.dims;
    const tx = d.x * 0.05, ty = d.y * 0.05;
    const h = e.position.x > tx ? '右' : e.position.x < -tx ? '左' : '';
    const v = e.position.y > ty ? '上' : e.position.y < -ty ? '下' : '';
    return (h + v) || '中央';
  }

  function renderPodList() {
    const list = $('podList');
    list.innerHTML = '';
    design.rcs.pods.forEach((pod, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `pod-chip${pod.id === selectedPodId ? ' selected' : ''}`;
      chip.textContent = `${i + 1}. ${podSideLabel(pod)}`;
      chip.addEventListener('click', () => setActive(pod.id === selectedPodId ? null : 'pod', pod.id));
      list.appendChild(chip);
    });
    const pod = selectedPod();
    $('podEditor').style.display = pod ? '' : 'none';
    if (pod) {
      const i = design.rcs.pods.indexOf(pod);
      $('podEditorTitle').textContent = `${i + 1}基目（${podSideLabel(pod)}）`;
      if (document.activeElement !== $('podThrustInput')) $('podThrustInput').value = pod.thrust > 0 ? inputValue(pod.thrust / 1000) : '';
      podPos.sync(1.6);
    }
  }

  // 「艦首寄り・上面」のような位置の説明
  function podSideLabel(pod) {
    const n = pod.normal;
    const ax = [['x', '右', '左'], ['y', '上', '下'], ['z', '艦尾', '艦首']];
    let best = ax[0], bestV = 0;
    for (const a of ax) if (Math.abs(n[a[0]]) > Math.abs(bestV)) { best = a; bestV = n[a[0]]; }
    const face = bestV >= 0 ? best[1] : best[2];
    const zr = pod.position.z / Math.max(design.hull.dims.z / 2, 1e-9);
    const along = zr < -0.33 ? '艦首寄り' : zr > 0.33 ? '艦尾寄り' : '中央';
    return best[0] === 'z' ? `${face}の面` : `${along}・${face}`;
  }

  // v81: 部品を選ぶ（ギズモを出す）。kind が null なら選択を外す
  function setActive(kind, id) {
    active = kind ? { kind, id: kind === 'cog' ? null : id } : null;
    selectedPodId = kind === 'pod' ? id : null;
    selectedRetroId = kind === 'retro' ? id : null;
    if (kind === 'main') selectedMainId = id;
    rebuildMarkers();
    syncUi();
  }

  // 消えた部品を指している選択を外す
  function validateSelection() {
    if (!design) return;
    if (selectedPodId && !selectedPod()) selectedPodId = null;
    if (selectedRetroId && !selectedRetro()) selectedRetroId = null;
    if (!findMain(selectedMainId)) selectedMainId = design.mains.length ? design.mains[0].id : null;
    if (active && ((isSurfaceKind(active.kind) && !surfacePart(active.kind, active.id))
      || (active.kind === 'main' && !findMain(active.id)))) active = null;
  }

  // -----------------------------------------------------------
  // 性能の自動計算（変更のたびに少し遅らせて計算）
  // -----------------------------------------------------------
  let perfTimer = null;
  function schedulePerf() {
    if (perfTimer) clearTimeout(perfTimer);
    perfTimer = setTimeout(renderPerf, 180);
  }

  function renderPerf() {
    perfTimer = null;
    if (!design) return;
    const box = $('perfBox');
    try {
      const spec = buildShipSpecFromDesign(design);
      const ship = { ...spec, allocation: 'balanced', thrusterOutputRatios: {} };
      const a = ShipAllocator.prepare(ship);
      const m = spec.mass;
      const I = spec.inertiaTensor;
      const g = 9.80665;
      const fwd = a.capNeg[2] / m, back = a.capPos[2] / m;
      const lat = Math.min(a.capPos[0], a.capNeg[0], a.capPos[1], a.capNeg[1]) / m;
      const turn = (row, Iax) => {
        const alpha = Math.min(a.capPos[row], a.capNeg[row]) / Iax;
        if (!(alpha > 0)) return '回転できません';
        const th = Math.PI / 2, w = spec.maxAngularSpeed;
        const t = Math.sqrt(th * alpha) <= w ? 2 * Math.sqrt(th / alpha) : th / w + w / alpha;
        return fmtTime(t);
      };
      // 主エンジン全開を要求したときの配分（重心のずれをどこまで打ち消せるか）
      let ratios = null;
      for (let i = 0; i < 6; i++) ratios = ShipAllocator.solve(ship, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 });
      // 主エンジン全体として出せた推力の割合（エンジンごとの出力比を推力で重み付け）
      const mainTotal = shipDesignMainThrust(design);
      let mainUsed = 0;
      for (const e of design.mains) mainUsed += (ratios[`main_${e.id}`] || 0) * Math.max(0, e.thrust);
      const mainUse = mainTotal > 0 ? mainUsed / mainTotal : 0;
      const res = ShipAllocator.resultant(ship, ratios);
      const torqueCap = Math.max(a.capPos[3], a.capPos[4], 1e-9);
      const resid = Math.hypot(res.torque.x, res.torque.y) / torqueCap;
      const tc = shipDesignThrustCenter(design);
      const off = Math.hypot(design.cog.x - tc.x, design.cog.y - tc.y);
      const nMain = design.mains.length;
      const fwdEff = spec.maxAccel > 0 ? Math.min(fwd, spec.maxAccel) : fwd;
      const toMax = fwdEff > 0 ? spec.maxSpeed / fwdEff : Infinity;
      const pods = design.rcs.pods.length;
      let balance;
      if (off < design.hull.size * 1e-4) balance = '<span class="ok">釣り合っています（推力線が重心を通る）</span>';
      else if (mainUse > 0.98 && resid < 0.02) balance = `<span class="ok">重心のずれは姿勢スラスター${nMain > 1 ? 'とエンジンごとの出力差' : ''}で打ち消せます（主エンジン100%使用可）</span>`;
      else balance = `<span class="warn">重心のずれを打ち消しきれないため、主エンジンは${nMain > 1 ? '全体で' : ''}最大 ${Math.round(mainUse * 100)}% に自動で絞られます（姿勢スラスターを強くするか、重心を推力線に近づけてください）</span>`;
      box.innerHTML = [
        `前進の最大加速度: <b>${fmtNum(fwdEff)} m/s²</b>（${fmtNum(fwdEff / g, 2)} G）${fwdEff < fwd ? `（推力では ${fmtNum(fwd)} m/s²、最大加速度で制限）` : ''}・${Number.isFinite(spec.maxSpeed) ? `最高速度 ${fmtNum(spec.maxSpeed)} m/s まで約 ${fmtTime(toMax)}` : '最高速度: 無制限'}`,
        `減速（逆噴射）: ${fmtNum(back)} m/s²・横/上下への移動: ${fmtNum(lat)} m/s²`,
        `90°向きを変える時間: ピッチ ${turn(3, I.x)}・ヨー ${turn(4, I.y)}・ロール ${turn(5, I.z)}`,
        `主エンジン全開時: ${balance}`,
        `噴射口: 主エンジン${nMain}・逆噴射${design.retro.thrust > 0 ? design.retro.nozzles.length : 0}・姿勢スラスター${pods}基（各5方向）${design.gyro.torque > 0 ? '・姿勢制御ジャイロ' : ''}`,
        pods === 0 && !(design.gyro.torque > 0) ? '<span class="warn">姿勢スラスターかジャイロが無いと向きを変えられません。</span>' : '',
      ].filter(Boolean).join('<br>');
    } catch (e) {
      console.warn(e);
      box.textContent = '性能の計算に失敗しました。';
    }
  }

  // -----------------------------------------------------------
  // 編集の反映
  // -----------------------------------------------------------
  function markDirty() {
    dirty = true;
  }

  // v85: 重力場の密度境界面の高さ（重力場機関を積んだ艦だけ）
  function hasGravityEngine() {
    return design.mains.some((e) => e.engineType === 'gravity3' || e.engineType === 'gwave');
  }
  function syncBoundaryUi() {
    const on = hasGravityEngine();
    $('boundarySection').style.display = on ? '' : 'none';
    if (!on) return;
    const h = design.boundary.height;
    const lim = design.hull.dims.y * 0.75 + design.hull.size * 0.02;
    const sl = $('boundaryHeightSlider');
    sl.min = String(-lim); sl.max = String(lim); sl.step = String(design.hull.size / 2000);
    if (document.activeElement !== sl) sl.value = String(h ?? 0);
    if (document.activeElement !== $('boundaryHeightInput')) $('boundaryHeightInput').value = h === null ? '' : inputValue(h);
    const y = h ?? 0;
    const top = design.hull.dims.y / 2;
    $('boundaryLine').textContent = `船体の中心から ${y >= 0 ? '上' : '下'} ${fmtLen(Math.abs(y))}（船底から ${fmtLen(y + top)}・重心から ${fmtLen(Math.abs(y - design.cog.y))} ${y >= design.cog.y ? '上' : '下'}）`;
  }
  $('boundaryHeightInput').addEventListener('change', () => {
    const el = $('boundaryHeightInput');
    design.boundary.height = el.value === '' || !Number.isFinite(Number(el.value)) ? null : Number(el.value);
    onPhysicsEdit();
  });
  $('boundaryHeightSlider').addEventListener('input', () => {
    design.boundary.height = Number($('boundaryHeightSlider').value);
    rebuildMarkers();
    markDirty();
    syncBoundaryUi();
  });

  function onPhysicsEdit() {
    if (!design.retro.custom) autoPlaceRetro();
    rebuildMarkers();
    markDirty();
    syncUi();
  }

  function numFromInput(el, fallback) {
    const v = Number(el.value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  }

  $('designName').addEventListener('input', () => {
    design.name = $('designName').value;
    document.getElementById('classBadge').textContent = design.name;
    markDirty();
  });
  $('sizeSlider').addEventListener('input', () => setSize(Math.pow(10, Number($('sizeSlider').value))));
  $('sizeInput').addEventListener('change', () => setSize(Number($('sizeInput').value)));
  document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => setSize(Number(b.dataset.size))));
  $('boxW').addEventListener('input', () => setBoxRatio('x', Number($('boxW').value)));
  $('boxH').addEventListener('input', () => setBoxRatio('y', Number($('boxH').value)));

  $('massInput').addEventListener('change', () => { design.mass = Math.max(0.001, numFromInput($('massInput'), design.mass / 1000)) * 1000; onPhysicsEdit(); });
  // v85: 空欄 = 無制限（最高速度）・制限なし（最大加速度）
  $('maxSpeedInput').addEventListener('change', () => {
    const v = Number($('maxSpeedInput').value);
    design.maxSpeed = $('maxSpeedInput').value === '' || !(v > 0) ? null : Math.max(1, v);
    onPhysicsEdit();
  });
  $('maxAccelInput').addEventListener('change', () => {
    const v = Number($('maxAccelInput').value);
    design.maxAccel = $('maxAccelInput').value === '' || !(v > 0) ? null : v;
    onPhysicsEdit();
  });
  $('maxAngInput').addEventListener('change', () => { design.maxAngularSpeed = Math.max(0.05, numFromInput($('maxAngInput'), 1)) * Math.PI / 180; onPhysicsEdit(); });
  $('inertiaInput').addEventListener('change', () => { design.inertiaFactor = clamp(numFromInput($('inertiaInput'), design.inertiaFactor), 0.001, 2); onPhysicsEdit(); });
  $('mainThrustInput').addEventListener('change', () => {
    const e = selectedMain();
    if (!e) return;
    e.thrust = numFromInput($('mainThrustInput'), e.thrust / 1000) * 1000;
    onPhysicsEdit();
  });
  $('retroThrustInput').addEventListener('change', () => { design.retro.thrust = numFromInput($('retroThrustInput'), design.retro.thrust / 1000) * 1000; onPhysicsEdit(); });
  $('rcsThrustInput').addEventListener('change', () => { design.rcs.thrust = numFromInput($('rcsThrustInput'), design.rcs.thrust / 1000) * 1000; onPhysicsEdit(); });
  $('podThrustInput').addEventListener('change', () => {
    const pod = selectedPod();
    if (!pod) return;
    const v = Number($('podThrustInput').value);
    pod.thrust = $('podThrustInput').value === '' || !(v > 0) ? null : v * 1000;
    onPhysicsEdit();
  });

  $('autoSpecBtn').addEventListener('click', () => {
    const auto = shipDesignAutoSpec(design.baseClass, design.hull.size);
    design.mass = auto.mass;
    distributeMainThrust(auto.mainThrust);
    design.retro.thrust = auto.retroThrust;
    design.rcs.thrust = auto.rcsThrust;
    for (const pod of design.rcs.pods) pod.thrust = null;
    design.maxAngularSpeed = auto.maxAngularSpeed;
    design.maxSpeed = auto.maxSpeed;
    design.inertiaFactor = shipTemplateSpec(design.baseClass).inertiaFactor;
    onPhysicsEdit();
    core.setStatus(`大きさ ${fmtLen(design.hull.size)} に合わせて、${shipTemplateSpec(design.baseClass).label}の性能を元に質量・推力・角速度を決めました。`);
  });

  // 主エンジンの推力の合計を total にする（各エンジンの推力の比は保つ）
  function distributeMainThrust(total) {
    const cur = shipDesignMainThrust(design);
    for (const e of design.mains) {
      e.thrust = cur > 0 ? total * (Math.max(0, e.thrust) / cur) : total / design.mains.length;
    }
  }

  // 艦尾の表面のZ（その X・Y の位置で、後ろから船体に当たるところ）。
  // 当たらなければ船体の外形（箱）の艦尾の面
  function sternSurfaceZ(x, y) {
    const zMax = design.hull.dims.z / 2;
    const target = core.getModelRoot() || boxHull;
    if (!target) return zMax;
    target.updateWorldMatrix(true, true);
    const rc = new THREE.Raycaster(new THREE.Vector3(x, y, zMax + design.hull.size), new THREE.Vector3(0, 0, -1));
    const hits = rc.intersectObject(target, true);
    // 後ろ寄り1/4より前で当たるのは、艦尾に穴が開いているなどで中まで
    // 突き抜けたとき。その場合は外形の艦尾の面にする
    const h = hits.find((x) => x.object.isMesh && x.face && x.point.z >= zMax - design.hull.dims.z * 0.25);
    return h ? Math.min(h.point.z, zMax) : zMax;
  }

  // v84: 艦首の表面のZ（その X・Y の位置で、前から船体に当たるところ）
  function bowSurfaceZ(x, y) {
    const zMin = -design.hull.dims.z / 2;
    const target = core.getModelRoot() || boxHull;
    if (!target) return zMin;
    target.updateWorldMatrix(true, true);
    const rc = new THREE.Raycaster(new THREE.Vector3(x, y, zMin - design.hull.size), new THREE.Vector3(0, 0, 1));
    const hits = rc.intersectObject(target, true);
    const h = hits.find((x) => x.object.isMesh && x.face && x.point.z <= zMin + design.hull.dims.z * 0.25);
    return h ? Math.max(h.point.z, zMin) : zMin;
  }

  function nextMainId() {
    let n = 1;
    const used = new Set(design.mains.map((e) => e.id));
    while (used.has(`m${n}`)) n++;
    return `m${n}`;
  }

  // 主エンジンを足す: 選んでいるエンジンと同じ推力で、左右対称の位置
  // （そこが空いていなければ横にずらした位置）に置く
  $('mainAddBtn').addEventListener('click', () => {
    const src = selectedMain();
    const dims = design.hull.dims;
    const base = src ? src.position : { x: 0, y: 0, z: dims.z / 2 };
    const eps = design.hull.size * 1e-3;
    const taken = (x, y) => design.mains.some((e) => Math.abs(e.position.x - x) < eps && Math.abs(e.position.y - y) < eps);
    let x = -base.x, y = base.y;
    if (Math.abs(base.x) < eps || taken(x, y)) {
      const step = Math.max(dims.x * 0.22, design.hull.size * 0.02);
      x = base.x + step;
      for (let i = 0; i < 8 && taken(x, y); i++) x += step;
      x = clamp(x, -dims.x / 2, dims.x / 2);
    }
    const e = {
      id: nextMainId(),
      position: { x, y, z: base.z },
      thrust: src ? src.thrust : shipDesignAutoSpec(design.baseClass, design.hull.size).mainThrust,
      diameter: src ? src.diameter : null,
      engineType: src ? src.engineType : 'rocket',
    };
    design.mains.push(e);
    setActive('main', e.id);
    markDirty();
    core.setStatus(`主エンジンを追加しました（${design.mains.length}基）。矢印（ギズモ）をドラッグするか、位置の欄で動かせます。`);
  });
  $('mainRemoveBtn').addEventListener('click', () => {
    if (design.mains.length <= 1) return;
    const e = selectedMain();
    design.mains = design.mains.filter((x) => x !== e);
    selectedMainId = design.mains[0].id;
    if (active && active.kind === 'main') active = null;
    onPhysicsEdit();
    core.setStatus(`主エンジンを外しました（${design.mains.length}基）。`);
  });

  // v83: 質量と最高速度から推力を決める（きびきび・ふつう・ゆったり）
  const THRUST_PRESETS = {
    quick: { accelTime: 10, turnTime: 3, label: 'きびきび' },
    normal: { accelTime: 30, turnTime: 6, label: 'ふつう' },
    gentle: { accelTime: 90, turnTime: 12, label: 'ゆったり' },
  };
  function autoThrust(kind) {
    const p = THRUST_PRESETS[kind];
    if (!p) return;
    // v85: 最高速度が無制限なら、最大加速度（無ければ艦種の目安の最高速度）を基準にする
    const vRef = design.maxSpeed > 0 ? design.maxSpeed
      : design.maxAccel > 0 ? design.maxAccel * p.accelTime
        : shipDesignAutoSpec(design.baseClass, design.hull.size).maxSpeed;
    const accel = vRef / p.accelTime; // [m/s²]
    distributeMainThrust(design.mass * accel);
    design.retro.thrust = design.mass * accel * 0.35;
    // 姿勢スラスター: 90°（π/2）を加速→減速で turnTime 秒で回る角加速度 α = 4θ/T²
    // になるよう、今の配置のまま推力を一律に拡大・縮小する
    const need = (4 * (Math.PI / 2)) / (p.turnTime * p.turnTime);
    let turnNote = '';
    if (design.rcs.pods.length) {
      const spec = buildShipSpecFromDesign(design);
      const a = ShipAllocator.prepare({ ...spec, allocation: 'balanced', thrusterOutputRatios: {} });
      const I = spec.inertiaTensor;
      const alphas = [[3, I.x], [4, I.y], [5, I.z]]
        .map(([row, Iax]) => Math.min(a.capPos[row], a.capNeg[row]) / Iax)
        .filter((v) => v > 0);
      if (alphas.length) {
        const f = need / Math.min(...alphas);
        design.rcs.thrust *= f;
        for (const pod of design.rcs.pods) if (pod.thrust > 0) pod.thrust *= f;
      }
      // その時間で回れるよう、最大角速度が足りなければ上げる（加速→減速の頂点 π/T）
      const wNeed = Math.PI / p.turnTime;
      if (design.maxAngularSpeed < wNeed) {
        design.maxAngularSpeed = wNeed;
        turnNote = `（最大角速度も ${fmtNum(wNeed * 180 / Math.PI)}°/s に上げました）`;
      }
    } else {
      turnNote = '（姿勢スラスターが無いので、向きを変える推力は決めていません）';
    }
    onPhysicsEdit();
    const g = accel / 9.80665;
    core.setStatus(`「${p.label}」: 主エンジン合計 ${fmtForce(design.mass * accel)}（加速度 ${fmtNum(accel)} m/s²・${fmtNum(g, 2)} G、最高速度まで約${p.accelTime}秒）、逆噴射 ${fmtForce(design.retro.thrust)}、姿勢スラスター 1噴射口 ${fmtForce(design.rcs.thrust)}（90°を約${p.turnTime}秒）${turnNote}`);
  }
  document.querySelectorAll('[data-auto-thrust]').forEach((b) => b.addEventListener('click', () => autoThrust(b.dataset.autoThrust)));

  $('mainToSternBtn').addEventListener('click', () => {
    const e = selectedMain();
    if (!e) return;
    e.position = { x: e.position.x, y: e.position.y, z: sternSurfaceZ(e.position.x, e.position.y) };
    onPhysicsEdit();
  });
  // 推力の中心が重心の真後ろに来るよう、全エンジンを同じだけ上下左右にずらす
  $('mainToCogAxisBtn').addEventListener('click', () => {
    const tc = shipDesignThrustCenter(design);
    const dx = design.cog.x - tc.x, dy = design.cog.y - tc.y;
    for (const e of design.mains) e.position = { x: e.position.x + dx, y: e.position.y + dy, z: e.position.z };
    onPhysicsEdit();
  });
  $('cogToMainAxisBtn').addEventListener('click', () => {
    const tc = shipDesignThrustCenter(design);
    design.cog = { x: tc.x, y: tc.y, z: design.cog.z };
    onPhysicsEdit();
  });
  $('cogGizmoBtn').addEventListener('click', () => {
    setActive(active && active.kind === 'cog' ? null : 'cog');
  });
  $('cogToCenterBtn').addEventListener('click', () => {
    design.cog = { x: 0, y: 0, z: 0 };
    onPhysicsEdit();
  });

  $('rcsAutoBtn').addEventListener('click', () => {
    autoPlacePods();
    onPhysicsEdit();
    core.setStatus('姿勢スラスターを艦首寄り・艦尾寄りの上下左右に8基置きました。');
  });
  $('rcsClearBtn').addEventListener('click', () => {
    if (!design.rcs.pods.length) return;
    if (!confirm('姿勢スラスターを全部外しますか？')) return;
    design.rcs.pods = [];
    selectedPodId = null;
    if (active && active.kind === 'pod') active = null;
    onPhysicsEdit();
  });
  $('podSnapBtn').addEventListener('click', () => { snapSelectedPod(); onPhysicsEdit(); });
  $('podDeleteBtn').addEventListener('click', () => {
    design.rcs.pods = design.rcs.pods.filter((p) => p.id !== selectedPodId);
    selectedPodId = null;
    if (active && active.kind === 'pod') active = null;
    onPhysicsEdit();
  });

  // -----------------------------------------------------------
  // タップ: 姿勢スラスターの配置・選択
  // -----------------------------------------------------------
  // kind: 'pod'（姿勢スラスター）| 'retro'（逆噴射ノズル）| null（置くのをやめる）
  function setPlacing(kind) {
    placing = kind || null;
    for (const [btn, k] of [['rcsPlaceBtn', 'pod'], ['retroPlaceBtn', 'retro']]) {
      $(btn).classList.toggle('active', placing === k);
      $(btn).textContent = placing === k ? '完了' : '＋ 船体をタップして追加';
    }
    $('placeBanner').style.display = placing ? '' : 'none';
    $('placeBanner').textContent = placing === 'retro'
      ? '船体をタップして逆噴射ノズルを置きます（終わるときは「完了」）'
      : '船体をタップして姿勢スラスターを置きます（終わるときは「完了」）';
    placeGizmo();
  }
  $('rcsPlaceBtn').addEventListener('click', () => setPlacing(placing === 'pod' ? null : 'pod'));
  $('retroPlaceBtn').addEventListener('click', () => setPlacing(placing === 'retro' ? null : 'retro'));

  // v84: ノズルの直径・逆噴射ノズル
  $('mainDiaInput').addEventListener('change', () => {
    const e = selectedMain();
    if (!e) return;
    e.diameter = diameterFromInput($('mainDiaInput'));
    onPhysicsEdit();
  });
  // v85: 機関の種類
  $('mainEngineType').addEventListener('change', () => {
    const e = selectedMain();
    if (!e) return;
    e.engineType = shipEngineType($('mainEngineType').value);
    onPhysicsEdit();
  });
  $('mainTypeAllBtn').addEventListener('click', () => {
    const e = selectedMain();
    if (!e) return;
    for (const m of design.mains) m.engineType = e.engineType;
    onPhysicsEdit();
    core.setStatus(`主エンジン${design.mains.length}基を「${ENGINE_TYPES[e.engineType].label}」にしました。`);
  });
  // v85: 姿勢制御ジャイロ
  $('gyroTorqueInput').addEventListener('change', () => {
    const v = Number($('gyroTorqueInput').value);
    design.gyro.torque = $('gyroTorqueInput').value === '' || !(v > 0) ? 0 : v * 1000;
    onPhysicsEdit();
  });
  // ジャイロだけで90°を T 秒で回れる回す力（いちばん回りにくい軸に合わせる）: τ = I·4θ/T²
  document.querySelectorAll('[data-gyro-time]').forEach((b) => b.addEventListener('click', () => {
    const T = Number(b.dataset.gyroTime);
    if (!(T > 0)) { design.gyro.torque = 0; onPhysicsEdit(); return; }
    const I = buildShipSpecFromDesign(design).inertiaTensor;
    design.gyro.torque = Math.max(I.x, I.y, I.z) * (4 * (Math.PI / 2)) / (T * T);
    const wNeed = Math.PI / T;
    if (design.maxAngularSpeed < wNeed) design.maxAngularSpeed = wNeed;
    onPhysicsEdit();
    core.setStatus(`姿勢制御ジャイロ: 各軸 ${fmtNum(design.gyro.torque / 1000)} kN·m（ジャイロだけで90°を約${T}秒）`);
  }));

  $('retroAutoBtn').addEventListener('click', () => {
    autoPlaceRetro();
    onPhysicsEdit();
    core.setStatus('逆噴射ノズルを、艦首の表面の重心をはさんだ左右2か所に置きました（重心を動かすとそれに合わせて動きます）。');
  });
  $('retroSnapBtn').addEventListener('click', () => {
    const n = selectedRetro();
    if (!n) return;
    snapSurfacePart(n);
    design.retro.custom = true;
    onPhysicsEdit();
  });
  $('retroDeleteBtn').addEventListener('click', () => {
    design.retro.nozzles = design.retro.nozzles.filter((n) => n.id !== selectedRetroId);
    design.retro.custom = true;
    selectedRetroId = null;
    if (active && active.kind === 'retro') active = null;
    onPhysicsEdit();
    core.setStatus(design.retro.nozzles.length
      ? `逆噴射ノズルを外しました（${design.retro.nozzles.length}つ）。`
      : '逆噴射ノズルが無くなりました（逆噴射なし。減速は姿勢スラスターだけで行います）。');
  });

  const raycaster = new THREE.Raycaster();
  let tapStart = null;
  core.canvas.addEventListener('pointerdown', (e) => {
    tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), multi: core.isDragGesture() };
  });
  core.canvas.addEventListener('pointerup', (e) => {
    const st = tapStart;
    tapStart = null;
    if (!st || st.multi || core.isDragGesture()) return;
    if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > 6 || performance.now() - st.t > 600) return;
    handleTap(e);
  });

  // 画面上の点（clientX/Y）を通る視線
  function setRayFromClient(clientX, clientY) {
    const rect = core.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, core.getCamera());
    return raycaster.ray;
  }

  // 画面上の点の先にある船体表面の点と、そこでの（手前向きの）法線
  function raycastHullAt(clientX, clientY) {
    const target = core.getModelRoot() || boxHull;
    if (!target) return null;
    setRayFromClient(clientX, clientY);
    // 面のあるメッシュだけ（箱の仮船体の輪郭線や、モデル内の線・点には吸着しない）
    const h = raycaster.intersectObject(target, true).find((x) => x.object.isMesh && x.face);
    if (!h) return null;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    if (n.dot(raycaster.ray.direction) > 0) n.negate();
    return { position: { x: h.point.x, y: h.point.y, z: h.point.z }, normal: { x: n.x, y: n.y, z: n.z } };
  }

  function handleTap(e) {
    if (!placing) {
      // 部品（重心・主エンジン・姿勢スラスター）をタップ → 選んでギズモを出す。
      // 何もないところをタップ → 選択を外す
      setRayFromClient(e.clientX, e.clientY);
      const hit = raycaster.intersectObjects(markers.children, true).find((h) => h.object.userData.part);
      if (hit) {
        const part = hit.object.userData.part;
        setActive(part.kind, part.id);
        const sec = $({ pod: 'rcsSection', main: 'mainSection', cog: 'cogSection', retro: 'retroSection' }[part.kind]);
        if (sec) sec.open = true;
      } else if (active || selectedPodId || selectedRetroId) {
        setActive(null);
      }
      return;
    }
    const s = raycastHullAt(e.clientX, e.clientY);
    if (!s) return;
    if (placing === 'retro') {
      const n = { id: nextRetroId(), position: s.position, normal: s.normal, diameter: null };
      design.retro.nozzles.push(n);
      design.retro.custom = true;
      selectedRetroId = n.id;
      onPhysicsEdit();
      core.setStatus(`逆噴射ノズルを追加しました（${design.retro.nozzles.length}つ）。推力（合計）はノズルの数で等分します。`);
      return;
    }
    const pod = { id: nextPodId(), position: s.position, normal: s.normal };
    design.rcs.pods.push(pod);
    selectedPodId = pod.id;
    onPhysicsEdit();
    core.setStatus(`姿勢スラスターを追加しました（${design.rcs.pods.length}基）。`);
  }


  // -----------------------------------------------------------
  // v81: 移動ギズモ
  //   選んだ部品（重心・主エンジン・姿勢スラスター）に X(赤)・Y(緑)・Z(青) の
  //   矢印と、中央のつまみ（白）を出す。
  //   矢印をドラッグ → その軸に沿って動かす（姿勢スラスターは動かした先から
  //     いちばん近い船体表面に吸着したまま動く）
  //   つまみをドラッグ → 姿勢スラスターは指の下の船体表面を滑らせる。
  //     重心・主エンジンは画面に平行な面の中で動かす
  //   画面上でいつも同じ大きさに見えるよう、描画のたびに拡大率を合わせる。
  //   ドラッグは 09-ship-builder.js の視点操作より先に（キャプチャ段階で）
  //   受け取り、ギズモをつかんでいる間は視点が一緒に回らないようにする。
  // -----------------------------------------------------------
  const GIZMO_PX = 96; // 矢印の長さ（画面上のおよそのピクセル数）
  const GIZMO_AXES = [
    { key: 'x', dir: new THREE.Vector3(1, 0, 0), color: 0xff5a5a },
    { key: 'y', dir: new THREE.Vector3(0, 1, 0), color: 0x5ae06a },
    { key: 'z', dir: new THREE.Vector3(0, 0, 1), color: 0x5a9cff },
  ];
  const GIZMO_HOT = 0xffe14a; // つかんでいる矢印の色
  const gizmo = new THREE.Group();
  gizmo.visible = false;
  scene.add(gizmo);
  const gizmoMats = {};
  function gizmoMat(color) {
    return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  }
  for (const ax of GIZMO_AXES) {
    const mat = gizmoMat(ax.color);
    gizmoMats[ax.key] = { mat, color: ax.color };
    const arm = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.74, 8), mat);
    shaft.position.y = 0.14 + 0.37;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 16), mat);
    head.position.y = 0.88 + 0.1;
    shaft.renderOrder = 40;
    head.renderOrder = 40;
    arm.add(shaft, head);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ax.dir);
    gizmo.add(arm);
  }
  {
    const mat = gizmoMat(0xffffff);
    gizmoMats.free = { mat, color: 0xffffff };
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), mat);
    knob.renderOrder = 41;
    gizmo.add(knob);
  }
  gizmo.traverse((o) => { o.frustumCulled = false; });

  function setGizmoHot(key) {
    for (const [k, m] of Object.entries(gizmoMats)) m.mat.color.setHex(k === key ? GIZMO_HOT : m.color);
  }

  // 描画の直前に、画面上の大きさが一定になるよう拡大率を合わせる
  const _gv = new THREE.Vector3(), _gw = new THREE.Vector3();
  function updateGizmoScale(camera) {
    if (!gizmo.visible || !camera) return;
    const h = Math.max(1, core.canvas.clientHeight);
    let worldPerPx;
    if (camera.isOrthographicCamera) {
      worldPerPx = (camera.top - camera.bottom) / (camera.zoom || 1) / h;
    } else {
      camera.getWorldDirection(_gv);
      const depth = Math.max(camera.near, _gw.copy(gizmo.position).sub(camera.position).dot(_gv));
      worldPerPx = (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / h;
    }
    gizmo.scale.setScalar(worldPerPx * GIZMO_PX);
    gizmo.updateMatrixWorld(true);
  }
  const prevBeforeRender = scene.onBeforeRender;
  scene.onBeforeRender = function (renderer, sc, camera, rt) {
    if (typeof prevBeforeRender === 'function') prevBeforeRender.call(this, renderer, sc, camera, rt);
    updateGizmoScale(camera);
  };

  function activePosition() {
    if (!active || !design) return null;
    if (active.kind === 'cog') return design.cog;
    if (active.kind === 'main') { const e = findMain(active.id); return e ? e.position : null; }
    if (isSurfaceKind(active.kind)) { const part = surfacePart(active.kind, active.id); return part ? part.position : null; }
    return null;
  }

  function placeGizmo() {
    const p = placing ? null : activePosition();
    gizmo.visible = !!p;
    if (p) gizmo.position.set(p.x, p.y, p.z);
  }

  function partLabel(kind, id) {
    if (kind === 'cog') return '重心';
    if (kind === 'main') {
      const i = design.mains.findIndex((e) => e.id === id);
      return design.mains.length > 1 ? `主エンジン${i + 1}` : '主エンジン';
    }
    if (kind === 'retro') return `逆噴射ノズル${design.retro.nozzles.findIndex((n) => n.id === id) + 1}`;
    return `姿勢スラスター${design.rcs.pods.findIndex((p) => p.id === id) + 1}`;
  }

  // 設計座標の点 → 画面上の点（clientX/Y）
  const _pv = new THREE.Vector3();
  function toClient(p) {
    const rect = core.canvas.getBoundingClientRect();
    _pv.set(p.x, p.y, p.z).project(core.getCamera());
    return { x: rect.left + ((_pv.x + 1) / 2) * rect.width, y: rect.top + ((1 - _pv.y) / 2) * rect.height, z: _pv.z };
  }

  function segDist(px, py, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const L2 = vx * vx + vy * vy;
    const t = L2 > 1e-9 ? clamp(((px - a.x) * vx + (py - a.y) * vy) / L2, 0, 1) : 0;
    return Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
  }

  // 指（マウス）の下にあるギズモの部分: 'x' | 'y' | 'z' | 'free' | null。
  // 画面に映った矢印までの距離で判定する（指でもつかみやすいよう幅を広めに）
  function pickGizmo(clientX, clientY, pointerType) {
    if (!gizmo.visible) return null;
    const tol = pointerType === 'mouse' ? 14 : 24;
    const o = gizmo.position, sc = gizmo.scale.x;
    const c = toClient(o);
    if (c.z > 1) return null; // カメラの後ろ
    if (Math.hypot(clientX - c.x, clientY - c.y) <= tol + 4) return 'free';
    let best = null, bestD = tol;
    for (const ax of GIZMO_AXES) {
      const a = toClient({ x: o.x + ax.dir.x * sc * 0.14, y: o.y + ax.dir.y * sc * 0.14, z: o.z + ax.dir.z * sc * 0.14 });
      const b = toClient({ x: o.x + ax.dir.x * sc * 1.08, y: o.y + ax.dir.y * sc * 1.08, z: o.z + ax.dir.z * sc * 1.08 });
      const d = segDist(clientX, clientY, a, b);
      if (d < bestD) { bestD = d; best = ax.key; }
    }
    return best;
  }

  // 視線（ray）に最も近い、軸（origin + t·dir）上の点の t。視線と軸がほぼ平行なら null
  function axisParam(ray, origin, dir) {
    const w = new THREE.Vector3().subVectors(origin, ray.origin);
    const b = dir.dot(ray.direction);
    const denom = 1 - b * b;
    if (denom < 1e-4) return null;
    return (b * ray.direction.dot(w) - dir.dot(w)) / denom;
  }

  // ドラッグ中だけ、つかんだ軸に沿った長い線を出す
  let gizmoGuide = null;
  function showGizmoGuide(axisKey, origin) {
    hideGizmoGuide();
    const ax = GIZMO_AXES.find((a) => a.key === axisKey);
    if (!ax) return;
    const L = design.hull.size * 2;
    gizmoGuide = lineMesh([
      { x: origin.x - ax.dir.x * L, y: origin.y - ax.dir.y * L, z: origin.z - ax.dir.z * L },
      { x: origin.x + ax.dir.x * L, y: origin.y + ax.dir.y * L, z: origin.z + ax.dir.z * L },
    ], ax.color, false);
    gizmoGuide.material.opacity = 0.55;
    scene.add(gizmoGuide);
  }
  function hideGizmoGuide() {
    if (!gizmoGuide) return;
    scene.remove(gizmoGuide);
    gizmoGuide.geometry.dispose();
    gizmoGuide.material.dispose();
    gizmoGuide = null;
  }

  let gizmoDrag = null;

  function beginGizmoDrag(e, axis) {
    const p = activePosition();
    if (!p) return false;
    const start = new THREE.Vector3(p.x, p.y, p.z);
    const d = {
      pointerId: e.pointerId, axis, kind: active.kind, id: active.id, start,
      last: { x: e.clientX, y: e.clientY }, raf: 0, moved: false,
    };
    const ray = setRayFromClient(e.clientX, e.clientY).clone();
    if (axis !== 'free') {
      d.dir = GIZMO_AXES.find((a) => a.key === axis).dir.clone();
      // 視線とほぼ平行な軸は、指の動きから位置が決まらないので動かさない
      d.t0 = Math.abs(d.dir.dot(ray.direction)) < 0.995 ? axisParam(ray, start, d.dir) : null;
    } else {
      if (isSurfaceKind(d.kind)) {
        // 手前に見えている姿勢スラスター・逆噴射ノズルは、指の下の船体表面を滑らせる。
        // つまんだ点と部品の中心の画面上のずれを覚えておく（つかんだ瞬間に飛ばないように）
        const c = toClient(start);
        d.grab = { x: c.x - e.clientX, y: c.y - e.clientY };
        const h = raycastHullAt(c.x, c.y);
        d.surfaceSlide = !!h && Math.hypot(h.position.x - start.x, h.position.y - start.y, h.position.z - start.z) < design.hull.size * 0.03;
      }
      // 重心・主エンジンと、船体の陰（向こう側）にある姿勢スラスターは、
      // 画面に平行な面の中で動かす（姿勢スラスターはそこからいちばん近い表面へ）
      if (!d.surfaceSlide) {
        const n = core.getCamera().getWorldDirection(new THREE.Vector3());
        d.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, start);
        d.hit0 = ray.intersectPlane(d.plane, new THREE.Vector3());
        d.prevHit = d.hit0 ? d.hit0.clone() : null;
      }
    }
    gizmoDrag = d;
    try { core.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    setGizmoHot(axis);
    if (axis !== 'free') showGizmoGuide(axis, start);
    return true;
  }

  function gizmoDragMove() {
    const d = gizmoDrag;
    if (!d || !design) return;
    let p = null;
    if (d.axis !== 'free') {
      if (d.t0 === null) return;
      const t = axisParam(setRayFromClient(d.last.x, d.last.y), d.start, d.dir);
      if (t === null) return;
      p = d.start.clone().addScaledVector(d.dir, t - d.t0);
    } else if (d.surfaceSlide) {
      const s = raycastHullAt(d.last.x + d.grab.x, d.last.y + d.grab.y);
      if (s) applyGizmoPosition(d, s.position, s.normal);
      return;
    } else if (isSurfaceKind(d.kind)) {
      // 船体の陰にある姿勢スラスター: 指の動きを、いまいる点の表面に沿った
      // 向きに直して少しずつ動かし、そのたびに表面へ吸着する（角を回り込める）
      const h = setRayFromClient(d.last.x, d.last.y).intersectPlane(d.plane, new THREE.Vector3());
      const pod = surfacePart(d.kind, d.id);
      if (!h || !d.prevHit || !pod) return;
      const delta = h.clone().sub(d.prevHit);
      d.prevHit = h;
      const n = new THREE.Vector3(pod.normal.x, pod.normal.y, pod.normal.z).normalize();
      delta.addScaledVector(n, -delta.dot(n));
      if (delta.lengthSq() < 1e-12) return;
      const s = snapToHull({ x: pod.position.x + delta.x, y: pod.position.y + delta.y, z: pod.position.z + delta.z });
      if (s) applyGizmoPosition(d, s.position, s.normal);
      return;
    } else {
      const h = setRayFromClient(d.last.x, d.last.y).intersectPlane(d.plane, new THREE.Vector3());
      if (!h || !d.hit0) return;
      p = d.start.clone().add(h.sub(d.hit0));
    }
    // 視線と軸が平行に近いと指の小さな動きで遠くへ飛ぶため、位置の欄の
    // スライダーと同じ範囲（重心は船体の外形の1.3倍、主エンジンは1.5倍）に収める
    const ext = d.kind === 'cog' ? 1.3 : d.kind === 'main' ? 1.5 : 1.6;
    const lim = (ax) => Math.max(design.hull.dims[ax] / 2 * ext, design.hull.size * 0.02);
    const q = { x: clamp(p.x, -lim('x'), lim('x')), y: clamp(p.y, -lim('y'), lim('y')), z: clamp(p.z, -lim('z'), lim('z')) };
    if (isSurfaceKind(d.kind)) {
      const s = snapToHull(q);
      if (s) applyGizmoPosition(d, s.position, s.normal);
    } else {
      applyGizmoPosition(d, q, null);
    }
  }

  function applyGizmoPosition(d, pos, normal) {
    if (d.kind === 'cog') {
      design.cog = pos;
    } else if (d.kind === 'main') {
      const e = findMain(d.id);
      if (!e) return;
      e.position = pos;
    } else {
      const pod = surfacePart(d.kind, d.id);
      if (!pod) return;
      pod.position = pos;
      if (normal) pod.normal = normal;
      if (d.kind === 'retro') design.retro.custom = true;
    }
    d.moved = true;
    rebuildMarkers();
    syncUi();
    core.setStatus(`${partLabel(d.kind, d.id)}: X ${fmtNum(pos.x)} / Y ${fmtNum(pos.y)} / Z ${fmtNum(pos.z)} m`);
  }

  function endGizmoDrag() {
    const d = gizmoDrag;
    if (!d) return;
    if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; gizmoDragMove(); }
    gizmoDrag = null;
    try { core.canvas.releasePointerCapture(d.pointerId); } catch (err) { /* ignore */ }
    setGizmoHot(null);
    hideGizmoGuide();
    if (d.moved) onPhysicsEdit();
  }

  // キャプチャ段階（キャンバスの親）で受け取り、ギズモをつかんだときだけ
  // キャンバス（視点の回転・タップでの選択）へ伝えない
  const viewportWrap = core.canvas.parentElement;
  viewportWrap.addEventListener('pointerdown', (e) => {
    if (gizmoDrag) { e.stopPropagation(); e.preventDefault(); return; } // つかんでいる間のほかの指は無視
    if (e.target !== core.canvas || placing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const axis = pickGizmo(e.clientX, e.clientY, e.pointerType);
    if (!axis) return;
    if (!beginGizmoDrag(e, axis)) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  viewportWrap.addEventListener('pointermove', (e) => {
    const d = gizmoDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.stopPropagation();
    d.last = { x: e.clientX, y: e.clientY };
    // 位置の計算（船体表面への吸着など）は1フレームに1回だけ
    if (!d.raf) d.raf = requestAnimationFrame(() => { d.raf = 0; if (gizmoDrag === d) gizmoDragMove(); });
  }, true);
  const finishGizmoDrag = (e) => {
    if (!gizmoDrag || e.pointerId !== gizmoDrag.pointerId) return;
    e.stopPropagation();
    endGizmoDrag();
  };
  viewportWrap.addEventListener('pointerup', finishGizmoDrag, true);
  viewportWrap.addEventListener('pointercancel', finishGizmoDrag, true);
  viewportWrap.addEventListener('lostpointercapture', finishGizmoDrag, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !active) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    setActive(null);
  });

  // -----------------------------------------------------------
  // 09-ship-builder.js（3Dビュー・モデル読み込み）とのつなぎ
  // -----------------------------------------------------------
  core.setHooks({
    hullHalfExtents: () => (design ? { x: design.hull.dims.x / 2, y: design.hull.dims.y / 2, z: design.hull.dims.z / 2 } : { x: 0, y: 0, z: 0 }),
    onRotationCommit: () => {
      if (!design || !core.getModelRoot()) return;
      // 主エンジンは船体の外形（箱）の中での相対的な位置を保つ
      // （艦尾にあったものは、向きを変えたあとの船体の艦尾へ）
      const old = { ...design.hull.dims };
      // v83: 重心がモデルの原点にあれば、向きを変えたあとも原点に合わせる
      // （原点はモデルを置いている補正ノードの位置 = adjust.offset）
      const o0 = core.adjust.offset;
      const cogAtOrigin = Math.hypot(design.cog.x - o0.x, design.cog.y - o0.y, design.cog.z - o0.z) < design.hull.size * 1e-3;
      refitHullToModel();
      if (cogAtOrigin) design.cog = { ...core.adjust.offset };
      remapMainsToDims(old, false);
      resnapPods();
      afterShapeChange(false);
    },
    onModelLoaded: (fromUser) => {
      if (!design) return;
      if (!fromUser) {
        refitHullToModel();
        afterShapeChange(true);
        return;
      }
      // v83: 新しいモデルは、モデルの寸法のまま（1単位 = 1m）使い、重心をモデルの
      // 原点に置く。エンジン・スラスターなどの位置は大きさの比で移し、主エンジンは
      // 新しい船体の艦尾の表面へ、スラスターは新しい船体の表面へ寄せる。
      const oldSize = design.hull.size;
      const old = { ...design.hull.dims };
      refitHullToModel({ native: true });
      const k = design.hull.size / Math.max(oldSize, 1e-9);
      if (Math.abs(k - 1) > 1e-9) {
        scalePartsBy(k);
        const df = core.getDockingFace();
        if (df) core.setDockingFace({ ...df, offsetU: df.offsetU * k, offsetV: df.offsetV * k });
        if ($('sizeScalesSpec').checked) scaleSpecBySize(k);
      }
      design.cog = { ...core.adjust.offset };
      design.hull.modelFileName = core.getModelFileName() || design.hull.modelFileName;
      design.hull.hasModel = true;
      remapMainsToDims({ x: old.x * k, y: old.y * k, z: old.z * k }, true);
      resnapPods();
      modelDirty = true;
      const clamped = Math.abs(design.hull.size - preciseModelBoxMax()) > design.hull.size * 1e-6;
      core.setStatus(`モデルを読み込みました（${clamped ? `大きすぎる・小さすぎるので ${fmtLen(design.hull.size)} に合わせました` : `モデルの大きさのまま: 全長 ${fmtLen(design.hull.dims.z)}`}）。重心はモデルの原点に置きました。向きが違う場合は「モデルの向き」で直してください。`);
      afterShapeChange(true);
    },
  });

  // 船体の外形が old → 今の寸法に変わったとき（モデルの読み込み・向きの変更）の
  // 主エンジンの移し方。上下左右の位置はそのまま（新しい外形からはみ出す分は
  // 縁まで）にし、艦尾寄り（後ろ1/4）にあったエンジンと、toStern のときは
  // 全エンジンを、新しい船体の艦尾の表面へ寄せる。それ以外は前後の位置を
  // 全長の比率で移す。
  function remapMainsToDims(old, toStern) {
    const nd = design.hull.dims;
    for (const e of design.mains) {
      const x = clamp(e.position.x, -nd.x / 2, nd.x / 2);
      const y = clamp(e.position.y, -nd.y / 2, nd.y / 2);
      const atStern = toStern || e.position.z >= old.z / 4;
      e.position = { x, y, z: atStern ? sternSurfaceZ(x, y) : e.position.z * (nd.z / Math.max(old.z, 1e-9)) };
    }
  }

  $('openModelLoaderBtn').addEventListener('click', () => core.showDropzone());
  $('removeModelBtn').addEventListener('click', () => {
    if (!confirm('モデルを外して、箱の仮船体に戻しますか？（保存するまでは元に戻せます）')) return;
    core.removeModel();
    design.hull.hasModel = false;
    design.hull.modelFileName = null;
    const br = design.hull.boxRatio;
    design.hull.dims = { x: design.hull.size * br.x, y: design.hull.size * br.y, z: design.hull.size };
    hullVersion++;
    resnapPods();
    modelDirty = true;
    afterShapeChange(true);
  });

  // -----------------------------------------------------------
  // 設計の作成・読み込み・保存
  // -----------------------------------------------------------
  async function refreshDesignList() {
    const list = await listShipDesigns();
    const sel = $('designSelect');
    sel.innerHTML = '';
    const cur = document.createElement('option');
    cur.value = '';
    cur.textContent = list.some((d) => d.id === design.id) ? '（ほかの設計を開く）' : '（未保存の新しい設計）';
    sel.appendChild(cur);
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${d.name}（${fmtLen(d.hull.size)}）${d.id === design.id ? ' ← 編集中' : ''}`;
      sel.appendChild(o);
    }
    sel.value = '';
  }

  function confirmDiscard() {
    return !dirty || confirm('保存していない変更があります。破棄してよいですか？');
  }

  async function openDesign(d, opts) {
    design = normalizeShipDesign(d);
    selectedPodId = null;
    selectedRetroId = null;
    selectedMainId = design.mains.length ? design.mains[0].id : null;
    active = null;
    setPlacing(null);
    core.removeModel();
    const a = core.adjust;
    a.rotationDeg = { ...design.hull.rotationDeg };
    a.scale = design.hull.scale;
    a.offset = { ...design.hull.offset };
    core.syncRotationUi();
    core.applyAdjust();
    hullVersion++;
    core.setDockingFace(design.dockingFace);
    const modelData = opts && opts.modelData !== undefined
      ? opts.modelData
      : (design.hull.hasModel ? await loadShipDesignModel(design.id) : null);
    if (modelData) {
      try {
        core.setStatus('船体モデルを読み込んでいます…');
        await core.restoreModelFromData(modelData);
        core.setStatus('');
      } catch (e) {
        console.error(e);
        core.setStatus('船体モデルの読み込みに失敗しました。箱の仮船体で表示しています。', true);
        design.hull.hasModel = false;
      }
    } else if (design.hull.hasModel) {
      design.hull.hasModel = false;
    }
    hullVersion++;
    core.setSceneScale(design.hull.size);
    rebuildBoxHull();
    rebuildMarkers();
    core.rebuildDockingFaceGizmo();
    frameCamera();
    syncUi();
    dirty = !!(opts && opts.dirty);
    modelDirty = !!(opts && opts.modelDirty);
    await refreshDesignList();
  }

  // 艦種ごとに保存されていた旧方式のモデル（ship-builder.html v77以前）があれば、
  // 新しい設計の船体として引き継ぐ
  async function newDesign(baseClass, importClassModel) {
    const d = createShipDesign(baseClass);
    let modelData = null;
    if (importClassModel) {
      const legacy = await loadShipModelData(baseClass);
      if (legacy && (legacy.glbDataUrl || legacy.objText)) {
        modelData = legacy;
        pendingLegacyScale = legacy.adjust && legacy.adjust.scale > 0 ? legacy.adjust.scale : null;
        d.hull.hasModel = true;
        d.hull.modelFileName = legacy.fileName;
        if (legacy.adjust) d.hull.rotationDeg = { ...legacy.adjust.rotationDeg };
        d.dockingFace = legacy.dockingFace || null;
        d.name = `${shipTemplateSpec(baseClass).label}（${legacy.fileName || 'モデル'}）`;
      }
    }
    await openDesign(d, { modelData, dirty: true, modelDirty: !!modelData });
    if (modelData) {
      // 旧方式で合わせていた大きさをそのまま使い、性能はその大きさの目安値にする
      const auto = shipDesignAutoSpec(design.baseClass, design.hull.size);
      Object.assign(design, { mass: auto.mass, maxSpeed: auto.maxSpeed, maxAngularSpeed: auto.maxAngularSpeed });
      design.retro.thrust = auto.retroThrust;
      design.rcs.thrust = auto.rcsThrust;
      autoPlacePods();
      design.mains = [{ id: 'm1', position: { x: 0, y: 0, z: sternSurfaceZ(0, 0) }, thrust: auto.mainThrust, diameter: null }];
      autoPlaceRetro();
      selectedMainId = 'm1';
      rebuildMarkers();
      syncUi();
      core.setStatus(`この艦種に保存されていたモデル「${modelData.fileName || ''}」で新しい設計を作りました。名前を付けて保存してください。`);
    } else {
      core.setStatus(`${shipTemplateSpec(baseClass).label}をひな形に新しい設計を作りました。`);
    }
  }

  async function saveCurrent() {
    design.name = ($('designName').value || '').trim() || '名称未設定の艦';
    design.dockingFace = core.getDockingFace();
    design.hull.rotationDeg = { ...core.adjust.rotationDeg };
    design.hull.scale = core.adjust.scale;
    design.hull.offset = { ...core.adjust.offset };
    const modelData = core.getModelDataForSave();
    design.hull.hasModel = !!modelData;
    design.hull.modelFileName = modelData ? modelData.fileName : null;
    $('saveBtn').disabled = true;
    $('saveAndFlyBtn').disabled = true;
    core.setStatus('保存中…');
    try {
      // v80: モデルを変えたら版を更新（端末間の同期で、モデルを送り直すかの判断に使う）
      if (modelDirty) design.hull.modelRev = modelData ? generateShipDesignId() : null;
      await saveShipDesign(design);
      if (modelDirty) await saveShipDesignModel(design.id, modelData);
      dirty = false;
      modelDirty = false;
      core.setStatus(`「${design.name}」を保存しました。`);
      await refreshDesignList();
      // v80: 自動同期がオンなら、この設計を同期先へ送る（失敗しても保存自体は済んでいる）
      // v82: Googleアカウント・GitHub のうち、自動同期がオンのもの
      if (typeof ShipSync !== 'undefined' && ShipSync.isAutoSync()) {
        ShipSync.syncAll((msg) => core.setStatus(`「${design.name}」を保存しました。${msg}`), { autoOnly: true })
          .catch((e) => core.setStatus(`「${design.name}」を保存しました（同期に失敗: ${e.message || e}）`, true));
      }
      return true;
    } catch (e) {
      console.error(e);
      core.setStatus(e && e.name === 'QuotaExceededError'
        ? '保存に失敗しました（容量不足）。端末のストレージ空き容量を確認するか、モデルのファイルサイズを小さくしてください。'
        : '保存に失敗しました。', true);
      return false;
    } finally {
      $('saveBtn').disabled = false;
      $('saveAndFlyBtn').disabled = false;
    }
  }

  $('saveBtn').addEventListener('click', () => saveCurrent());
  $('saveAndFlyBtn').addEventListener('click', async () => {
    if (!(await saveCurrent())) return;
    savePersistedSettings({ shipDesignId: design.id, shipClass: design.baseClass });
    location.href = `index.html?design=${encodeURIComponent(design.id)}`;
  });

  $('designSelect').addEventListener('change', async () => {
    const id = $('designSelect').value;
    if (!id || id === design.id) { $('designSelect').value = ''; return; }
    if (!confirmDiscard()) { $('designSelect').value = ''; return; }
    const d = await loadShipDesign(id);
    if (d) await openDesign(d);
  });
  $('newDesignBtn').addEventListener('click', async () => {
    if (!confirmDiscard()) return;
    await newDesign($('templateSelect').value, false);
  });
  $('duplicateDesignBtn').addEventListener('click', async () => {
    const copy = normalizeShipDesign(JSON.parse(JSON.stringify(design)));
    copy.id = generateShipDesignId();
    copy.name = `${design.name}のコピー`;
    copy.createdAt = Date.now();
    const modelData = core.getModelDataForSave();
    design = copy;
    dirty = true;
    modelDirty = !!modelData;
    syncUi();
    await saveCurrent();
    core.setStatus(`複製して「${design.name}」として保存しました。`);
  });
  $('deleteDesignBtn').addEventListener('click', async () => {
    if (!confirm(`「${design.name}」を削除しますか？（元に戻せません）`)) return;
    try {
      await deleteShipDesign(design.id);
    } catch (e) {
      console.error(e);
    }
    const persisted = loadPersistedSettings();
    if (persisted.shipDesignId === design.id) savePersistedSettings({ shipDesignId: null });
    dirty = false;
    const list = await listShipDesigns();
    if (list.length) await openDesign(list[0]);
    else await newDesign($('templateSelect').value, false);
    core.setStatus('削除しました。');
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // v82: Googleアカウントで同期している端末なら、保存したときに自動で送れるよう
  // ログイン状態を確かめておく（ログインは設定画面で行う）
  if (typeof GoogleSync !== 'undefined' && GoogleSync.isAvailable()) {
    GoogleSync.init().catch((e) => console.warn('Googleアカウントでの同期の準備に失敗しました。', e));
  }

  // ひな形の選択肢
  for (const [key, preset] of Object.entries(ShipClassPresets)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `${preset.label}（${fmtLen(shipTemplateSpec(key).size)}）`;
    $('templateSelect').appendChild(o);
  }
  $('templateSelect').value = core.initialClassKey;

  // -----------------------------------------------------------
  // 起動: ?design=ID → その設計 / ?class=… → 新しい設計 / どちらも無ければ
  // ゲームで選んでいる設計、それも無ければ新しい設計
  // -----------------------------------------------------------
  (async () => {
    const params = new URLSearchParams(location.search);
    const persisted = loadPersistedSettings();
    let d = null;
    if (params.get('design')) d = await loadShipDesign(params.get('design'));
    else if (!params.get('class') && persisted.shipDesignId) d = await loadShipDesign(persisted.shipDesignId);
    if (d) await openDesign(d);
    else await newDesign(core.initialClassKey, true);
  })();

  // テスト・デバッグ用
  window.ShipDesigner = {
    get design() { return design; },
    get active() { return active; },
    snapToHull,
    setSize,
    setActive,
    autoPlacePods: () => { autoPlacePods(); onPhysicsEdit(); },
    save: saveCurrent,
    // ギズモの各部分（'x' | 'y' | 'z' | 'free'、t = 矢印の根元0〜先端1）の画面上の位置
    gizmoClientPoint(key, t) {
      if (!gizmo.visible) return null;
      const o = gizmo.position, sc = gizmo.scale.x;
      const ax = GIZMO_AXES.find((a) => a.key === key);
      const k = ax ? sc * (0.14 + 0.94 * (t === undefined ? 0.7 : t)) : 0;
      const dir = ax ? ax.dir : new THREE.Vector3();
      return toClient({ x: o.x + dir.x * k, y: o.y + dir.y * k, z: o.z + dir.z * k });
    },
    partClientPoint(kind, id) {
      const p = kind === 'cog' ? design.cog
        : kind === 'main' ? (findMain(id) || {}).position
          : (surfacePart(kind, id) || {}).position;
      return p ? toClient(p) : null;
    },
  };
})();
