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
//
// v63: port-builder.htmlでポートごとにGLB/OBJのカスタム3Dモデルを
// 保存できるようになったため、現在アクティブな目的地(State.dockingTarget)
// が保存済みポート一覧のどれかと位置・姿勢が一致する場合、そのポートの
// モデル（loadPortModelData、01-state-and-config.js）をゲートの中に
// 重ねて表示する。一致するポートが無い場合（HUDでその場保存・座標
// 直接入力した目的地等）や、一致してもモデル未設定の場合は、従来通り
// 簡易ゲート表示のみ。
// =============================================================

const DockingPlatform = {
  _group: null,
  _hasTargetKey: null, // 直近に描画した目的地のシグネチャ（無駄な再構築を避ける）
  _modelRoot: null,        // 読み込んだカスタムポートモデル（あれば）
  _modelCorrectionGroup: null,
  _modelLoadedForPortId: null, // 直近読み込みを試みたポートID（重複読み込み防止）

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
      this._modelLoadedForPortId = null;
      return;
    }

    if (!this._group) {
      this._group = this._buildGateMesh();
      this._scene.add(this._group);
      this._modelCorrectionGroup = new THREE.Group();
      this._group.add(this._modelCorrectionGroup);
    }

    this._group.position.set(target.position.x, target.position.y, target.position.z);
    this._group.quaternion.set(
      target.quaternion.x,
      target.quaternion.y,
      target.quaternion.z,
      target.quaternion.w
    );

    this._syncPortModel(target);
  },

  // 現在の目的地(target)が保存済みポート一覧のどれかと一致するか調べ、
  // 一致すればそのポートのカスタムモデルを（未読み込みなら）読み込んで
  // 表示する。ポートが切り替わった場合は前のモデルを破棄する。
  _syncPortModel(target) {
    if (typeof loadDockingPorts !== 'function' || typeof loadPortModelData !== 'function') return;

    const matchedPort = this._findMatchingPort(target);
    const matchedId = matchedPort ? matchedPort.id : null;

    if (matchedId === this._modelLoadedForPortId) return; // 変化なし

    // ポートが変わった（または目的地に紐づくポートが無くなった）ので
    // 表示中のモデルを一旦破棄する
    this._clearPortModel();
    this._modelLoadedForPortId = matchedId;

    if (!matchedId) return; // 一致するポートが無い＝簡易ゲート表示のみ

    loadPortModelData(matchedId)
      .then((saved) => {
        // 読み込み完了までの間にさらに目的地が切り替わっていた場合は
        // 結果を捨てる（IDが一致する場合のみ反映）
        if (this._modelLoadedForPortId !== matchedId) return;
        if (!saved) return;
        this._loadModelIntoGroup(saved);
      })
      .catch((err) => {
        console.warn(`ポートモデル(${matchedId})の読み込みに失敗しました。簡易ゲート表示のままにします。`, err);
      });
  },

  _findMatchingPort(target) {
    const ports = loadDockingPorts();
    const eps = 1e-6;
    return ports.find((p) =>
      Math.abs(p.position.x - target.position.x) < eps &&
      Math.abs(p.position.y - target.position.y) < eps &&
      Math.abs(p.position.z - target.position.z) < eps &&
      Math.abs(p.quaternion.x - target.quaternion.x) < eps &&
      Math.abs(p.quaternion.y - target.quaternion.y) < eps &&
      Math.abs(p.quaternion.z - target.quaternion.z) < eps &&
      Math.abs(p.quaternion.w - target.quaternion.w) < eps
    ) || null;
  },

  _loadModelIntoGroup(saved) {
    if (!this._modelCorrectionGroup) return;
    const missingLibs = ['GLTFLoader', 'OBJLoader', 'MTLLoader'].filter(
      (name) => typeof THREE === 'undefined' || typeof THREE[name] !== 'function'
    );
    if (missingLibs.length > 0) {
      console.warn(`ポートモデルの表示に必要なライブラリが読み込まれていません（${missingLibs.join('、')}）。簡易ゲート表示のままにします。`);
      return;
    }

    const applyAdjust = (obj) => {
      const toRad = (d) => (d * Math.PI) / 180;
      obj.rotation.set(
        toRad(saved.adjust.rotationDeg.x),
        toRad(saved.adjust.rotationDeg.y),
        toRad(saved.adjust.rotationDeg.z)
      );
      obj.scale.setScalar(saved.adjust.scale);
      obj.position.set(saved.adjust.offset.x, saved.adjust.offset.y, saved.adjust.offset.z);
    };

    const onLoaded = (loadedObject) => {
      if (!this._modelCorrectionGroup) return; // 読み込み完了前にゲート自体が消えた場合
      this._modelRoot = loadedObject;
      this._modelCorrectionGroup.add(loadedObject);
      applyAdjust(this._modelCorrectionGroup);
    };

    if (saved.format === 'glb') {
      // v67: fetch(dataUrl)はiPad(iOS WebKit)で巨大なdata URLの読み込みに
      // 失敗することがあったため、atob直接デコード(dataUrlToArrayBuffer、
      // 01-state-and-config.js)に変更。
      try {
        const buf = dataUrlToArrayBuffer(saved.glbDataUrl);
        const manager = new THREE.LoadingManager();
        const loader = new THREE.GLTFLoader(manager);
        loader.textureLoader = new THREE.TextureLoader(manager);
        loader.parse(buf, '', (gltf) => onLoaded(gltf.scene), (err) => {
          console.warn('ポートモデル(GLB)の読み込みに失敗しました。簡易ゲート表示のままにします。', err);
        });
      } catch (err) {
        console.warn('ポートモデル(GLB)の読み込みに失敗しました。簡易ゲート表示のままにします。', err);
      }
    } else if (saved.format === 'obj') {
      const finish = (materials) => {
        const objLoader = new THREE.OBJLoader();
        if (materials) {
          materials.preload();
          objLoader.setMaterials(materials);
        }
        try {
          const objGroup = objLoader.parse(saved.objText);
          onLoaded(objGroup);
        } catch (err) {
          console.warn('ポートモデル(OBJ)の読み込みに失敗しました。簡易ゲート表示のままにします。', err);
        }
      };

      if (!saved.mtlText) {
        finish(null);
      } else {
        const texMap = saved.textures || {};
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
          const baseName = url.split('/').pop().split('\\').pop();
          return texMap[baseName] || url;
        });
        const mtlLoader = new THREE.MTLLoader(manager);
        const materials = mtlLoader.parse(saved.mtlText, '');
        finish(materials);
      }
    }
  },

  _clearPortModel() {
    if (this._modelRoot && this._modelCorrectionGroup) {
      this._modelCorrectionGroup.remove(this._modelRoot);
      this._disposeGroup(this._modelRoot);
    }
    this._modelRoot = null;
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
