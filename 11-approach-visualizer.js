// =============================================================
// 11-approach-visualizer.js
// 進入軸・予定航路の可視化（距離2000まで50間隔でマーカー表示）
//
// 表示するもの:
//   1) 進入軸マーカー: 目的地(target.position)から進入方向
//      (approachAxisWorld、艦が来る側)へ50間隔で2000まで並べた点。
//      目的地の位置・姿勢が変わらない限り再構築不要な静的な列。
//   2) 予定航路マーカー: 艦が実際にこれから辿ろうとしている経路
//      （ThrusterSolverの通常フェーズと同じベジエ曲線＋仮想
//      ウェイポイント以降は進入軸に沿った直線）上を、艦の現在位置
//      からの弧長ベースで50間隔・2000まで並べた点。艦が動くたびに
//      毎フレーム再構築する（ベジエは艦の現在位置・向きに依存する
//      ため、静的にキャッシュできない）。
//
// State.dockingTarget が無い間は何も描画しない。表示/非表示は
// State.settings.showApproachGuides（06-hud.jsのトグルボタンで
// 切り替え、localStorageにも永続化）で制御する。
// =============================================================

const ApproachVisualizer = {
  MARKER_INTERVAL: 50,
  MARKER_RANGE: 2000,

  _axisGroup: null,
  _routeGroup: null,
  _axisKey: null, // 進入軸マーカーを再構築すべきか判定するための目的地シグネチャ

  init(scene) {
    this._scene = scene;
  },

  update() {
    const target = State.dockingTarget;
    const visible = State.settings.showApproachGuides !== false;

    if (!target || !visible) {
      this._clearAxis();
      this._clearRoute();
      return;
    }

    this._updateAxisMarkers(target);
    this._updateRouteMarkers(target);
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

  // -----------------------------------------------------------
  // 進入軸マーカー（静的）: 目的地の位置・姿勢が変わっていなければ
  // 再構築しない。DockingPlatform._buildGateMeshと同じ方針で、
  // 目的地のシグネチャ文字列を比較して無駄な再生成を避ける。
  // -----------------------------------------------------------
  _updateAxisMarkers(target) {
    const key = `${target.position.x},${target.position.y},${target.position.z},`
      + `${target.quaternion.x},${target.quaternion.y},${target.quaternion.z},${target.quaternion.w}`;
    if (this._axisGroup && this._axisKey === key) return;

    this._clearAxis();

    const approachAxisWorld = vecNormalize(
      rotateVecByQuat({ x: 0, y: 0, z: -1 }, target.quaternion)
    );

    const group = new THREE.Group();
    group.userData.isApproachAxisMarkers = true;

    const count = Math.floor(this.MARKER_RANGE / this.MARKER_INTERVAL);
    for (let i = 1; i <= count; i++) {
      const dist = i * this.MARKER_INTERVAL;
      const pos = {
        x: target.position.x - approachAxisWorld.x * dist,
        y: target.position.y - approachAxisWorld.y * dist,
        z: target.position.z - approachAxisWorld.z * dist,
      };
      group.add(this._buildAxisMarker(pos, dist));
    }

    this._scene.add(group);
    this._axisGroup = group;
    this._axisKey = key;
  },

  // 進入軸マーカー1個分: 小さな十字（艦から見やすいよう進入軸に
  // 垂直な平面上に置く）と、100区切りごとに距離ラベル用の色を変える
  _buildAxisMarker(pos, dist) {
    const isMajor = dist % 100 === 0;
    const color = isMajor ? 0x66aaff : 0x336688;
    const size = isMajor ? 3.2 : 1.8;
    const opacity = isMajor ? 0.65 : 0.35;

    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
    const marker = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 6), mat);
    marker.position.set(pos.x, pos.y, pos.z);
    return marker;
  },

  // -----------------------------------------------------------
  // 予定航路マーカー（動的）: 毎フレーム再構築。
  //
  // ThrusterSolverの通常フェーズと同じ考え方で経路を求める:
  //   - onApproachSideがfalse（艦が目的地の奥側にいる）間は経路を
  //     引かない（この状況はThrusterSolver側も目的地の方角への
  //     単純フォールバックに切り替わり、艦自身がベジエに沿わないため）。
  //   - 手前側にいる間は、仮想ウェイポイント（v39の距離クランプ込み）
  //     へ向かうベジエを構築し、その先（仮想ウェイポイントから
  //     target.positionまで）は進入軸に沿った直線として繋げる。
  //     ベジエ+直線の全長に沿って弧長ベースで50間隔にマーカーを打つ。
  // -----------------------------------------------------------
  _updateRouteMarkers(target) {
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

    const points = this._sampleRoutePoints(bezier, virtualTargetPos, approachAxisWorld, target.position);

    const group = new THREE.Group();
    group.userData.isRouteMarkers = true;
    for (const p of points) {
      group.add(this._buildRouteMarker(p.pos, p.dist));
    }

    this._scene.add(group);
    this._routeGroup = group;
  },

  // ベジエ(P0=艦位置 -> P3=仮想ウェイポイント)を弧長ベースで
  // MARKER_INTERVAL間隔にサンプリングし、曲線が尽きた後は
  // 仮想ウェイポイントからtarget.positionへの直線を進入軸方向に
  // 延長してMARKER_RANGEまで埋める。
  _sampleRoutePoints(bezier, virtualTargetPos, approachAxisWorld, realTargetPos) {
    const SEGMENTS = 48;
    const result = [];

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
          pos: {
            x: prev.x + (point.x - prev.x) * segT,
            y: prev.y + (point.y - prev.y) * segT,
            z: prev.z + (point.z - prev.z) * segT,
          },
          dist: nextMarkerAt,
        });
        nextMarkerAt += this.MARKER_INTERVAL;
      }

      accumulated += segLen;
      prev = point;
    }
    bezierLength = accumulated;

    // ベジエ終端（仮想ウェイポイント）以降、まだMARKER_RANGEに
    // 達していなければ進入軸に沿った直線（仮想ウェイポイント->
    // target.position、さらにその先も同じ方向）でマーカーを埋める。
    while (nextMarkerAt <= this.MARKER_RANGE) {
      const remain = nextMarkerAt - bezierLength;
      result.push({
        pos: {
          x: virtualTargetPos.x + approachAxisWorld.x * remain,
          y: virtualTargetPos.y + approachAxisWorld.y * remain,
          z: virtualTargetPos.z + approachAxisWorld.z * remain,
        },
        dist: nextMarkerAt,
      });
      nextMarkerAt += this.MARKER_INTERVAL;
    }

    return result;
  },

  // 航路マーカー1個分: 進入軸マーカーと区別できるよう暖色系にする
  _buildRouteMarker(pos, dist) {
    const isMajor = dist % 100 === 0;
    const color = isMajor ? 0xffaa33 : 0xaa7733;
    const size = isMajor ? 3.0 : 1.6;
    const opacity = isMajor ? 0.7 : 0.4;

    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
    const marker = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 6), mat);
    marker.position.set(pos.x, pos.y, pos.z);
    return marker;
  },

  _disposeGroup(group) {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  },
};
