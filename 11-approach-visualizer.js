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
  // v46: ThrusterSolverの自動ドッキングがベジエ主体の単一ロジック
  // から、明示的なフェーズ（ship._dockingPhase）のステートマシンに
  // 再設計されたのに合わせ、可視化側もフェーズごとの「今まさに
  // 艦が目指している点」を単純な折れ線でつなぐ方式に変更した。
  //   - cruise/approach/adjust: 艦の現在位置 → 仕想WP（迂回点経由の
  //     場合は迂回点も経由）→ target.position の折れ線
  //   - brake300/brake250: 前後には進まないフェーズなので、艦の
  //     現在位置から進入軸への垂線の足（＝軸上の同じdistanceの点）
  //     → target.position
  //   - final_approach: 艦の現在位置 → target.position の直線
  //   - tunnel/overshoot: 艦の現在位置から進入軸に沿った直線
  //     （tunnelは目的地方向、overshootは奥側へ抜ける方向）
  //   - docked: 経路なし
  // いずれも「進入軸沿いの直線部分」はtarget.positionを越えて
  // MARKER_RANGEまで延長する（_extendAlongAxis参照）。
  // -----------------------------------------------------------
  _updateRoute(target) {
    this._clearRoute();

    const ship = State.ship;
    if (!ship || !ship.autoDockingEnabled) return;

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

    const phase = ship._dockingPhase || 'cruise';
    let points = null;

    switch (phase) {
      case 'cruise':
      case 'approach':
      case 'adjust': {
        const params = ThrusterSolver._getDockingParams(target);
        const lateralVec = {
          x: toTargetWorld.x - approachAxisWorld.x * vecDot(toTargetWorld, approachAxisWorld),
          y: toTargetWorld.y - approachAxisWorld.y * vecDot(toTargetWorld, approachAxisWorld),
          z: toTargetWorld.z - approachAxisWorld.z * vecDot(toTargetWorld, approachAxisWorld),
        };
        const lateral = vecLength(lateralVec);

        // v46: _computeAvoidanceWaypointは進入軸上の固定中間地点を
        // 返すだけになった（ThrusterSolver._runApproachPhase参照）。
        // 経由させるかどうかの判定も同じロジックをここで再現する:
        // 艦がまだその固定地点よりtargetから遠い側にいる間だけ経由。
        const shipAlong = -vecDot(
          { x: ship.position.x - target.position.x, y: ship.position.y - target.position.y, z: ship.position.z - target.position.z },
          approachAxisWorld
        );
        const avoidanceAlong = params.VIRTUAL_WAYPOINT_OFFSET + params.AVOIDANCE_RADIUS;
        const needsAvoidance =
          phase !== 'cruise' && lateral > 1e-3 && shipAlong > avoidanceAlong + 1e-3;

        const virtualWP = ThrusterSolver._computeVirtualWaypoint(target, approachAxisWorld, distance, params);
        const waypoints = [{ x: ship.position.x, y: ship.position.y, z: ship.position.z }];
        if (needsAvoidance) {
          waypoints.push(ThrusterSolver._computeAvoidanceWaypoint(ship, target, approachAxisWorld, params));
        }
        waypoints.push(virtualWP);
        points = waypoints;
        points = points.concat(this._extendAlongAxis(virtualWP, approachAxisWorld, -1));
        break;
      }
      case 'return_to_axis': {
        // ThrusterSolver._runReturnToAxisPhaseと同じく、進入軸上の
        // 固定中間地点をそのまま経由先とする。
        const params = ThrusterSolver._getDockingParams(target);
        const returnTarget = ThrusterSolver._computeAvoidanceWaypoint(ship, target, approachAxisWorld, params);
        points = [
          { x: ship.position.x, y: ship.position.y, z: ship.position.z },
          returnTarget,
        ];
        points = points.concat(this._extendAlongAxis(returnTarget, approachAxisWorld, -1));
        break;
      }
      case 'brake300':
      case 'brake250': {
        const alongDist = vecDot(toTargetWorld, approachAxisWorld);
        const axisPointAtSameDistance = {
          x: target.position.x - approachAxisWorld.x * alongDist,
          y: target.position.y - approachAxisWorld.y * alongDist,
          z: target.position.z - approachAxisWorld.z * alongDist,
        };
        points = [
          { x: ship.position.x, y: ship.position.y, z: ship.position.z },
          axisPointAtSameDistance,
          { x: target.position.x, y: target.position.y, z: target.position.z },
        ];
        points = points.concat(this._extendAlongAxis(target.position, approachAxisWorld, -1));
        break;
      }
      case 'final_approach': {
        points = [
          { x: ship.position.x, y: ship.position.y, z: ship.position.z },
          { x: target.position.x, y: target.position.y, z: target.position.z },
        ];
        points = points.concat(this._extendAlongAxis(target.position, approachAxisWorld, -1));
        break;
      }
      case 'tunnel': {
        points = [{ x: ship.position.x, y: ship.position.y, z: ship.position.z }]
          .concat(this._extendAlongAxis(ship.position, approachAxisWorld, -1));
        break;
      }
      case 'overshoot': {
        // 奥側へ抜けていく方向は、tunnelと同じ進入軸マイナス方向
        // （target側へ向かい、さらに通り抜けた先へ進み続ける）。
        // approachAxisWorldは「target→艦が来る側(手前側)」を向く
        // ベクトルなので、奥へ進む向きは-approachAxisWorld＝dirSign=-1。
        points = [{ x: ship.position.x, y: ship.position.y, z: ship.position.z }]
          .concat(this._extendAlongAxis(ship.position, approachAxisWorld, -1));
        break;
      }
      case 'docked':
      default:
        return;
    }

    if (!points || points.length < 2) return;

    const geo = new THREE.BufferGeometry().setFromPoints(
      points.map((p) => new THREE.Vector3(p.x, p.y, p.z))
    );
    const mat = new THREE.LineBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.7 });
    const line = new THREE.Line(geo, mat);
    line.userData.isRouteLine = true;

    this._scene.add(line);
    this._routeGroup = line;
  },

  // fromPointから進入軸に沿ってMARKER_RANGE分だけ延長した終点を
  // 1点だけ返す（線分は始点fromPointと合わせて呼び出し側で作る）。
  // approachAxisWorldは「target→艦が来る側(手前側)」を向く単位
  // ベクトルなので、dirSign=-1でtarget方向（さらにその先の出口
  // 側）、dirSign=+1でその逆（艦の背後）へ延長する。tunnel/
  // overshootはどちらもtarget方向へ向かい続ける動きのため-1を渡す
  // （cruise/approach/adjust/brake系のtarget方向延長と同じ向き）。
  _extendAlongAxis(fromPoint, approachAxisWorld, dirSign) {
    return [{
      x: fromPoint.x + approachAxisWorld.x * this.MARKER_RANGE * dirSign,
      y: fromPoint.y + approachAxisWorld.y * this.MARKER_RANGE * dirSign,
      z: fromPoint.z + approachAxisWorld.z * this.MARKER_RANGE * dirSign,
    }];
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
