// =============================================================
// 10-docking-platform.js
// 入港目的地の可視化：四角柱型のアプローチゲート
//
// State.dockingTarget（position + quaternion）に艦がその向きで
// 突入できるよう、四角柱（枠のみ・中空）のゲートをその場に表示する。
// 目的地の姿勢(quaternion)が定める「艦が向くべき-Z方向」を
// ゲートの手前(入口)→奥(出口)方向として揃えるので、ゲートの傾き＝
// 進入すべき角度が一目でわかる。
//
// 前後判別:
//   入口側（艦がここから入ってくる側、目的地から見て+Z側＝艦の
//   後方寄り）を緑のリングと外向き矢印、
//   出口側（目的地位置そのもの、艦が最終的に収まる側、-Z寄り）を
//   赤のリングと停止バーで表現する。
//   さらに四隅の柱を薄く繋いで「四角柱」の箱として認識できるようにする。
//
// 戦艦級（幅24 x 高さ18 x 全長140、01-state-and-config.js参照）が
// 余裕を持って収まるよう、内寸は幅・高さともに戦艦級の外形+マージン。
//
// v40: State.settings.showApproachGuides（06-hud.jsのトグルボタン）が
// falseの間は、進入軸・予定航路マーカー（11-approach-visualizer.js）
// と合わせてこのゲートも非表示にする。
// =============================================================

const DockingPlatform = {
  _group: null,
  _hasTargetKey: null, // 直近に描画した目的地のシグネチャ（無駄な再構築を避ける）

  // ゲートの内寸・奥行き（艦種を問わず戦艦級が余裕で通る固定サイズ）
  GATE_WIDTH: 34, // 戦艦級全幅24に対しマージン
  GATE_HEIGHT: 26, // 戦艦級全高18に対しマージン
  GATE_DEPTH: 40, // 入口〜出口の奥行き（四角柱の長さ）

  init(scene) {
    this._scene = scene;
  },

  update() {
    const target = State.dockingTarget;
    // v40: 進入軸・予定航路マーカー（ApproachVisualizer）と表示状態を
    // 統一する。State.settings.showApproachGuidesがfalseの間は
    // 目的地ゲートも含めて誘導表示を一括で隠す（06-hud.jsの
    // トグルボタン参照）。
    const visible = State.settings.showApproachGuides !== false;

    if (!target || !visible) {
      if (this._group) {
        this._scene.remove(this._group);
        this._disposeGroup(this._group);
        this._group = null;
        this._hasTargetKey = null;
      }
      return;
    }

    if (!this._group) {
      this._group = this._buildGateMesh();
      this._scene.add(this._group);
    }

    this._group.position.set(target.position.x, target.position.y, target.position.z);
    this._group.quaternion.set(
      target.quaternion.x,
      target.quaternion.y,
      target.quaternion.z,
      target.quaternion.w
    );
  },

  _buildGateMesh() {
    const group = new THREE.Group();
    group.userData.isDockingPlatform = true;

    const hw = this.GATE_WIDTH / 2;
    const hh = this.GATE_HEIGHT / 2;
    const depth = this.GATE_DEPTH;
    const halfDepth = depth / 2;

    const entryColor = 0x33ff66;
    const exitColor = 0xff4433;
    const railColor = 0x66aaff;

    const corners = [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ];
    const railMat = new THREE.LineBasicMaterial({ color: railColor, transparent: true, opacity: 0.55 });
    for (const c of corners) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(c.x, c.y, halfDepth),
        new THREE.Vector3(c.x, c.y, -halfDepth),
      ]);
      group.add(new THREE.Line(geo, railMat));
    }

    group.add(this._buildRing(hw, hh, halfDepth, entryColor));
    group.add(this._buildRing(hw, hh, -halfDepth, exitColor));

    const entryArrow = new THREE.Mesh(
      new THREE.ConeGeometry(2.2, 6, 12),
      new THREE.MeshBasicMaterial({ color: entryColor, transparent: true, opacity: 0.85 })
    );
    entryArrow.rotation.x = -Math.PI / 2;
    entryArrow.position.set(0, 0, halfDepth + 6);
    group.add(entryArrow);

    const exitBar = new THREE.Mesh(
      new THREE.BoxGeometry(this.GATE_WIDTH * 0.7, 0.6, 0.6),
      new THREE.MeshBasicMaterial({ color: exitColor, transparent: true, opacity: 0.9 })
    );
    exitBar.position.set(0, -hh + 1.5, -halfDepth);
    group.add(exitBar);

    const crossMat = new THREE.LineBasicMaterial({ color: exitColor, transparent: true, opacity: 0.9 });
    const crossSize = 3;
    const crossGeoH = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-crossSize, 0, -halfDepth),
      new THREE.Vector3(crossSize, 0, -halfDepth),
    ]);
    const crossGeoV = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -crossSize, -halfDepth),
      new THREE.Vector3(0, crossSize, -halfDepth),
    ]);
    group.add(new THREE.Line(crossGeoH, crossMat));
    group.add(new THREE.Line(crossGeoV, crossMat));

    const panelMat = new THREE.MeshBasicMaterial({
      color: railColor,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const entryPanel = new THREE.Mesh(new THREE.PlaneGeometry(this.GATE_WIDTH, this.GATE_HEIGHT), panelMat);
    entryPanel.position.set(0, 0, halfDepth);
    group.add(entryPanel);
    const exitPanel = new THREE.Mesh(new THREE.PlaneGeometry(this.GATE_WIDTH, this.GATE_HEIGHT), panelMat.clone());
    exitPanel.position.set(0, 0, -halfDepth);
    group.add(exitPanel);

    return group;
  },

  _buildRing(hw, hh, z, color) {
    const pts = [
      new THREE.Vector3(-hw, -hh, z),
      new THREE.Vector3(hw, -hh, z),
      new THREE.Vector3(hw, hh, z),
      new THREE.Vector3(-hw, hh, z),
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const ring = new THREE.LineLoop(geo, mat);
    return ring;
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
