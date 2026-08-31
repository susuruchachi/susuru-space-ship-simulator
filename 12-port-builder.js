// =============================================================
// 12-port-builder.js
// ドッキングポート設定画面（port-builder.html）専用スクリプト
//
// できること（v63スコープ）:
//   - 保存済みドッキングポート（名前+位置+姿勢）の一覧表示
//   - 新規作成・編集・削除
//   - 3Dプレビュー（10-docking-platform.jsのゲートメッシュ生成ロジックを
//     そのまま再利用。オービットカメラでドラッグ回転・ホイールズーム）
//   - 一覧から1つを選んで「使用するポートに設定」すると、
//     State.dockingTarget / saveDockingTarget（01-state-and-config.js、
//     ゲーム内オートドッキングが直接参照する既存の単一アクティブ値）
//     へ反映する
//   - v63: ポートごとにGLB、またはOBJ+MTL(+テクスチャ)の3Dモデルを
//     読み込み・保存・削除・差し替え（09-ship-builder.jsの艦モデル読込と
//     同じUI・保存方式。IndexedDB、キーはportId）。読み込んだモデルの
//     向き(X/Y/Z回転)・スケール・位置オフセットもここで調整できる。
//     モデル未設定のポートは従来通り簡易ゲート表示のみ。
//
// 保存形式・関数（loadDockingPorts/saveDockingPorts/generateDockingPortId、
// loadDockingTarget/saveDockingTarget）はすべて01-state-and-config.js側に
// 定義済み（詳細はそちらのコメント参照）。ポートモデルの保存関数
// （loadPortModelData/savePortModelData/removePortModelData）も同ファイル
// 末尾に定義済み。
//
// ゲート形状は10-docking-platform.jsの DockingPlatform._buildGateMesh() を
// そのまま呼び出して再利用している。ゲームプレイ中に表示される実際の
// ゲートと見た目を常に一致させるため、独自に複製せずロジックを共有する。
// カスタムモデルが保存されているポートについては、ゲームプレイ中は
// 10-docking-platform.js側がloadPortModelDataでモデルを読み込み、
// ゲートに重ねて（または将来的に差し替えて）表示する。
// =============================================================

