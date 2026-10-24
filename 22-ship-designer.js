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
  let placing = false;
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
    retro: new THREE.MeshBasicMaterial({ color: 0xb7a6ff, depthTest: false, transparent: true }),
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

  function rebuildMarkers() {
    disposeGroup(markers);
    if (!design) return;
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

    // 主エンジン: 噴射口（後ろ向きの円錐）と推力線
    const mp = design.main.position;
    markers.add(cone(mp, { x: 0, y: 0, z: 1 }, u * 3, u * 1.4, MAT.main));
    markers.add(lineMesh([
      { x: mp.x, y: mp.y, z: -dims.z * 0.75 },
      { x: mp.x, y: mp.y, z: dims.z * 0.75 },
    ], 0x6cf0ff, true, u * 1.5));
    // 重心から推力線までのずれ
    const off = Math.hypot(c.x - mp.x, c.y - mp.y);
    if (off > size * 1e-4) {
      markers.add(lineMesh([{ x: c.x, y: c.y, z: c.z }, { x: mp.x, y: mp.y, z: c.z }], 0xff6a4a, false));
    }

    // 逆噴射
    if (design.retro.thrust > 0) {
      const spec = buildShipSpecFromDesign(design);
      for (const t of spec.thrusters.filter((x) => x.id.startsWith('retro'))) {
        const p = { x: t.position.x + c.x, y: t.position.y + c.y, z: t.position.z + c.z };
        markers.add(cone(p, { x: 0, y: 0, z: -1 }, u * 2, u * 0.8, MAT.retro));
      }
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
      hit.userData.podId = pod.id;
      g.add(hit);
      g.position.set(pod.position.x, pod.position.y, pod.position.z);
      markers.add(g);
    }
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

  // モデルを設計の大きさに合わせ、中心を原点に置き直す
  function refitHullToModel() {
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

  function resnapPods() {
    for (const pod of design.rcs.pods) {
      const s = snapToHull(pod.position);
      if (s) { pod.position = s.position; pod.normal = s.normal; }
    }
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
  }

  function nextPodId() {
    let n = 1;
    const used = new Set(design.rcs.pods.map((p) => p.id));
    while (used.has(`p${n}`)) n++;
    return `p${n}`;
  }

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
    design.main.position = sc(design.main.position);
    for (const pod of design.rcs.pods) pod.position = sc(pod.position);
    const df = core.getDockingFace();
    if (df) core.setDockingFace({ ...df, offsetU: df.offsetU * k, offsetV: df.offsetV * k });
    if ($('sizeScalesSpec').checked) {
      // 質量は体積に比例、推力は質量に比例（加速度を保つ）、角速度は控えめに
      const k3 = k * k * k;
      design.mass *= k3;
      design.main.thrust *= k3;
      design.retro.thrust *= k3;
      design.rcs.thrust *= k3;
      for (const pod of design.rcs.pods) if (pod.thrust > 0) pod.thrust *= k3;
      design.maxAngularSpeed = clamp(design.maxAngularSpeed / Math.sqrt(k), 0.002, 6);
    }
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
    design.main.position[axis] = clamp(design.main.position[axis], -design.hull.dims[axis] / 2, design.hull.dims[axis] / 2);
    hullVersion++;
    resnapPods();
    afterShapeChange(false);
  }

  function afterShapeChange(frame) {
    core.setSceneScale(design.hull.size);
    rebuildBoxHull();
    rebuildMarkers();
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

  const mainPos = makePosRows($('mainPosRows'), () => design.main.position, (v) => {
    design.main.position = v;
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

  function selectedPod() {
    return design && design.rcs.pods.find((p) => p.id === selectedPodId) || null;
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
    if (document.activeElement !== $('maxSpeedInput')) $('maxSpeedInput').value = inputValue(design.maxSpeed);
    if (document.activeElement !== $('maxAngInput')) $('maxAngInput').value = inputValue(design.maxAngularSpeed * 180 / Math.PI);
    if (document.activeElement !== $('inertiaInput')) $('inertiaInput').value = inputValue(design.inertiaFactor);
    if (document.activeElement !== $('mainThrustInput')) $('mainThrustInput').value = inputValue(design.main.thrust / 1000);
    if (document.activeElement !== $('retroThrustInput')) $('retroThrustInput').value = inputValue(design.retro.thrust / 1000);
    if (document.activeElement !== $('rcsThrustInput')) $('rcsThrustInput').value = inputValue(design.rcs.thrust / 1000);
    const g = 9.80665;
    const aMain = design.main.thrust / design.mass;
    $('mainAccelLine').textContent = `主エンジンだけでの加速度 ${fmtNum(aMain)} m/s²（${fmtNum(aMain / g, 2)} G）`;
    const aRetro = design.retro.thrust / design.mass;
    $('retroAccelLine').textContent = `逆噴射だけでの減速度 ${fmtNum(aRetro)} m/s²（${fmtNum(aRetro / g, 2)} G）`;
    const off = Math.hypot(design.cog.x - design.main.position.x, design.cog.y - design.main.position.y);
    const offEl = $('mainOffsetLine');
    if (off < design.hull.size * 1e-4) {
      offEl.textContent = '推力線は重心を通っています（主エンジンだけでは回転しない）。';
      offEl.classList.remove('warn');
    } else {
      offEl.textContent = `推力線と重心のずれ ${fmtLen(off)}（主エンジン全開で ${fmtForce(design.main.thrust * off).replace('N', 'N·m')} の回転力）`;
      offEl.classList.add('warn');
    }
    for (const id of ['faceOffU', 'faceOffV']) {
      const el = $(id);
      const lim = Math.max(20, Math.round(design.hull.size / 2));
      el.min = String(-lim);
      el.max = String(lim);
      el.step = String(Math.max(0.1, design.hull.size / 1000));
    }
    mainPos.sync(1.5);
    cogPos.sync(1.3);
    renderPodList();
    schedulePerf();
  }

  function renderPodList() {
    const list = $('podList');
    list.innerHTML = '';
    design.rcs.pods.forEach((pod, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `pod-chip${pod.id === selectedPodId ? ' selected' : ''}`;
      chip.textContent = `${i + 1}. ${podSideLabel(pod)}`;
      chip.addEventListener('click', () => selectPod(pod.id === selectedPodId ? null : pod.id));
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

  function selectPod(id) {
    selectedPodId = id;
    rebuildMarkers();
    renderPodList();
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
      const mainUse = ratios.main || 0;
      const res = ShipAllocator.resultant(ship, ratios);
      const torqueCap = Math.max(a.capPos[3], a.capPos[4], 1e-9);
      const resid = Math.hypot(res.torque.x, res.torque.y) / torqueCap;
      const off = Math.hypot(design.cog.x - design.main.position.x, design.cog.y - design.main.position.y);
      const toMax = fwd > 0 ? spec.maxSpeed / fwd : Infinity;
      const pods = design.rcs.pods.length;
      let balance;
      if (off < design.hull.size * 1e-4) balance = '<span class="ok">釣り合っています（推力線が重心を通る）</span>';
      else if (mainUse > 0.98 && resid < 0.02) balance = '<span class="ok">重心のずれは姿勢スラスターで打ち消せます（主エンジン100%使用可）</span>';
      else balance = `<span class="warn">重心のずれを打ち消しきれないため、主エンジンは最大 ${Math.round(mainUse * 100)}% に自動で絞られます（姿勢スラスターを強くするか、重心を推力線に近づけてください）</span>`;
      box.innerHTML = [
        `前進の最大加速度: <b>${fmtNum(fwd)} m/s²</b>（${fmtNum(fwd / g, 2)} G）・最高速度 ${fmtNum(spec.maxSpeed)} m/s まで約 ${fmtTime(toMax)}`,
        `減速（逆噴射）: ${fmtNum(back)} m/s²・横/上下への移動: ${fmtNum(lat)} m/s²`,
        `90°向きを変える時間: ピッチ ${turn(3, I.x)}・ヨー ${turn(4, I.y)}・ロール ${turn(5, I.z)}`,
        `主エンジン全開時: ${balance}`,
        `噴射口: 主エンジン1・逆噴射${design.retro.thrust > 0 ? 2 : 0}・姿勢スラスター${pods}基（各5方向）`,
        pods === 0 ? '<span class="warn">姿勢スラスターが無いと向きを変えられません。</span>' : '',
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

  function onPhysicsEdit() {
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
  $('maxSpeedInput').addEventListener('change', () => { design.maxSpeed = Math.max(1, numFromInput($('maxSpeedInput'), design.maxSpeed)); onPhysicsEdit(); });
  $('maxAngInput').addEventListener('change', () => { design.maxAngularSpeed = Math.max(0.05, numFromInput($('maxAngInput'), 1)) * Math.PI / 180; onPhysicsEdit(); });
  $('inertiaInput').addEventListener('change', () => { design.inertiaFactor = clamp(numFromInput($('inertiaInput'), design.inertiaFactor), 0.001, 2); onPhysicsEdit(); });
  $('mainThrustInput').addEventListener('change', () => { design.main.thrust = numFromInput($('mainThrustInput'), design.main.thrust / 1000) * 1000; onPhysicsEdit(); });
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
    design.main.thrust = auto.mainThrust;
    design.retro.thrust = auto.retroThrust;
    design.rcs.thrust = auto.rcsThrust;
    for (const pod of design.rcs.pods) pod.thrust = null;
    design.maxAngularSpeed = auto.maxAngularSpeed;
    design.maxSpeed = auto.maxSpeed;
    design.inertiaFactor = shipTemplateSpec(design.baseClass).inertiaFactor;
    onPhysicsEdit();
    core.setStatus(`大きさ ${fmtLen(design.hull.size)} に合わせて、${shipTemplateSpec(design.baseClass).label}の性能を元に質量・推力・角速度を決めました。`);
  });

  $('mainToSternBtn').addEventListener('click', () => {
    design.main.position = { x: 0, y: 0, z: design.hull.dims.z / 2 };
    onPhysicsEdit();
  });
  $('mainToCogAxisBtn').addEventListener('click', () => {
    design.main.position = { x: design.cog.x, y: design.cog.y, z: design.main.position.z };
    onPhysicsEdit();
  });
  $('cogToMainAxisBtn').addEventListener('click', () => {
    design.cog = { x: design.main.position.x, y: design.main.position.y, z: design.cog.z };
    onPhysicsEdit();
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
    onPhysicsEdit();
  });
  $('podSnapBtn').addEventListener('click', () => { snapSelectedPod(); onPhysicsEdit(); });
  $('podDeleteBtn').addEventListener('click', () => {
    design.rcs.pods = design.rcs.pods.filter((p) => p.id !== selectedPodId);
    selectedPodId = null;
    onPhysicsEdit();
  });

  // -----------------------------------------------------------
  // タップ: 姿勢スラスターの配置・選択
  // -----------------------------------------------------------
  function setPlacing(on) {
    placing = on;
    $('rcsPlaceBtn').classList.toggle('active', on);
    $('rcsPlaceBtn').textContent = on ? '完了' : '＋ 船体をタップして追加';
    $('placeBanner').style.display = on ? '' : 'none';
  }
  $('rcsPlaceBtn').addEventListener('click', () => setPlacing(!placing));

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

  function handleTap(e) {
    const rect = core.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const cam = core.getCamera();
    raycaster.setFromCamera(ndc, cam);
    // 既存のスラスターの選択（配置モード中も、既存の■をタップしたら選択）
    const podHits = raycaster.intersectObjects(markers.children, true).filter((h) => h.object.userData.podId);
    if (podHits.length && !placing) {
      selectPod(podHits[0].object.userData.podId);
      $('rcsSection').open = true;
      return;
    }
    if (!placing) return;
    const target = core.getModelRoot() || boxHull;
    if (!target) return;
    const hits = raycaster.intersectObject(target, true);
    if (!hits.length) return;
    const h = hits[0];
    let n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    if (n.dot(raycaster.ray.direction) > 0) n.negate();
    const pod = {
      id: nextPodId(),
      position: { x: h.point.x, y: h.point.y, z: h.point.z },
      normal: { x: n.x, y: n.y, z: n.z },
    };
    design.rcs.pods.push(pod);
    selectedPodId = pod.id;
    onPhysicsEdit();
    core.setStatus(`姿勢スラスターを追加しました（${design.rcs.pods.length}基）。`);
  }

  // -----------------------------------------------------------
  // 09-ship-builder.js（3Dビュー・モデル読み込み）とのつなぎ
  // -----------------------------------------------------------
  core.setHooks({
    hullHalfExtents: () => (design ? { x: design.hull.dims.x / 2, y: design.hull.dims.y / 2, z: design.hull.dims.z / 2 } : { x: 0, y: 0, z: 0 }),
    onRotationCommit: () => {
      if (!design || !core.getModelRoot()) return;
      const m = design.main.position, eps = design.hull.size * 1e-3;
      const atStern = Math.abs(m.x) < eps && Math.abs(m.y) < eps && Math.abs(m.z - design.hull.dims.z / 2) < eps;
      refitHullToModel();
      if (atStern) design.main.position = { x: 0, y: 0, z: design.hull.dims.z / 2 };
      resnapPods();
      afterShapeChange(false);
    },
    onModelLoaded: (fromUser) => {
      if (!design) return;
      refitHullToModel();
      if (fromUser) {
        // 新しいモデル: 主エンジンを艦尾の中央へ、スラスターは新しい船体の表面へ
        design.hull.modelFileName = core.getModelFileName() || design.hull.modelFileName;
        design.hull.hasModel = true;
        design.main.position = { x: 0, y: 0, z: design.hull.dims.z / 2 };
        resnapPods();
        modelDirty = true;
        core.setStatus('モデルを読み込みました。設計の大きさに合わせて拡大・縮小しています。向きが違う場合は「モデルの向き」で直してください。');
      }
      afterShapeChange(true);
    },
  });

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
    setPlacing(false);
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
      design.main.thrust = auto.mainThrust;
      design.retro.thrust = auto.retroThrust;
      design.rcs.thrust = auto.rcsThrust;
      autoPlacePods();
      design.main.position = { x: 0, y: 0, z: design.hull.dims.z / 2 };
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
      await saveShipDesign(design);
      if (modelDirty) await saveShipDesignModel(design.id, modelData);
      dirty = false;
      modelDirty = false;
      core.setStatus(`「${design.name}」を保存しました。`);
      await refreshDesignList();
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
    snapToHull,
    setSize,
    autoPlacePods: () => { autoPlacePods(); onPhysicsEdit(); },
    save: saveCurrent,
  };
})();
