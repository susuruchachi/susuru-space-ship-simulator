// =============================================================
// 23-collision.js
// 艦とドッキングポートの当たり判定（ゲーム中）
//
// v79: v76で作りかけていた「船とポートの当たり判定」の仕上げ。
// 当たり判定の形は 01-state-and-config.js の computeCollisionShape()
// （モデルを立方体の格子で近似し、直方体の集まりにしたもの）で作る。
//   - 艦: 艦の座標系（重心が原点）。モデルを読み込んだとき（index.html）に作る。
//   - ポート: ポートの座標系（入港目的地が原点、艦が入ってくる向きが+Z）。
//     ポートのモデルを読み込んだとき（10-docking-platform.js）に作る。
//     モデルの無いポート（簡易ゲート表示のみ）は誘導用の表示なので当たらない。
//
// 判定: 艦の各直方体を、ポートの座標系で見た「向きのある箱」にして、
// ポートの直方体（座標軸にそろった箱）と分離軸定理（15軸）で重なりを調べる。
// めり込んでいたら最も浅い向きへ押し戻し、ポートへ向かう速度を打ち消す
// （少しだけ跳ね返す）。物理の小刻み（05-ship-controller.js）ごとに呼ぶ。
//
// 入港の最終段階（自動ドッキングのトンネル内・入港後、または目的地の
// すぐそばで向きがそろっているとき）は判定しない。格子で近似した形は
// 実際より最大1マスぶん大きいため、接舷面どうしが触れる入港の瞬間に
// 引っかかってしまうのを避けるため。
// =============================================================