(function () {
  const versionLineEl = document.getElementById('buildVersionLine');
  if (versionLineEl) versionLineEl.textContent = `build: ${GAME_VERSION}`;

  // -----------------------------------------------------------
  // DOM参照
  // -----------------------------------------------------------
  const listWrap = document.getElementById('listWrap');
  const editorWrap = document.getElementById('editorWrap');
  const portList = document.getElementById('portList');
  const portEmptyState = document.getElementById('portEmptyState');
  const addPortBtn = document.getElementById('addPortBtn');
  const topbarTitle = document.getElementById('topbarTitle');

  const canvas = document.getElementById('viewportCanvas');
  const portNameInput = document.getElementById('portNameInput');
  const deletePortBtn = document.getElementById('deletePortBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const savePortBtn = document.getElementById('savePortBtn');

  const posX = document.getElementById('posX');
  const posY = document.getElementById('posY');
  const posZ = document.getElementById('posZ');
  const posXNum = document.getElementById('posXNum');
  const posYNum = document.getElementById('posYNum');
  const posZNum = document.getElementById('posZNum');

  const rotPitch = document.getElementById('rotPitch');
  const rotYaw = document.getElementById('rotYaw');
  const rotRoll = document.getElementById('rotRoll');
  const rotPitchNum = document.getElementById('rotPitchNum');
  const rotYawNum = document.getElementById('rotYawNum');
  const rotRollNum = document.getElementById('rotRollNum');

  // ---- ポート3Dモデル読み込みUI ----
  const missingLibs = ['GLTFLoader', 'OBJLoader', 'MTLLoader'].filter(
    (name) => typeof THREE === 'undefined' || typeof THREE[name] !== 'function'
  );

  const modelEmptyState = document.getElementById('modelEmptyState');
  const modelAdjustSection = document.getElementById('modelAdjustSection');
  const modelStatusLine = document.getElementById('modelStatusLine');
  const loadModelBtn = document.getElementById('loadModelBtn');

  const tabGlb = document.getElementById('tabGlb');
  const tabObj = document.getElementById('tabObj');
  const glbSlots = document.getElementById('glbSlots');
  const objSlots = document.getElementById('objSlots');

  const glbFileInput = document.getElementById('glbFileInput');
  const objFileInput = document.getElementById('objFileInput');
  const mtlFileInput = document.getElementById('mtlFileInput');
  const texFileInput = document.getElementById('texFileInput');

  const glbFileName = document.getElementById('glbFileName');
  const objFileName = document.getElementById('objFileName');
  const mtlFileName = document.getElementById('mtlFileName');
  const texFileName = document.getElementById('texFileName');

  const modelRotX = document.getElementById('modelRotX');
  const modelRotY = document.getElementById('modelRotY');
  const modelRotZ = document.getElementById('modelRotZ');
  const modelRotXVal = document.getElementById('modelRotXVal');
  const modelRotYVal = document.getElementById('modelRotYVal');
  const modelRotZVal = document.getElementById('modelRotZVal');

  const modelScaleSlider = document.getElementById('modelScaleSlider');
  const modelScaleVal = document.getElementById('modelScaleVal');

  const modelOffX = document.getElementById('modelOffX');
  const modelOffY = document.getElementById('modelOffY');
  const modelOffZ = document.getElementById('modelOffZ');
  const modelOffXVal = document.getElementById('modelOffXVal');
  const modelOffYVal = document.getElementById('modelOffYVal');
  const modelOffZVal = document.getElementById('modelOffZVal');

  const modelResetAdjustBtn = document.getElementById('modelResetAdjustBtn');
  const modelReplaceBtn = document.getElementById('modelReplaceBtn');
  const modelRemoveBtn = document.getElementById('modelRemoveBtn');

  if (missingLibs.length > 0) {
    setModelStatus(
      `モデル読み込み機能の準備に失敗しました（${missingLibs.join('、')}が読み込めていません）。通信状況を確認して再読み込みしてください。`,
      true
    );
    loadModelBtn.disabled = true;
  }

  function setModelStatus(msg, isError) {
    modelStatusLine.textContent = msg || '';
    modelStatusLine.classList.toggle('error', !!isError);
  }

  // -----------------------------------------------------------
  // 状態: 保存済みポート一覧 + 現在アクティブな目的地のID
  //
  // 「アクティブな目的地のID」はポート一覧側には保存しない
  // （DOCKING_TARGET_STORAGE_KEYと座標が一致するかどうかで毎回
  // 判定する）。一覧側にactiveIdを持たせると、HUD側でその場保存・
  // 座標直接入力された場合に一覧側の情報が古くなり、一致しなくなる
  // ため、常にDOCKING_TARGET_STORAGE_KEYの実際の値を正とする。
  // -----------------------------------------------------------
  let ports = loadDockingPorts();
  let editingPortId = null; // null = 新規作成中

  function isSamePose(a, b) {
    if (!a || !b) return false;
    const eps = 1e-6;
    return (
      Math.abs(a.position.x - b.position.x) < eps &&
      Math.abs(a.position.y - b.position.y) < eps &&
      Math.abs(a.position.z - b.position.z) < eps &&
      Math.abs(a.quaternion.x - b.quaternion.x) < eps &&
      Math.abs(a.quaternion.y - b.quaternion.y) < eps &&
      Math.abs(a.quaternion.z - b.quaternion.z) < eps &&
      Math.abs(a.quaternion.w - b.quaternion.w) < eps
    );
  }

  function findActivePortId() {
    const active = loadDockingTarget();
    if (!active) return null;
    const match = ports.find((p) => isSamePose(p, active));
    return match ? match.id : null;
  }

  // -----------------------------------------------------------
  // 一覧画面の描画
  // -----------------------------------------------------------
  function renderList() {
    const activeId = findActivePortId();
    portList.innerHTML = '';
    portEmptyState.classList.toggle('hidden', ports.length > 0);

    for (const port of ports) {
      const isActive = port.id === activeId;
      const card = document.createElement('div');
      card.className = 'port-card' + (isActive ? ' active' : '');

      const info = document.createElement('div');
      info.className = 'info';
      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = port.name || '(名前未設定)';
      const coordsEl = document.createElement('div');
      coordsEl.className = 'coords';
      coordsEl.textContent = `X:${port.position.x.toFixed(0)} Y:${port.position.y.toFixed(0)} Z:${port.position.z.toFixed(0)}`;
      info.appendChild(nameEl);
      info.appendChild(coordsEl);
      if (isActive) {
        const badge = document.createElement('div');
        badge.className = 'active-badge';
        badge.textContent = '使用中';
        info.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';

      const useBtn = document.createElement('button');
      useBtn.className = 'btn-use';
      useBtn.type = 'button';
      useBtn.textContent = isActive ? '使用中' : 'このポートを使う';
      useBtn.disabled = isActive;
      useBtn.addEventListener('click', () => {
        State.dockingTarget = { position: { ...port.position }, quaternion: { ...port.quaternion } };
        saveDockingTarget(State.dockingTarget);
        renderList();
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => openEditor(port.id));

      actions.appendChild(useBtn);
      actions.appendChild(editBtn);

      card.appendChild(info);
      card.appendChild(actions);
      portList.appendChild(card);
    }
  }

  addPortBtn.addEventListener('click', () => openEditor(null));

  // -----------------------------------------------------------
  // 編集画面の状態
  // -----------------------------------------------------------
  const editState = {
    name: '',
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { pitch: 0, yaw: 0, roll: 0 },
  };

  // -----------------------------------------------------------
  // ポートモデル読み込みUIの状態（09-ship-builder.jsと同じ構造）
  // -----------------------------------------------------------
  let activeFormat = 'glb';
  let pendingGlbFile = null;
  let pendingObjFile = null;
  let pendingMtlFile = null;
  let pendingTexFiles = [];

  function refreshLoadButtonEnabled() {
    if (missingLibs.length > 0) return;
    if (activeFormat === 'glb') {
      loadModelBtn.disabled = !pendingGlbFile;
    } else {
      loadModelBtn.disabled = !pendingObjFile;
    }
  }

  function selectFormatTab(fmt) {
    activeFormat = fmt;
    tabGlb.classList.toggle('selected', fmt === 'glb');
    tabObj.classList.toggle('selected', fmt === 'obj');
    glbSlots.style.display = fmt === 'glb' ? '' : 'none';
    objSlots.style.display = fmt === 'obj' ? '' : 'none';
    refreshLoadButtonEnabled();
  }
  tabGlb.addEventListener('click', () => selectFormatTab('glb'));
  tabObj.addEventListener('click', () => selectFormatTab('obj'));

  document.getElementById('pickGlbBtn').addEventListener('click', () => glbFileInput.click());
  document.getElementById('pickObjBtn').addEventListener('click', () => objFileInput.click());
  document.getElementById('pickMtlBtn').addEventListener('click', () => mtlFileInput.click());
  document.getElementById('pickTexBtn').addEventListener('click', () => texFileInput.click());

  glbFileInput.addEventListener('change', () => {
    const f = glbFileInput.files[0];
    if (!f) return;
    pendingGlbFile = f;
    glbFileName.textContent = f.name;
    refreshLoadButtonEnabled();
  });
  objFileInput.addEventListener('change', () => {
    const f = objFileInput.files[0];
    if (!f) return;
    pendingObjFile = f;
    objFileName.textContent = f.name;
    refreshLoadButtonEnabled();
  });
  mtlFileInput.addEventListener('change', () => {
    const f = mtlFileInput.files[0];
    if (!f) return;
    pendingMtlFile = f;
    mtlFileName.textContent = f.name;
  });
  texFileInput.addEventListener('change', () => {
    pendingTexFiles = Array.from(texFileInput.files || []);
    texFileName.textContent = pendingTexFiles.length > 0
      ? `${pendingTexFiles.length}個選択`
      : '0個選択';
  });

  // ドラッグ&ドロップ（拡張子で自動判別してタブごと切り替える）
  const modelDropzoneEl = modelEmptyState;
  ['dragenter', 'dragover'].forEach((evt) => {
    modelDropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      modelDropzoneEl.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    modelDropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      modelDropzoneEl.classList.remove('dragover');
    });
  });
  modelDropzoneEl.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const glb = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
    const obj = files.find((f) => /\.obj$/i.test(f.name));
    const mtl = files.find((f) => /\.mtl$/i.test(f.name));
    const textures = files.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f.name));

    if (glb) {
      selectFormatTab('glb');
      pendingGlbFile = glb;
      glbFileName.textContent = glb.name;
    }
    if (obj) {
      selectFormatTab('obj');
      pendingObjFile = obj;
      objFileName.textContent = obj.name;
    }
    if (mtl) {
      pendingMtlFile = mtl;
      mtlFileName.textContent = mtl.name;
    }
    if (textures.length > 0) {
      pendingTexFiles = textures;
      texFileName.textContent = `${textures.length}個選択`;
    }
    refreshLoadButtonEnabled();
  });

  function openEditor(portId) {
    editingPortId = portId;
    if (portId) {
      const port = ports.find((p) => p.id === portId);
      const euler = quatToEulerDegrees(port.quaternion);
      editState.name = port.name || '';
      editState.position = { ...port.position };
      editState.rotationDeg = { pitch: euler.pitch, yaw: euler.yaw, roll: euler.roll };
      topbarTitle.textContent = 'ポートを編集';
      deletePortBtn.style.display = '';
    } else {
      // 新規作成: 原点付近、既存のゲート表示規約（艦が-Z方向を向いて
      // 進入する）に合わせた無回転を初期値にする
      editState.name = `ポート${ports.length + 1}`;
      editState.position = { x: 0, y: 0, z: 0 };
      editState.rotationDeg = { pitch: 0, yaw: 0, roll: 0 };
      topbarTitle.textContent = '新しいポート';
      deletePortBtn.style.display = 'none';
    }
    syncEditorUiFromState();
    listWrap.classList.add('hidden');
    editorWrap.classList.remove('hidden');
    ensureSceneInited();
    updateGateFromEditState();

    // v63: ポート用モデルの読込UIを、フォーマットタブ含め毎回初期状態
    // （GLBタブ、未選択）に戻してから、保存済みがあれば復元する。
    // これをしないと前回編集したポートがOBJだった場合などに紛らわしい
    // 状態を引き継いでしまう。
    pendingGlbFile = null;
    pendingObjFile = null;
    pendingMtlFile = null;
    pendingTexFiles = [];
    glbFileName.textContent = '未選択';
    objFileName.textContent = '未選択';
    mtlFileName.textContent = '未選択';
    texFileName.textContent = '0個選択';
    selectFormatTab('glb');
    restoreExistingPortModel(portId);
  }

  function closeEditor() {
    editingPortId = null;
    editorWrap.classList.add('hidden');
    listWrap.classList.remove('hidden');
    topbarTitle.textContent = 'ドッキングポート設定';
    renderList();
  }

  cancelEditBtn.addEventListener('click', closeEditor);

  savePortBtn.addEventListener('click', () => {
    const now = Date.now();
    const quaternion = eulerToQuatSmall(
      (editState.rotationDeg.pitch * Math.PI) / 180,
      (editState.rotationDeg.yaw * Math.PI) / 180,
      (editState.rotationDeg.roll * Math.PI) / 180
    );
    const name = portNameInput.value.trim() || '(名前未設定)';

    if (editingPortId) {
      const port = ports.find((p) => p.id === editingPortId);
      const wasActive = findActivePortId() === editingPortId;
      port.name = name;
      port.position = { ...editState.position };
      port.quaternion = quaternion;
      port.updatedAt = now;
      // 編集中のポートが現在アクティブな目的地だった場合、アクティブ値
      // 側も追従させないと「使用中のまま古い位置が使われ続ける」ズレが
      // 生じるため、あわせて更新する。
      if (wasActive) {
        State.dockingTarget = { position: { ...port.position }, quaternion: { ...port.quaternion } };
        saveDockingTarget(State.dockingTarget);
      }
    } else {
      ports.push({
        id: generateDockingPortId(),
        name,
        position: { ...editState.position },
        quaternion,
        createdAt: now,
        updatedAt: now,
      });
    }
    saveDockingPorts(ports);
    closeEditor();
  });

  deletePortBtn.addEventListener('click', () => {
    if (!editingPortId) return;
    ports = ports.filter((p) => p.id !== editingPortId);
    saveDockingPorts(ports);
    closeEditor();
  });

  // -----------------------------------------------------------
  // 編集フォームのUI同期
  // -----------------------------------------------------------
  function syncEditorUiFromState() {
    portNameInput.value = editState.name;

    posX.value = editState.position.x; posXNum.value = editState.position.x;
    posY.value = editState.position.y; posYNum.value = editState.position.y;
    posZ.value = editState.position.z; posZNum.value = editState.position.z;

    rotPitch.value = editState.rotationDeg.pitch; rotPitchNum.value = Math.round(editState.rotationDeg.pitch);
    rotYaw.value = editState.rotationDeg.yaw; rotYawNum.value = Math.round(editState.rotationDeg.yaw);
    rotRoll.value = editState.rotationDeg.roll; rotRollNum.value = Math.round(editState.rotationDeg.roll);
  }

  // range/numberの両入力を1本の値に束ねる共通ヘルパー。
  // rangeはスライダーでのざっくり調整、numberは数値を直接叩き込みたい
  // ケース（座標を厳密に合わせたい等）向けに両方用意している。
  function bindAxisInputs(rangeEl, numEl, getter, setter, decimals) {
    const onChange = (value) => {
      setter(value);
      rangeEl.value = value;
      numEl.value = decimals === 0 ? Math.round(value) : value.toFixed(decimals);
      updateGateFromEditState();
    };
    rangeEl.addEventListener('input', () => onChange(Number(rangeEl.value)));
    numEl.addEventListener('input', () => {
      const v = Number(numEl.value);
      if (Number.isFinite(v)) onChange(v);
    });
  }

  bindAxisInputs(posX, posXNum, () => editState.position.x, (v) => { editState.position.x = v; }, 1);
  bindAxisInputs(posY, posYNum, () => editState.position.y, (v) => { editState.position.y = v; }, 1);
  bindAxisInputs(posZ, posZNum, () => editState.position.z, (v) => { editState.position.z = v; }, 1);

  bindAxisInputs(rotPitch, rotPitchNum, () => editState.rotationDeg.pitch, (v) => { editState.rotationDeg.pitch = v; }, 0);
  bindAxisInputs(rotYaw, rotYawNum, () => editState.rotationDeg.yaw, (v) => { editState.rotationDeg.yaw = v; }, 0);
  bindAxisInputs(rotRoll, rotRollNum, () => editState.rotationDeg.roll, (v) => { editState.rotationDeg.roll = v; }, 0);

  document.querySelectorAll('.quick-rot-row [data-quick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.quick === 'yaw180') {
        editState.rotationDeg.yaw = wrapDeg180(editState.rotationDeg.yaw + 180);
      }
      syncEditorUiFromState();
      updateGateFromEditState();
    });
  });

  function wrapDeg180(d) {
    let v = d % 360;
    if (v > 180) v -= 360;
    if (v < -180) v += 360;
    return v;
  }

  // -----------------------------------------------------------
  // ポートモデルの調整値（回転・スケール・位置オフセット）
  // モデルはゲートメッシュ(gateMesh)と同じワールド変換（editStateの
  // 位置・姿勢）を親として、その子ノード(modelCorrectionGroup)に
  // 追加する。ここで扱う調整値はその子ノードへの補正のみ。
  // -----------------------------------------------------------
  const modelAdjust = {
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: 1,
    offset: { x: 0, y: 0, z: 0 },
  };

  function applyModelAdjustToGroup() {
    if (!modelCorrectionGroup) return;
    const toRad = (d) => (d * Math.PI) / 180;
    modelCorrectionGroup.rotation.set(
      toRad(modelAdjust.rotationDeg.x),
      toRad(modelAdjust.rotationDeg.y),
      toRad(modelAdjust.rotationDeg.z)
    );
    modelCorrectionGroup.scale.setScalar(modelAdjust.scale);
    modelCorrectionGroup.position.set(modelAdjust.offset.x, modelAdjust.offset.y, modelAdjust.offset.z);
  }

  function syncModelRotUiFromState() {
    modelRotX.value = modelAdjust.rotationDeg.x;
    modelRotY.value = modelAdjust.rotationDeg.y;
    modelRotZ.value = modelAdjust.rotationDeg.z;
    modelRotXVal.textContent = `${Math.round(modelAdjust.rotationDeg.x)}°`;
    modelRotYVal.textContent = `${Math.round(modelAdjust.rotationDeg.y)}°`;
    modelRotZVal.textContent = `${Math.round(modelAdjust.rotationDeg.z)}°`;
  }
  function syncModelScaleUiFromState() {
    modelScaleSlider.value = Math.log10(modelAdjust.scale);
    modelScaleVal.textContent = `×${modelAdjust.scale.toFixed(2)}`;
  }
  function syncModelOffsetUiFromState() {
    modelOffX.value = modelAdjust.offset.x;
    modelOffY.value = modelAdjust.offset.y;
    modelOffZ.value = modelAdjust.offset.z;
    modelOffXVal.textContent = modelAdjust.offset.x.toFixed(1);
    modelOffYVal.textContent = modelAdjust.offset.y.toFixed(1);
    modelOffZVal.textContent = modelAdjust.offset.z.toFixed(1);
  }

  modelRotX.addEventListener('input', () => { modelAdjust.rotationDeg.x = Number(modelRotX.value); modelRotXVal.textContent = `${modelRotX.value}°`; applyModelAdjustToGroup(); });
  modelRotY.addEventListener('input', () => { modelAdjust.rotationDeg.y = Number(modelRotY.value); modelRotYVal.textContent = `${modelRotY.value}°`; applyModelAdjustToGroup(); });
  modelRotZ.addEventListener('input', () => { modelAdjust.rotationDeg.z = Number(modelRotZ.value); modelRotZVal.textContent = `${modelRotZ.value}°`; applyModelAdjustToGroup(); });

  modelScaleSlider.addEventListener('input', () => {
    modelAdjust.scale = Math.pow(10, Number(modelScaleSlider.value));
    modelScaleVal.textContent = `×${modelAdjust.scale.toFixed(2)}`;
    applyModelAdjustToGroup();
  });

  modelOffX.addEventListener('input', () => { modelAdjust.offset.x = Number(modelOffX.value); modelOffXVal.textContent = modelAdjust.offset.x.toFixed(1); applyModelAdjustToGroup(); });
  modelOffY.addEventListener('input', () => { modelAdjust.offset.y = Number(modelOffY.value); modelOffYVal.textContent = modelAdjust.offset.y.toFixed(1); applyModelAdjustToGroup(); });
  modelOffZ.addEventListener('input', () => { modelAdjust.offset.z = Number(modelOffZ.value); modelOffZVal.textContent = modelAdjust.offset.z.toFixed(1); applyModelAdjustToGroup(); });

  document.querySelectorAll('[data-model-quick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.modelQuick;
      if (kind === 'yaw180') modelAdjust.rotationDeg.y = wrapDeg180(modelAdjust.rotationDeg.y + 180);
      if (kind === 'pitch90') modelAdjust.rotationDeg.x = wrapDeg180(modelAdjust.rotationDeg.x + 90);
      if (kind === 'pitchm90') modelAdjust.rotationDeg.x = wrapDeg180(modelAdjust.rotationDeg.x - 90);
      if (kind === 'roll90') modelAdjust.rotationDeg.z = wrapDeg180(modelAdjust.rotationDeg.z + 90);
      syncModelRotUiFromState();
      applyModelAdjustToGroup();
    });
  });

  document.querySelectorAll('[data-model-preset-scale]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.modelPresetScale;
      modelAdjust.scale = p === 'autofit' ? computeModelAutofitScale() : Number(p);
      syncModelScaleUiFromState();
      applyModelAdjustToGroup();
    });
  });

  // モデルのバウンディングサイズをゲートの内寸目安（DockingPlatformの
  // GATE_WIDTH/HEIGHT/DEPTH）に収める倍率を逆算する
  function computeModelAutofitScale() {
    if (!modelRoot) return 1;
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = new THREE.Vector3();
    box.getSize(size);
    const longestAxis = Math.max(size.x, size.y, size.z);
    if (longestAxis <= 0 || !isFinite(longestAxis)) return 1;
    const targetLength = DockingPlatform.GATE_DEPTH;
    return targetLength / longestAxis;
  }

  modelResetAdjustBtn.addEventListener('click', () => {
    modelAdjust.rotationDeg = { x: 0, y: 0, z: 0 };
    modelAdjust.scale = 1;
    modelAdjust.offset = { x: 0, y: 0, z: 0 };
    syncModelRotUiFromState();
    syncModelScaleUiFromState();
    syncModelOffsetUiFromState();
    applyModelAdjustToGroup();
  });

  // -----------------------------------------------------------
  // Three.js プレビューシーン
  //
  // オービットカメラの実装は09-ship-builder.jsと同じ簡易自前実装
  // （ライブラリ非依存）。ゲートメッシュ自体は10-docking-platform.jsの
  // DockingPlatform._buildGateMesh()をそのまま呼んで生成する。
  // -----------------------------------------------------------
  let renderer, scene, camera;
  let gateMesh = null;
  let sceneInited = false;

  // v63: ポートのカスタム3Dモデル。gateMeshの子として追加し、
  // gateMeshの位置・姿勢にそのまま追従させる。modelCorrectionGroupは
  // 09-ship-builder.jsのcorrectionGroupと同じ役割（回転/スケール/
  // 位置オフセットの適用先）。
  let modelRoot = null;
  let modelCorrectionGroup = null;

  const orbitState = {
    radius: 90,
    theta: Math.PI * 0.25,
    phi: Math.PI * 0.35,
    target: new THREE.Vector3(0, 0, 0),
  };

  function ensureSceneInited() {
    if (sceneInited) {
      resizeRenderer();
      return;
    }
    sceneInited = true;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e16);
    camera = new THREE.PerspectiveCamera(55, 1, 0.05, 20000);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const ambient = new THREE.AmbientLight(0x8899aa, 0.7);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(40, 60, 50);
    scene.add(key);

    const gridHelper = new THREE.GridHelper(200, 20, 0x2a5578, 0x16283a);
    scene.add(gridHelper);

    // 艦の代わりの簡易マーカー（ゲート手前に置く小さな矢印つき箱）で、
    // 「艦がどちらから進入してくるか」を分かりやすくする
    const shipMarker = new THREE.Group();
    const markerBody = new THREE.Mesh(
      new THREE.ConeGeometry(2, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.85 })
    );
    markerBody.rotation.x = Math.PI / 2;
    shipMarker.add(markerBody);
    shipMarker.userData.isShipMarker = true;
    scene.add(shipMarker);

    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);
    animate();
  }

  function resizeRenderer() {
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  }

  function updateCameraFromOrbit() {
    const { radius, theta, phi, target } = orbitState;
    const sinPhi = Math.sin(phi);
    camera.position.set(
      target.x + radius * sinPhi * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * sinPhi * Math.cos(theta)
    );
    camera.lookAt(target);
  }

  function animate() {
    requestAnimationFrame(animate);
    if (editorWrap.classList.contains('hidden')) return; // 一覧表示中は描画不要
    updateCameraFromOrbit();
    renderer.render(scene, camera);
  }

  function updateGateFromEditState() {
    if (!sceneInited) return;
    if (!gateMesh) {
      gateMesh = DockingPlatform._buildGateMesh();
      scene.add(gateMesh);
      // モデルはゲートと同じ位置・姿勢に追従させたいだけなので、
      // gateMesh自体の子として追加する（ワールド変換の二重管理を避ける）
      modelCorrectionGroup = new THREE.Group();
      gateMesh.add(modelCorrectionGroup);
      applyModelAdjustToGroup();
    }
    gateMesh.position.set(editState.position.x, editState.position.y, editState.position.z);
    const q = eulerToQuatSmall(
      (editState.rotationDeg.pitch * Math.PI) / 180,
      (editState.rotationDeg.yaw * Math.PI) / 180,
      (editState.rotationDeg.roll * Math.PI) / 180
    );
    gateMesh.quaternion.set(q.x, q.y, q.z, q.w);
    // カメラの注視点をポート位置へ追従させ、原点から離れた場所に
    // 作ったポートでも常に画面内に収まるようにする
    orbitState.target.set(editState.position.x, editState.position.y, editState.position.z);
  }

  // ---- ポインタ操作: ドラッグで回転、ホイール/ピンチでズーム ----
  let dragging = false;
  let lastX = 0, lastY = 0;
  let pinchStartDist = 0;
  let pinchStartRadius = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    orbitState.theta -= dx * 0.008;
    orbitState.phi = clamp(orbitState.phi - dy * 0.008, 0.15, Math.PI - 0.15);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbitState.radius = clamp(orbitState.radius * (1 + e.deltaY * 0.001), 5, 2000);
  }, { passive: false });

  const activePointers = new Map();
  canvas.addEventListener('pointerdown', (e) => activePointers.set(e.pointerId, e));
  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, e);
    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      if (pinchStartDist === 0) {
        pinchStartDist = dist;
        pinchStartRadius = orbitState.radius;
      } else {
        orbitState.radius = clamp(pinchStartRadius * (pinchStartDist / Math.max(1, dist)), 5, 2000);
      }
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => {
    canvas.addEventListener(evt, (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) pinchStartDist = 0;
    });
  });

  // -----------------------------------------------------------
  // ポートモデルの読み込み・保存・削除
  // （09-ship-builder.jsのモデル読込ロジックと同一方式。保存キーが
  //  classKeyではなくportIdである点のみ異なる）
  // -----------------------------------------------------------
  let pendingSaveFormat = null;
  let pendingSaveFileName = null;
  let pendingSaveGlbArrayBuffer = null;
  let pendingSaveObjText = null;
  let pendingSaveMtlText = null;
  let pendingSaveTextures = null;

  function clearModelRoot() {
    if (modelRoot) {
      modelCorrectionGroup.remove(modelRoot);
      disposeObject3D(modelRoot);
      modelRoot = null;
    }
  }

  function disposeObject3D(obj) {
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          Object.values(m).forEach((v) => {
            if (v && v.isTexture) v.dispose();
          });
          m.dispose();
        });
      }
    });
  }

  function onModelLoadedIntoScene(root) {
    clearModelRoot();
    modelRoot = root;
    modelCorrectionGroup.add(modelRoot);
    applyModelAdjustToGroup();

    modelEmptyState.classList.add('hidden');
    modelAdjustSection.style.display = '';
  }

  function showModelDropzoneForReplace() {
    clearModelRoot();
    pendingSaveFormat = null;
    pendingSaveGlbArrayBuffer = null;
    pendingSaveObjText = null;
    pendingSaveMtlText = null;
    pendingSaveTextures = null;

    modelEmptyState.classList.remove('hidden');
    modelAdjustSection.style.display = 'none';
  }

  function createRobustGltfLoader() {
    const manager = new THREE.LoadingManager();
    const loader = new THREE.GLTFLoader(manager);
    loader.textureLoader = new THREE.TextureLoader(manager);
    return loader;
  }

  function withTimeout(promiseExecutor, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      promiseExecutor(
        (...args) => { clearTimeout(timer); resolve(...args); },
        (...args) => { clearTimeout(timer); reject(...args); }
      );
    });
  }

  function loadGlbFromFile(file) {
    return withTimeout((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
      reader.onload = () => {
        const arrayBuffer = reader.result;
        const loader = createRobustGltfLoader();
        loader.parse(
          arrayBuffer,
          '',
          (gltf) => {
            onModelLoadedIntoScene(gltf.scene);
            pendingSaveGlbArrayBuffer = arrayBuffer;
            pendingSaveFormat = 'glb';
            pendingSaveFileName = file.name;
            resolve();
          },
          (err) => reject(err instanceof Error ? err : new Error('GLBの解析に失敗しました'))
        );
      };
      reader.readAsArrayBuffer(file);
    }, 30000, 'GLBの読み込みがタイムアウトしました（テクスチャのデコードが止まっている可能性があります）');
  }

  function readFilesAsDataUrls(files) {
    const entries = (files || []).map((f) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error(`テクスチャ画像(${f.name})の読み込みに失敗しました`));
      r.onload = () => resolve([f.name, r.result]);
      r.readAsDataURL(f);
    }));
    return Promise.all(entries).then((pairs) => Object.fromEntries(pairs));
  }

  function loadObjFromFiles(objFile, mtlFile, texFiles) {
    return new Promise((resolve, reject) => {
      const objReader = new FileReader();
      objReader.onerror = () => reject(new Error('OBJファイルの読み込みに失敗しました'));
      objReader.onload = () => {
        const objText = objReader.result;

        const finishWithMaterials = (materials) => {
          const objLoader = new THREE.OBJLoader();
          if (materials) {
            materials.preload();
            objLoader.setMaterials(materials);
          }
          try {
            const objGroup = objLoader.parse(objText);
            onModelLoadedIntoScene(objGroup);

            pendingSaveFormat = 'obj';
            pendingSaveFileName = objFile.name;
            pendingSaveObjText = objText;
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error('OBJの解析に失敗しました'));
          }
        };

        if (!mtlFile) {
          pendingSaveMtlText = null;
          pendingSaveTextures = null;
          finishWithMaterials(null);
          return;
        }

        readFilesAsDataUrls(texFiles).then((texMap) => {
          pendingSaveTextures = texMap;

          const mtlReader = new FileReader();
          mtlReader.onerror = () => reject(new Error('MTLファイルの読み込みに失敗しました'));
          mtlReader.onload = () => {
            const mtlText = mtlReader.result;
            pendingSaveMtlText = mtlText;

            const manager = new THREE.LoadingManager();
            manager.setURLModifier((url) => {
              const baseName = url.split('/').pop().split('\\').pop();
              if (texMap[baseName]) return texMap[baseName];
              return url;
            });

            const mtlLoader = new THREE.MTLLoader(manager);
            try {
              const materials = mtlLoader.parse(mtlText, '');
              finishWithMaterials(materials);
            } catch (e) {
              reject(e instanceof Error ? e : new Error('MTLの解析に失敗しました'));
            }
          };
          mtlReader.readAsText(mtlFile);
        });
      };
      objReader.readAsText(objFile);
    });
  }

  loadModelBtn.addEventListener('click', async () => {
    setModelStatus('読み込み中…', false);
    loadModelBtn.disabled = true;
    try {
      if (activeFormat === 'glb') {
        await loadGlbFromFile(pendingGlbFile);
      } else {
        await loadObjFromFiles(pendingObjFile, pendingMtlFile, pendingTexFiles);
      }
      setModelStatus('読み込み完了。向き・スケールを調整してください。', false);
    } catch (e) {
      console.error(e);
      setModelStatus(`読み込みに失敗しました: ${e.message || e}`, true);
    } finally {
      refreshLoadButtonEnabled();
    }
  });

  modelReplaceBtn.addEventListener('click', () => {
    showModelDropzoneForReplace();
    setModelStatus('新しいモデルをドロップまたは選択してください。まだ保存はされていません。', false);
  });

  modelRemoveBtn.addEventListener('click', async () => {
    if (!editingPortId) {
      // 新規作成中でまだ保存されていないポート: メモリ上のpendingを
      // クリアするだけでよい（保存済みデータ自体がまだ存在しない）
      showModelDropzoneForReplace();
      setModelStatus('モデルを未読み込みの状態に戻しました。', false);
      return;
    }
    try {
      await removePortModelData(editingPortId);
      setModelStatus('モデルを削除しました。簡易ゲート表示に戻ります。', false);
    } catch (e) {
      console.error(e);
      setModelStatus('モデルの削除に失敗しました。', true);
      return;
    }
    showModelDropzoneForReplace();
  });

  function arrayBufferToDataUrl(buffer, mimeType) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  // ポート保存(savePortBtn押下)の際、モデルが読み込まれていれば
  // あわせてIndexedDBへ保存する。既存のsavePortBtnクリックハンドラーとは
  // 別に登録し、両方が実行される（保存順は登録順=ポート本体保存が先）。
  async function savePendingPortModelIfAny(portId) {
    if (!pendingSaveFormat) return; // 未読み込みのまま保存 = モデル無しのポート
    const data = {
      format: pendingSaveFormat,
      fileName: pendingSaveFileName,
      glbDataUrl: pendingSaveFormat === 'glb'
        ? arrayBufferToDataUrl(pendingSaveGlbArrayBuffer, 'model/gltf-binary')
        : null,
      objText: pendingSaveFormat === 'obj' ? pendingSaveObjText : null,
      mtlText: pendingSaveFormat === 'obj' ? pendingSaveMtlText : null,
      textures: pendingSaveFormat === 'obj' ? pendingSaveTextures : null,
      adjust: {
        rotationDeg: { ...modelAdjust.rotationDeg },
        scale: modelAdjust.scale,
        offset: { ...modelAdjust.offset },
      },
    };
    try {
      await savePortModelData(portId, data);
    } catch (e) {
      console.error(e);
      if (e && e.name === 'QuotaExceededError') {
        setModelStatus('ポート情報は保存されましたが、モデルの保存に失敗しました（容量不足）。端末のストレージ空き容量を確認するか、モデルのファイルサイズを小さくしてください。', true);
      } else {
        setModelStatus('ポート情報は保存されましたが、モデルの保存に失敗しました。', true);
      }
    }
  }
  // savePortBtnのポート本体保存ハンドラー（addEventListenerの登録順で
  // このリスナーより先に実行される）はcloseEditor()経由でeditingPortIdを
  // nullにクリアしてしまうため、モデル保存に使うIDは
  // クリックされた「その瞬間」のeditingPortId（=このcaptureイベントの
  // 時点の値）を別途確保しておく必要がある。captureフェーズは
  // bubbleフェーズより先に発火するため、ここで先取りして安全に保持する。
  let savePortBtnCapturedId = null;
  savePortBtn.addEventListener('click', () => {
    savePortBtnCapturedId = editingPortId; // 新規作成中はnullのまま
  }, { capture: true });

  savePortBtn.addEventListener('click', () => {
    const targetPortId = savePortBtnCapturedId || ports[ports.length - 1]?.id;
    if (targetPortId) savePendingPortModelIfAny(targetPortId);
  });

  // ポート削除時、孤立したモデルデータが残らないよう合わせて削除する。
  // savePortBtnと同じ理由でcaptureフェーズにより先取りしたIDを使う。
  let deletePortBtnCapturedId = null;
  deletePortBtn.addEventListener('click', () => {
    deletePortBtnCapturedId = editingPortId;
  }, { capture: true });

  deletePortBtn.addEventListener('click', () => {
    if (deletePortBtnCapturedId) {
      removePortModelData(deletePortBtnCapturedId).catch((e) => console.warn('ポートモデルの削除に失敗しました。', e));
    }
  });

  // -----------------------------------------------------------
  // 既存保存データがあれば編集画面を開いたタイミングで復元
  // -----------------------------------------------------------
  async function restoreExistingPortModel(portId) {
    if (!portId) {
      // 新規作成: モデル無しの状態から開始
      showModelDropzoneForReplace();
      setModelStatus('', false);
      return;
    }
    setModelStatus('保存済みのモデルを確認しています…', false);
    let existing;
    try {
      existing = await loadPortModelData(portId);
    } catch (e) {
      console.error(e);
      setModelStatus('保存済みモデルの読み込みに失敗しました。', true);
      return;
    }
    if (!existing) {
      showModelDropzoneForReplace();
      setModelStatus('', false);
      return;
    }

    modelAdjust.rotationDeg = { ...existing.adjust.rotationDeg };
    modelAdjust.scale = existing.adjust.scale;
    modelAdjust.offset = { ...existing.adjust.offset };
    syncModelRotUiFromState();
    syncModelScaleUiFromState();
    syncModelOffsetUiFromState();

    setModelStatus('保存済みのモデルを読み込んでいます…', false);

    if (existing.format === 'glb') {
      // v67: fetch(dataUrl)はiPad(iOS WebKit)で巨大なdata URLに対して
      // 読み込み失敗することがあったため、atobによる直接デコードに変更。
      // PC・Androidでは元々問題なかったが、fetch経由をやめても挙動は
      // 同一（同じArrayBufferが得られる）。
      try {
        const buf = dataUrlToArrayBuffer(existing.glbDataUrl);
        const loader = createRobustGltfLoader();
        loader.parse(buf, '', (gltf) => {
          onModelLoadedIntoScene(gltf.scene);
          pendingSaveFormat = 'glb';
          pendingSaveFileName = existing.fileName;
          pendingSaveGlbArrayBuffer = buf;
          setModelStatus('保存済みモデルを読み込みました。', false);
        }, () => setModelStatus('保存済みモデルの読み込みに失敗しました。', true));
      } catch (e) {
        console.error(e);
        setModelStatus('保存済みモデルの読み込みに失敗しました。', true);
      }
    } else if (existing.format === 'obj') {
      const finish = (materials) => {
        const objLoader = new THREE.OBJLoader();
        if (materials) {
          materials.preload();
          objLoader.setMaterials(materials);
        }
        const objGroup = objLoader.parse(existing.objText);
        onModelLoadedIntoScene(objGroup);
        pendingSaveFormat = 'obj';
        pendingSaveFileName = existing.fileName;
        pendingSaveObjText = existing.objText;
        pendingSaveMtlText = existing.mtlText;
        pendingSaveTextures = existing.textures;
        setModelStatus('保存済みモデルを読み込みました。', false);
      };

      if (!existing.mtlText) {
        finish(null);
      } else {
        const texMap = existing.textures || {};
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
          const baseName = url.split('/').pop().split('\\').pop();
          if (texMap[baseName]) return texMap[baseName];
          return url;
        });
        const mtlLoader = new THREE.MTLLoader(manager);
        const materials = mtlLoader.parse(existing.mtlText, '');
        finish(materials);
      }
    }
  }

  // -----------------------------------------------------------
  // 初期表示
  // -----------------------------------------------------------
  renderList();
})();
