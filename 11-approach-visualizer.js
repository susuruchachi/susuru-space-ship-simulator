// =============================================================
// 11-approach-visualizer.js
// 進入軸・予定航路・自動航行の航跡の可視化（距離2000まで50間隔）
//
// 表示するもの:
//   1) 進入軸: 目的地(target.position)から進入方向
//      (approachAxisWorld、艦が来る側)へ2000まで伸びる線と、
//      50間隔で並べた点の両方。目的地の位置・姿勢が変わらない
//      限り再構築不要な静的な表示。
//      表示/非表示は State.settings.showApproachGuides
//      （目的地ゲート=DockingPlatformとも共通）。
//   2) 予定航路: 艦が実際にこれから辿ろうとしている経路
//      （ThrusterSolverの通常フェーズと同じベジエ曲線＋仮想
//      ウェイポイント以降は進入軸に沿った直線）を、艦の現在位置
//      から2000先まで1本の線として描画する（点は打たない）。
//      艦が動くたびに毎フレーム再構築する（ベジエは艦の現在位置・
//      向きに依存するため、静的にキャッシュできない）。
//   3) v42: 自動航行の航跡: ship.autoDockingEnabledがtrueの間、
//      実際に艦が通った位置を一定間隔で記録し、暗いオレンジの線
//      として描画する（予定航路の明るいオレンジと見分けやすい
//      よう暗めの色にする）。自動航行がOFFになっても記録済みの
//      航跡はそのまま残し、目的地が変わった（新しい目的地を保存
//      した）時点でクリアする。
//   予定航路と航跡はセットで扱いたいという要望のため、2)と3)は
//   両方とも State.settings.showRouteLine で一括に表示/非表示する
//   （進入軸・目的地ゲートとは独立）。
//
// State.dockingTarget が無い間は3種とも描画しない（航跡のみ、
// 記録済みの点列は目的地が消えても保持し、再設定時に備える）。
// =============================================================

