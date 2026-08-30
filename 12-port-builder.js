// =============================================================
// 12-port-builder.js
// ドッキングポート設定画面（port-builder.html）専用スクリプト
//
// できること（v62スコープ）:
//   - 保存済みドッキングポート（名前+位置+姿勢）の一覧表示
//   - 新規作成・編集・削除
//   - 3Dプレビュー（10-docking-platform.jsのゲートメッシュ生成ロジックを
//     そのまま再利用。オービットカメラでドラッグ回転・ホイールズーム）
//   - 一覧から1つを選んで「使用するポートに設定」すると、
//     State.dockingTarget / saveDockingTarget（01-state-and-config.js、
//     ゲーム内オートドッキングが直接参照する既存の単一アクティブ値）
//     へ反映する
//
// 保存形式・関数（loadDockingPorts/saveDockingPorts/generateDockingPortId、
// loadDockingTarget/saveDockingTarget）はすべて01-state-and-config.js側に
// 定義済み（詳細はそちらのコメント参照）。
//
// ゲート形状は10-docking-platform.jsの DockingPlatform._buildGateMesh() を
// そのまま呼び出して再利用している。ゲームプレイ中に表示される実際の
// ゲートと見た目を常に一致させるため、独自に複製せずロジックを共有する。
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
  // Three.js プレビューシーン
  //
  // オービットカメラの実装は09-ship-builder.jsと同じ簡易自前実装
  // （ライブラリ非依存）。ゲートメッシュ自体は10-docking-platform.jsの
  // DockingPlatform._buildGateMesh()をそのまま呼んで生成する。
  // -----------------------------------------------------------
  let renderer, scene, camera;
  let gateMesh = null;
  let sceneInited = false;

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
  // 初期表示
  // -----------------------------------------------------------
  renderList();
})();