const Collision = {
  ship: null,     // { boxes, bounds, cell, radius, center }
  port: null,     // { boxes, bounds, cell, grid }
  portKey: null,
  lastContactAt: 0,
  contactCount: 0,
  RESTITUTION: 0.15,   // 跳ね返りの強さ（0=くっつく, 1=完全に跳ね返る）
  SHRINK_CELLS: 0.25,  // 格子の近似ぶんの余裕（マスの何割、箱を小さくするか）

  setShipShape(shape) {
    this.ship = shape ? this._prepareShip(shape) : null;
  },

  setPortShape(shape, key) {
    this.port = shape ? this._preparePort(shape) : null;
    this.portKey = shape ? key : null;
  },

  _shrink(b, d) {
    const min = { x: b.min.x + d, y: b.min.y + d, z: b.min.z + d };
    const max = { x: b.max.x - d, y: b.max.y - d, z: b.max.z - d };
    if (min.x > max.x) { min.x = max.x = (b.min.x + b.max.x) / 2; }
    if (min.y > max.y) { min.y = max.y = (b.min.y + b.max.y) / 2; }
    if (min.z > max.z) { min.z = max.z = (b.min.z + b.max.z) / 2; }
    return { min, max };
  },

  _prepareShip(shape) {
    const d = shape.cell * this.SHRINK_CELLS;
    const boxes = shape.boxes.map((b) => {
      const s = this._shrink(b, d);
      return {
        c: { x: (s.min.x + s.max.x) / 2, y: (s.min.y + s.max.y) / 2, z: (s.min.z + s.max.z) / 2 },
        h: { x: (s.max.x - s.min.x) / 2, y: (s.max.y - s.min.y) / 2, z: (s.max.z - s.min.z) / 2 },
      };
    });
    const bn = shape.bounds;
    const center = { x: (bn.min.x + bn.max.x) / 2, y: (bn.min.y + bn.max.y) / 2, z: (bn.min.z + bn.max.z) / 2 };
    const radius = Math.hypot(bn.max.x - bn.min.x, bn.max.y - bn.min.y, bn.max.z - bn.min.z) / 2;
    return { boxes, center, radius, cell: shape.cell };
  },

  // ポートの直方体を、粗い格子（ハッシュ）に登録しておき、艦の箱の近くの
  // ものだけを調べられるようにする
  _preparePort(shape) {
    const d = shape.cell * this.SHRINK_CELLS;
    const boxes = shape.boxes.map((b) => this._shrink(b, d));
    const bn = shape.bounds;
    const g = Math.max(shape.cell * 4, 1e-6);
    const grid = new Map();
    const key = (i, j, k) => `${i},${j},${k}`;
    boxes.forEach((b, idx) => {
      for (let i = Math.floor(b.min.x / g); i <= Math.floor(b.max.x / g); i++) {
        for (let j = Math.floor(b.min.y / g); j <= Math.floor(b.max.y / g); j++) {
          for (let k = Math.floor(b.min.z / g); k <= Math.floor(b.max.z / g); k++) {
            const kk = key(i, j, k);
            if (!grid.has(kk)) grid.set(kk, []);
            grid.get(kk).push(idx);
          }
        }
      }
    });
    return { boxes, bounds: bn, cell: shape.cell, g, grid, key };
  },

  // 入港の最終段階は判定しない（上のコメント参照）
  _isDockingExempt(ship) {
    const phase = ship.autoDockingEnabled ? ship._dockingPhase : null;
    if (phase === 'tunnel' || phase === 'docked') return true;
    const target = State.dockingTarget;
    if (!target) return false;
    const eff = computeEffectiveShipDockingTarget(target, ship);
    const dist = Math.hypot(ship.position.x - eff.position.x, ship.position.y - eff.position.y, ship.position.z - eff.position.z);
    const r = this.ship ? this.ship.radius : 10;
    if (dist > Math.max(r * 0.6, 2)) return false;
    // 向きのずれ（艦首方向どうしの角度）が10°未満
    const f1 = rotateVecByQuat({ x: 0, y: 0, z: -1 }, ship.quaternion);
    const f2 = rotateVecByQuat({ x: 0, y: 0, z: -1 }, eff.quaternion);
    return vecDot(f1, f2) > Math.cos((10 * Math.PI) / 180);
  },

  // 物理の小刻みごとに呼ぶ。prev はこの刻みで動く前の位置。接触して押し戻したら true
  resolve(ship, prev) {
    if (!this.ship || !this.port || !ship) return false;
    if (typeof Navigation !== 'undefined' && !Navigation.isHome()) return false;
    const target = State.dockingTarget;
    if (!target) return false;
    if (this._isDockingExempt(ship)) return false;

    // 速いときに薄い壁をすり抜けないよう、1刻みの移動が格子の半マスより長ければ
    // 途中の位置も順に調べ、最初に当たった位置まで戻してから押し戻す
    if (prev) {
      const mx = ship.position.x - prev.x, my = ship.position.y - prev.y, mz = ship.position.z - prev.z;
      const moved = Math.hypot(mx, my, mz);
      const stepLen = Math.min(this.port.cell, this.ship.cell * 4) * 0.5;
      if (moved > stepLen) {
        const n = Math.min(64, Math.ceil(moved / stepLen));
        const end = { ...ship.position };
        for (let i = 1; i < n; i++) {
          ship.position.x = prev.x + (mx * i) / n;
          ship.position.y = prev.y + (my * i) / n;
          ship.position.z = prev.z + (mz * i) / n;
          if (this._deepestContact(ship, target)) break;
          if (i === n - 1) { ship.position.x = end.x; ship.position.y = end.y; ship.position.z = end.z; }
        }
      }
    }

    let touched = false;
    for (let iter = 0; iter < 4; iter++) {
      const hit = this._deepestContact(ship, target);
      if (!hit) break;
      touched = true;
      // 押し戻し（ポートの座標系の法線 → 母港の座標系）
      const nW = rotateVecByQuat(hit.normal, target.quaternion);
      const push = hit.depth + this.ship.cell * 0.01;
      ship.position.x += nW.x * push;
      ship.position.y += nW.y * push;
      ship.position.z += nW.z * push;
      // ポートへ向かう速度を打ち消し、少しだけ跳ね返す
      const vn = vecDot(ship.velocity, nW);
      if (vn < 0) {
        const k = (1 + this.RESTITUTION) * vn;
        ship.velocity.x -= nW.x * k;
        ship.velocity.y -= nW.y * k;
        ship.velocity.z -= nW.z * k;
        // こすれた分の減速と回転の減衰
        ship.velocity.x *= 0.98; ship.velocity.y *= 0.98; ship.velocity.z *= 0.98;
        ship.angularVelocity.x *= 0.9; ship.angularVelocity.y *= 0.9; ship.angularVelocity.z *= 0.9;
      }
    }
    if (touched) {
      const now = performance.now();
      if (now - this.lastContactAt > 600) this.contactCount++;
      this.lastContactAt = now;
    }
    return touched;
  },

  // 最も深くめり込んでいる箱の組（ポートの座標系の法線と深さ）
  _deepestContact(ship, target) {
    const S = this.ship, P = this.port;
    // 艦 → ポートの座標系への変換
    const qInv = conjugateQuat(target.quaternion);
    const qRel = multiplyQuat(qInv, ship.quaternion);
    const tRel = rotateVecByQuat({
      x: ship.position.x - target.position.x,
      y: ship.position.y - target.position.y,
      z: ship.position.z - target.position.z,
    }, qInv);
    // 回転行列（列 = 艦の各軸のポート座標系での向き）
    const ax = rotateVecByQuat({ x: 1, y: 0, z: 0 }, qRel);
    const ay = rotateVecByQuat({ x: 0, y: 1, z: 0 }, qRel);
    const az = rotateVecByQuat({ x: 0, y: 0, z: 1 }, qRel);
    const toPort = (p) => ({
      x: tRel.x + ax.x * p.x + ay.x * p.y + az.x * p.z,
      y: tRel.y + ax.y * p.x + ay.y * p.y + az.y * p.z,
      z: tRel.z + ax.z * p.x + ay.z * p.y + az.z * p.z,
    });

    // 大まかな判定: 艦全体を包む球がポートの範囲に届かなければ終わり
    const sc = toPort(S.center);
    const bn = P.bounds;
    const dx = Math.max(bn.min.x - sc.x, 0, sc.x - bn.max.x);
    const dy = Math.max(bn.min.y - sc.y, 0, sc.y - bn.max.y);
    const dz = Math.max(bn.min.z - sc.z, 0, sc.z - bn.max.z);
    if (dx * dx + dy * dy + dz * dz > S.radius * S.radius) return null;

    let best = null;
    const R = [[ax.x, ay.x, az.x], [ax.y, ay.y, az.y], [ax.z, ay.z, az.z]]; // R[i][j] = ポート軸i・艦軸jの成分
    const seen = new Set();
    for (const sb of S.boxes) {
      const c = toPort(sb.c);
      const h = [sb.h.x, sb.h.y, sb.h.z];
      // この箱のポート座標系での範囲（各軸の半幅）
      const ex = Math.abs(R[0][0]) * h[0] + Math.abs(R[0][1]) * h[1] + Math.abs(R[0][2]) * h[2];
      const ey = Math.abs(R[1][0]) * h[0] + Math.abs(R[1][1]) * h[1] + Math.abs(R[1][2]) * h[2];
      const ez = Math.abs(R[2][0]) * h[0] + Math.abs(R[2][1]) * h[1] + Math.abs(R[2][2]) * h[2];
      if (c.x + ex < bn.min.x || c.x - ex > bn.max.x || c.y + ey < bn.min.y || c.y - ey > bn.max.y || c.z + ez < bn.min.z || c.z - ez > bn.max.z) continue;
      seen.clear();
      const g = P.g;
      for (let i = Math.floor((c.x - ex) / g); i <= Math.floor((c.x + ex) / g); i++) {
        for (let j = Math.floor((c.y - ey) / g); j <= Math.floor((c.y + ey) / g); j++) {
          for (let k = Math.floor((c.z - ez) / g); k <= Math.floor((c.z + ez) / g); k++) {
            const list = P.grid.get(P.key(i, j, k));
            if (!list) continue;
            for (const idx of list) {
              if (seen.has(idx)) continue;
              seen.add(idx);
              const pb = P.boxes[idx];
              if (c.x + ex < pb.min.x || c.x - ex > pb.max.x || c.y + ey < pb.min.y || c.y - ey > pb.max.y || c.z + ez < pb.min.z || c.z - ez > pb.max.z) continue;
              const hit = this._satObbAabb(c, R, h, pb);
              if (hit && (!best || hit.depth > best.depth)) best = hit;
            }
          }
        }
      }
    }
    return best;
  },

  // 向きのある箱（中心c・軸R・半幅h）と座標軸にそろった箱（pb）の分離軸判定。
  // 重なっていれば、押し戻しの向き（ポートの箱→艦の箱）と深さを返す。
  _satObbAabb(c, R, h, pb) {
    const a = [(pb.max.x - pb.min.x) / 2, (pb.max.y - pb.min.y) / 2, (pb.max.z - pb.min.z) / 2];
    const T = [c.x - (pb.min.x + pb.max.x) / 2, c.y - (pb.min.y + pb.max.y) / 2, c.z - (pb.min.z + pb.max.z) / 2];
    const absR = R.map((row) => row.map((v) => Math.abs(v) + 1e-9));
    let minDepth = Infinity;
    let normal = null;
    const test = (L, ra, rb, t) => {
      const len = Math.hypot(L[0], L[1], L[2]);
      if (len < 1e-6) return true; // 平行な辺どうしの外積（判定に使わない）
      const depth = (ra + rb - Math.abs(t)) / len;
      if (depth < 0) return false;
      if (depth < minDepth) {
        minDepth = depth;
        const sgn = t >= 0 ? 1 : -1;
        normal = { x: (L[0] / len) * sgn, y: (L[1] / len) * sgn, z: (L[2] / len) * sgn };
      }
      return true;
    };
    // ポートの軸
    for (let i = 0; i < 3; i++) {
      const rb = absR[i][0] * h[0] + absR[i][1] * h[1] + absR[i][2] * h[2];
      const L = [0, 0, 0]; L[i] = 1;
      if (!test(L, a[i], rb, T[i])) return null;
    }
    // 艦の箱の軸
    for (let j = 0; j < 3; j++) {
      const ra = a[0] * absR[0][j] + a[1] * absR[1][j] + a[2] * absR[2][j];
      const t = T[0] * R[0][j] + T[1] * R[1][j] + T[2] * R[2][j];
      if (!test([R[0][j], R[1][j], R[2][j]], ra, h[j], t)) return null;
    }
    // 辺どうしの外積（ポート軸i × 艦軸j）
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const i1 = (i + 1) % 3, i2 = (i + 2) % 3, j1 = (j + 1) % 3, j2 = (j + 2) % 3;
        const ra = a[i1] * absR[i2][j] + a[i2] * absR[i1][j];
        const rb = h[j1] * absR[i][j2] + h[j2] * absR[i][j1];
        const t = T[i2] * R[i1][j] - T[i1] * R[i2][j];
        // 軸 L = e_i × (艦軸j)
        const L = [0, 0, 0];
        const bj = [R[0][j], R[1][j], R[2][j]];
        L[i1] = -bj[i2];
        L[i2] = bj[i1];
        if (!test(L, ra, rb, t)) return null;
      }
    }
    return normal ? { normal, depth: minDepth } : null;
  },
};