const ApproachVisualizer = {
  MARKER_INTERVAL: 50,
  MARKER_RANGE: 2000,
  // v41: 「点は1/4の大きさでいい」という要望への対応。v40時点の
  // サイズ(isMajor時3.2/3.0、それ以外1.8/1.6)をベースサイズとし、
  // ここで一括して1/4に縮小する。
  POINT_SCALE: 0.25,

  // v42: 自動航行の航跡を記録する間隔（ワールド距離）。予定航路の
  // MARKER_INTERVALと揃える必要はないが、細かすぎると点数が
  // 増えすぎるため50に合わせる。
  TRAIL_MIN_SPACING: 50,
  // 航跡点の保持上限（メモリ・描画コスト対策。長時間の自動航行でも
  // 無制限に増え続けないようにする）。
  TRAIL_MAX_POINTS: 4000,

  _axisGroup: null,   // 進入軸: 点+線をまとめたグループ（静的）
  _routeGroup: null,  // 予定航路: 線のみ（動的、毎フレーム再構築）
  _trailLine: null,   // 自動航行の航跡: 線のみ（動的、点が増えるたび再構築）
  _trailPoints: [],   // 記録済みの航跡の頂点列（ワールド座標）
  _axisKey: null, // 進入軸を再構築すべきか判定するための目的地シグネチャ
  _trailTargetKey: null, // 航跡をクリアすべきか判定するための目的地シグネチャ

  init(scene) {
    this._scene = scene;
  },

  update() {
    const target = State.dockingTarget;

    const axisVisible = !!target && State.settings.showApproachGuides !== false;
    if (!axisVisible) {
      this._clearAxis();
    } else {
      this._updateAxis(target);
    }

    this._recordTrail(target);

    const routeVisible = !!target && State.settings.showRouteLine !== false;
    if (!routeVisible) {
      this._clearRoute();
      this._clearTrailLine();
    } else {
      this._updateRoute(target);
      this._updateTrailLine();
    }
  },

  _clearAxis() {
    if (!this._axisGroup) return;
    this._scene.remove(this._axisGroup);
    this._disposeGroup(this._axisGroup);
    this._axisGroup = null;
    this._axisKey = null;
  },

  _clearRoute() {
    if (!this._routeGroup) return;
    this._scene.remove(this._routeGroup);
    this._disposeGroup(this._routeGroup);
    this._routeGroup = null;
  },

  _clearTrailLine() {
    if (!this._trailLine) return;
    this._scene.remove(this._trailLine);
    this._disposeGroup(this._trailLine);
    this._trailLine = null;
  },

  // -----------------------------------------------------------
  // 進入軸（静的）: 目的地の位置・姿勢が変わっていなければ
  // 再構築しない。DockingPlatform._buildGateMeshと同じ方針で、
  // 目的地のシグネチャ文字列を比較して無駄な再生成を避ける。
  // 線1本(0〜2000)と、50間隔の点群の両方をグループにまとめる。
  // -----------------------------------------------------------
  _updateAxis(target) {
    const key = `${target.position.x},${target.position.y},${target.position.z},`
      + `${target.quaternion.x},${target.quaternion.y},${target.quaternion.z},${target.quaternion.w}`;
    if (this._axisGroup && this._axisKey === key) return;

    this._clearAxis();

    const approachAxisWorld = vecNormalize(
      rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion)
    );

    const group = new THREE.Group();
    group.userData.isApproachAxis = true;

    group.add(this._buildAxisLine(target.position, approachAxisWorld));

    const count = Math.floor(this.MARKER_RANGE / this.MARKER_INTERVAL);
    for (let i = 1; i <= count; i++) {
      const dist = i * this.MARKER_INTERVAL;
      const pos = {
        x: target.position.x - approachAxisWorld.x * dist,
        y: target.position.y - approachAxisWorld.y * dist,
        z: target.position.z - approachAxisWorld.z * dist,
      };
      group.add(this._buildAxisPoint(pos, dist));
    }

    this._scene.add(group);
    this._axisGroup = group;
    this._axisKey = key;
  },

  // 進入軸の線: target.positionから進入方向へMARKER_RANGE分
  // 伸ばした1本の直線。
  _buildAxisLine(targetPos, approachAxisWorld) {
    const start = { x: targetPos.x, y: targetPos.y, z: targetPos.z };
    const end = {
      x: targetPos.x - approachAxisWorld.x * this.MARKER_RANGE,
      y: targetPos.y - approachAxisWorld.y * this.MARKER_RANGE,
      z: targetPos.z - approachAxisWorld.z * this.MARKER_RANGE,
    };
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(start.x, start.y, start.z),
      new THREE.Vector3(end.x, end.y, end.z),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.35 });
    return new THREE.Line(geo, mat);
  },

  // 進入軸の点1個分。100区切りごとに大きめ・明るめにして距離の
  // 目安にする。v41でベースサイズをPOINT_SCALE倍に縮小。
  _buildAxisPoint(pos, dist) {
    const isMajor = dist % 100 === 0;
    const color = isMajor ? 0x66aaff : 0x336688;
    const baseSize = isMajor ? 3.2 : 1.8;
    const opacity = isMajor ? 0.65 : 0.35;

    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
    const marker = new THREE.Mesh(new THREE.SphereGeometry(baseSize * this.POINT_SCALE, 6, 6), mat);
    marker.position.set(pos.x, pos.y, pos.z);
    return marker;
  },

  // -----------------------------------------------------------
  // v42: 自動航行の航跡を記録する。
  //   - 目的地が変わった（新しく保存し直した）ら過去の航跡は
  //     意味を失うのでクリアする。
  //   - 目的地が無くなった（未設定に戻った）場合も同様にクリアする。
  //   - ship.autoDockingEnabledがtrueの間だけ、直近記録点から
  //     TRAIL_MIN_SPACING以上離れたタイミングで点を追加する
  //     （毎フレーム記録すると点が密集しすぎるため）。
  // -----------------------------------------------------------
  _recordTrail(target) {
    const key = target
      ? `${target.position.x},${target.position.y},${target.position.z},`
        + `${target.quaternion.x},${target.quaternion.y},${target.quaternion.z},${target.quaternion.w}`
      : null;
    if (key !== this._trailTargetKey) {
      this._trailPoints = [];
      this._trailTargetKey = key;
    }

    const ship = State.ship;
    const autoOn = !!(ship && ship.autoDockingEnabled && target);
    if (!autoOn) return;

    const pos = { x: ship.position.x, y: ship.position.y, z: ship.position.z };
    const last = this._trailPoints[this._trailPoints.length - 1];
    if (last) {
      const d = vecLength({ x: pos.x - last.x, y: pos.y - last.y, z: pos.z - last.z });
      if (d < this.TRAIL_MIN_SPACING) return;
    }

    this._trailPoints.push(pos);
    if (this._trailPoints.length > this.TRAIL_MAX_POINTS) {
      this._trailPoints.shift();
    }
  },

  // 記録済みの航跡点列から線を再構築する。予定航路（明るいオレンジ
  // 0xffaa33）より暗いオレンジにして見分けやすくする。
  _updateTrailLine() {
    this._clearTrailLine();
    if (this._trailPoints.length < 2) return;

    const geo = new THREE.BufferGeometry().setFromPoints(
      this._trailPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z))
    );
    const mat = new THREE.LineBasicMaterial({ color: 0xaa6600, transparent: true, opacity: 0.75 });
    const line = new THREE.Line(geo, mat);
    line.userData.isTrailLine = true;

    this._scene.add(line);
    this._trailLine = line;
  },

  // -----------------------------------------------------------
  // 予定航路（動的）: 毎フレーム再構築。線のみ（点は打たない）。
  //
  // ThrusterSolverの通常フェーズと同じ考え方で経路を求める:
  //   - onApproachSideがfalse（艦が目的地の奥側にいる）間は経路を
  //     引かない（この状況はThrusterSolver側も目的地の方角への
  //     単純フォールバックに切り替わり、艦自身がベジエに沿わないため）。
  //   - 手前側にいる間は、仮想ウェイポイント（v39の距離クランプ込み）
  //     へ向かうベジエを構築し、その先（仮想ウェイポイントから
  //     target.positionまで）は進入軸に沿った直線として繋げる。
  //     ベジエ+直線をつないだ1本の折れ線として2000まで描画する。
  // -----------------------------------------------------------
  _updateRoute(target) {
    this._clearRoute();

    const ship = State.ship;
    if (!ship) return;

    const toTargetWorld = {
      x: target.position.x - ship.position.x,
      y: target.position.y - ship.position.y,
      z: target.position.z - ship.position.z,
    };
    const distance = vecLength(toTargetWorld);
    if (distance <= 1e-4) return;

    const approachAxisWorld = vecNormalize(
      rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion)
    );
    const alongDistWorld = vecDot(toTargetWorld, approachAxisWorld);

    // 艦が目的地の奥側に出てしまっている間は、通常フェーズのベジエ
    // 経路そのものが使われない（ThrusterSolver側もフォールバック
    // する）ため、可視化上も経路を引かない。
    if (alongDistWorld < 0) return;

    const virtualTargetPos = ThrusterSolver._computeVirtualApproachTarget(
      target,
      approachAxisWorld,
      alongDistWorld
    );
    const virtualTarget = { position: virtualTargetPos, quaternion: target.quaternion };
    const distanceToVirtual = vecLength({
      x: virtualTargetPos.x - ship.position.x,
      y: virtualTargetPos.y - ship.position.y,
      z: virtualTargetPos.z - ship.position.z,
    });

    const bezier = ThrusterSolver._buildApproachBezier(
      ship,
      virtualTarget,
      approachAxisWorld,
      distanceToVirtual
    );

    const points = this._sampleRoutePolyline(bezier, virtualTargetPos, approachAxisWorld);
    if (points.length < 2) return;

    const geo = new THREE.BufferGeometry().setFromPoints(
      points.map((p) => new THREE.Vector3(p.x, p.y, p.z))
    );
    const mat = new THREE.LineBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.7 });
    const line = new THREE.Line(geo, mat);
    line.userData.isRouteLine = true;

    this._scene.add(line);
    this._routeGroup = line;
  },

  // ベジエ(P0=艦位置 -> P3=仮想ウェイポイント)を弧長ベースで
  // MARKER_INTERVAL間隔にサンプリングした頂点列を返し、曲線が
  // 尽きた後は仮想ウェイポイントから進入軸方向へ延長した頂点を
  // 足してMARKER_RANGEまで埋める。折れ線描画用の頂点列そのもの
  // （点オブジェクトは作らない）。
  _sampleRoutePolyline(bezier, virtualTargetPos, approachAxisWorld) {
    const SEGMENTS = 48;
    const result = [{ x: bezier.p0.x, y: bezier.p0.y, z: bezier.p0.z }];

    let prev = bezier.p0;
    let accumulated = 0;
    let nextMarkerAt = this.MARKER_INTERVAL;
    let bezierLength = 0;

    for (let i = 1; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const point = ThrusterSolver._evalBezier(bezier, t);
      const segLen = vecLength({
        x: point.x - prev.x,
        y: point.y - prev.y,
        z: point.z - prev.z,
      });

      while (nextMarkerAt <= accumulated + segLen && nextMarkerAt <= this.MARKER_RANGE) {
        const remain = nextMarkerAt - accumulated;
        const segT = segLen > 1e-6 ? remain / segLen : 0;
        result.push({
          x: prev.x + (point.x - prev.x) * segT,
          y: prev.y + (point.y - prev.y) * segT,
          z: prev.z + (point.z - prev.z) * segT,
        });
        nextMarkerAt += this.MARKER_INTERVAL;
      }

      accumulated += segLen;
      prev = point;
    }
    bezierLength = accumulated;

    // ベジエ終端（仮想ウェイポイント）以降、まだMARKER_RANGEに
    // 達していなければ進入軸に沿った直線（仮想ウェイポイント->
    // target.position、さらにその先も同じ方向）で頂点を延長する。
    while (nextMarkerAt <= this.MARKER_RANGE) {
      const remain = nextMarkerAt - bezierLength;
      result.push({
        x: virtualTargetPos.x + approachAxisWorld.x * remain,
        y: virtualTargetPos.y + approachAxisWorld.y * remain,
        z: virtualTargetPos.z + approachAxisWorld.z * remain,
      });
      nextMarkerAt += this.MARKER_INTERVAL;
    }

    return result;
  },

  _disposeGroup(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  },
};
