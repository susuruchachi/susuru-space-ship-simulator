// =============================================================
// 09-ship-builder.js
// 艦船建造画面（ship-builder.html）専用スクリプト
//
// ビルド識別用（画面右上にも表示。読み込んだファイルが最新か
// ひと目で確認するための目印）
// v29: 従来は機能名ベースの独自番号(SHIP_BUILDER_BUILD_TAG、例:
// 'v13-indexeddb-model-storage')をこのファイル内で個別管理して
// いたが、ゲーム全体のGAME_VERSION(01-state-and-config.js)と
// 表示が食い違う（更新し忘れる）ことがあったため、以後は
// GAME_VERSIONをそのまま参照する形に統一した。個別のタグ変数は
// 廃止。
// =============================================================

// できること（v01スコープ）:
//   - GLB、またはOBJ+MTL(+テクスチャ)をインポートしてプレビュー
//   - 読み込んだモデルの向き(X/Y/Z回転)・スケール・位置オフセットを調整
//   - 艦種(rocket/cruiser/battleship)ごとにモデル+調整値を保存
//
// スラスター位置の見直しやモデル差し替え時の自動整合は範囲外
// （ユーザー指定により、今回はインポートと向き合わせのみ）。
//
// 保存形式（localStorage, キー: spaceSimShipModel:<classKey>）:
//   {
//     format: 'glb' | 'obj',
//     fileName: string,           // 表示用（GLBはこのファイル名、OBJは"obj.name"）
//     glbDataUrl: string | null,  // format==='glb'の場合、Base64 data URL
//     objText: string | null,     // format==='obj'の場合、OBJのテキスト内容
//     mtlText: string | null,     // MTLのテキスト内容（無ければnull）
//     textures: { [ファイル名]: dataUrl } | null, // MTLが参照する画像
//     adjust: {
//       rotationDeg: { x, y, z },  // モデル補正用の追加回転（度）
//       scale: number,             // 一様スケール倍率
//       offset: { x, y, z },       // 艦重心からのローカル位置オフセット
//     },
//   }
//
// 注意: GLB/テクスチャをBase64でlocalStorageに保存するため、
// 大きすぎるモデルは容量超過で保存に失敗する可能性がある
// （保存失敗時はステータス行にエラー表示してユーザーに知らせる）。
// =============================================================

// loadShipModelData/saveShipModelData/removeShipModelDataは
// 01-state-and-config.jsで定義（index.html側でも保存済みモデルを
// 読み込む必要が生じたため、両ページで共有する基盤ファイルに統一）

// -------------------------------------------------------------
// 画面初期化
// -------------------------------------------------------------
(function () {
  const params = new URLSearchParams(location.search);
  const persisted = loadPersistedSettings();
  const requestedClass = params.get('class') || persisted.shipClass || 'rocket';
  const classKey = ShipClassPresets[requestedClass] ? requestedClass : 'rocket';

  document.getElementById('classBadge').textContent = ShipClassPresets[classKey].label;
  const versionLineEl = document.getElementById('buildVersionLine');
  if (versionLineEl) versionLineEl.textContent = `build: ${GAME_VERSION}`;

  // CDN読み込み失敗（ネットワーク不調、URL変更等）を早期に検知する。
  // 何もチェックせずに進むと、モデル読み込みボタンを押した瞬間に
  // 「undefined is not a constructor」という分かりにくいエラーで
  // 落ちるだけになるため、起動直後にまとめて確認して分かりやすく警告する。
  const missingLibs = ['GLTFLoader', 'OBJLoader', 'MTLLoader'].filter(
    (name) => typeof THREE === 'undefined' || typeof THREE[name] !== 'function'
  );
  if (missingLibs.length > 0) {
    document.getElementById('statusLine').textContent =
      `モデル読み込み機能の準備に失敗しました（${missingLibs.join('、')}が読み込めていません）。通信状況を確認して再読み込みしてください。`;
    document.getElementById('statusLine').classList.add('error');
    document.getElementById('loadModelBtn').disabled = true;
  }

  // -----------------------------------------------------------
  // DOM参照
  // -----------------------------------------------------------
  const canvas = document.getElementById('viewportCanvas');
  const emptyState = document.getElementById('emptyState');
  const adjustPanel = document.getElementById('adjustPanel');
  const footerBar = document.getElementById('footerBar');
  const statusLine = document.getElementById('statusLine');
  const loadModelBtn = document.getElementById('loadModelBtn');
  const viewportHint = document.getElementById('viewportHint');

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

  // -----------------------------------------------------------
  // 選択中の入力ソース（読み込みボタン押下まではメモリ内のみ）
  // -----------------------------------------------------------
  let activeFormat = 'glb';
  let pendingGlbFile = null;
  let pendingObjFile = null;
  let pendingMtlFile = null;
  let pendingTexFiles = []; // File[]

  function setStatus(msg, isError) {
    statusLine.textContent = msg || '';
    statusLine.classList.toggle('error', !!isError);
  }

  function refreshLoadButtonEnabled() {
    if (activeFormat === 'glb') {
      loadModelBtn.disabled = !pendingGlbFile;
    } else {
      loadModelBtn.disabled = !pendingObjFile; // MTL/テクスチャは任意
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
  const dropzoneEl = emptyState;
  ['dragenter', 'dragover'].forEach((evt) => {
    dropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzoneEl.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzoneEl.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzoneEl.classList.remove('dragover');
    });
  });
  dropzoneEl.addEventListener('drop', (e) => {
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

  // -----------------------------------------------------------
  // Three.js プレビューシーン
  // -----------------------------------------------------------
  let renderer, scene, camera, orthoCamera;
  let modelRoot = null;      // 読み込んだモデルそのもの（原点はモデル依存）
  let correctionGroup = null; // rotation/scale/offset補正を適用する中間ノード
  let gridHelper = null;
  let axesHelper = null;

  // オービットカメラ（簡易実装。ライブラリ非依存でOrbitControls相当の
  // 挙動をタッチ/マウス両対応で自前実装する）
  // v74: 平行投影（正面/側面/上面など、ブレンダー風の6方向固定視点）
  // 対応のため、theta/phi/radius/targetに加えてorthoモードの状態を持つ。
  //   ortho: null（通常の自由視点=透視投影）、または
  //          'front'|'back'|'left'|'right'|'top'|'bottom'
  //   orthoZoom: 平行投影時のフラスタムの大きさ（値が大きいほど広く映る）
  const orbitState = {
    radius: 12,
    theta: Math.PI * 0.25,  // 水平角
    phi: Math.PI * 0.35,    // 垂直角（0=真上, PI=真下）
    target: new THREE.Vector3(0, 0, 0),
    ortho: null,
    orthoZoom: 12,
  };

  // 6方向固定視点のtheta/phi定義。ブレンダーのテンキー視点と同様、
  // 各面の見た目の向き（どちらが画面の上か）が自然になるよう選定。
  // phiは0=真上/PI=真下なので、上面・下面はphiだけで表現しtheta依存なし。
  const ORTHO_VIEWS = {
    front:  { theta: 0,               phi: Math.PI / 2 },
    back:   { theta: Math.PI,         phi: Math.PI / 2 },
    right:  { theta: Math.PI / 2,     phi: Math.PI / 2 },
    left:   { theta: -Math.PI / 2,    phi: Math.PI / 2 },
    top:    { theta: 0,               phi: 0.001 },
    bottom: { theta: 0,               phi: Math.PI - 0.001 },
  };
  // 同じボタンをもう一度押すと反対面へ切り替える（前⇄後、左⇄右、上⇄下）
  const ORTHO_OPPOSITE = { front: 'back', back: 'front', left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

  function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e16);

    camera = new THREE.PerspectiveCamera(55, 1, 0.05, 5000);
    orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 5000);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const ambient = new THREE.AmbientLight(0x8899aa, 0.7);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(4, 6, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6cc3ff, 0.5);
    rim.position.set(-5, -2, -4);
    scene.add(rim);

    gridHelper = new THREE.GridHelper(20, 20, 0x2a5578, 0x16283a);
    scene.add(gridHelper);
    axesHelper = new THREE.AxesHelper(4);
    scene.add(axesHelper);

    // モデルは常にこのグループの子として追加し、艦の進行方向の
    // 目印として艦首側(-Z、ゲーム内の前方に相当)へ矢印を出しておく
    const arrowDir = new THREE.Vector3(0, 0, -1);
    const arrow = new THREE.ArrowHelper(arrowDir, new THREE.Vector3(0, 0, 0), 5, 0xffcc55, 1.2, 0.6);
    scene.add(arrow);

    correctionGroup = new THREE.Group();
    scene.add(correctionGroup);

    resizeRenderer();
    window.addEventListener('resize', resizeRenderer);
    animate();
  }

  function resizeRenderer() {
    const rect = canvas.parentElement.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    const aspect = rect.width / Math.max(1, rect.height);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    orthoCamera.left = -orbitState.orthoZoom * aspect;
    orthoCamera.right = orbitState.orthoZoom * aspect;
    orthoCamera.top = orbitState.orthoZoom;
    orthoCamera.bottom = -orbitState.orthoZoom;
    orthoCamera.updateProjectionMatrix();
  }

  function getActiveCamera() {
    return orbitState.ortho ? orthoCamera : camera;
  }

  function updateCameraFromOrbit() {
    const { radius, theta, phi, target } = orbitState;
    const sinPhi = Math.sin(phi);
    const dir = {
      x: sinPhi * Math.sin(theta),
      y: Math.cos(phi),
      z: sinPhi * Math.cos(theta),
    };
    // 通常の透視投影カメラは距離(radius)に応じた位置に置く
    camera.position.set(
      target.x + radius * dir.x,
      target.y + radius * dir.y,
      target.z + radius * dir.z
    );
    camera.lookAt(target);

    if (orbitState.ortho) {
      // 平行投影カメラは同じ向き・同じ距離だが、大きさはフラスタム
      // (orthoZoom)で決まるため、遠すぎ/近すぎにならない適当な距離に置く
      const orthoDist = Math.max(radius, 5);
      orthoCamera.position.set(
        target.x + orthoDist * dir.x,
        target.y + orthoDist * dir.y,
        target.z + orthoDist * dir.z
      );
      orthoCamera.lookAt(target);
      const rect = canvas.parentElement.getBoundingClientRect();
      const aspect = rect.width / Math.max(1, rect.height);
      orthoCamera.left = -orbitState.orthoZoom * aspect;
      orthoCamera.right = orbitState.orthoZoom * aspect;
      orthoCamera.top = orbitState.orthoZoom;
      orthoCamera.bottom = -orbitState.orthoZoom;
      orthoCamera.updateProjectionMatrix();
    }
  }

  // -----------------------------------------------------------
  // 6方向固定視点（正面/背面/左/右/上/下）の切り替え。
  // 同じ面をもう一度指定すると反対面へ切り替わる（ブレンダー風）。
  // -----------------------------------------------------------
  function setOrthoView(face) {
    if (orbitState.ortho === face) {
      face = ORTHO_OPPOSITE[face];
    }
    const view = ORTHO_VIEWS[face];
    if (!view) return;
    orbitState.ortho = face;
    orbitState.theta = view.theta;
    orbitState.phi = view.phi;
    // フラスタムの大きさは現在のズーム(radius)相当を引き継ぐ
    orbitState.orthoZoom = orbitState.radius;
    resizeRenderer();
    if (typeof refreshOrthoButtons === 'function') refreshOrthoButtons();
  }

  // 自由回転（ドラッグ）した場合は「面」に正対しなくなるため、
  // ブレンダー同様、平行投影を抜けて通常の透視投影へ戻す。
  function exitOrthoView() {
    if (!orbitState.ortho) return;
    orbitState.ortho = null;
    if (typeof refreshOrthoButtons === 'function') refreshOrthoButtons();
  }

  function animate() {
    requestAnimationFrame(animate);
    updateCameraFromOrbit();
    renderer.render(scene, getActiveCamera());
  }

  // ---- ポインタ操作: ドラッグで回転、ホイール/ピンチでズーム ----
  // v72: シフト+ドラッグ、および二本指スワイプ（ピンチと同時）で
  // orbitState.targetをずらせる「パン」を追加。
  let dragging = false;
  let panning = false;
  let lastX = 0, lastY = 0;
  let pinchStartDist = 0;
  let pinchStartRadius = 0;
  let pinchLastMidX = 0, pinchLastMidY = 0;
  const PAN_SENSITIVITY = 0.0015;

  // 現在のtheta/phiから、画面の右方向・上方向に対応するワールド
  // ベクトルを求める（Y軸を常にワールドupとする単純なオービット
  // カメラのため、08-camera.jsのような姿勢クォータニオン考慮は不要）。
  function computeScreenAxes() {
    const { theta, phi } = orbitState;
    const sinPhi = Math.sin(phi);
    // target→camera方向（backward）。実際にカメラが見ているview方向は
    // この逆なので、right/upはview方向から算出する。backwardをそのまま
    // 使うとrightの符号が反転し「パンの左右が逆」になる（upはforward/
    // rightの符号が両方反転して偶然相殺されるため上下は正しく見える）。
    const backward = { x: sinPhi * Math.sin(theta), y: Math.cos(phi), z: sinPhi * Math.cos(theta) };
    const view = { x: -backward.x, y: -backward.y, z: -backward.z };
    let right = { x: view.z, y: 0, z: -view.x }; // view × (0,1,0)
    const rightLen = Math.hypot(right.x, right.y, right.z) || 1;
    right = { x: right.x / rightLen, y: right.y / rightLen, z: right.z / rightLen };
    let up = {
      x: right.y * view.z - right.z * view.y,
      y: right.z * view.x - right.x * view.z,
      z: right.x * view.y - right.y * view.x,
    };
    const upLen = Math.hypot(up.x, up.y, up.z) || 1;
    up = { x: up.x / upLen, y: up.y / upLen, z: up.z / upLen };
    return { right, up };
  }

  // v73: パンの向きが逆との報告を受けて符号を反転（08-camera.jsと統一）。
  function applyScreenPan(dx, dy) {
    const { right, up } = computeScreenAxes();
    // 平行投影時はradiusではなくorthoZoom（フラスタムの大きさ）に
    // 比例させないと、ズーム量とパン量の感覚が合わなくなる。
    const scale = (orbitState.ortho ? orbitState.orthoZoom : orbitState.radius) * PAN_SENSITIVITY;
    orbitState.target.x += (right.x * dx - up.x * dy) * scale;
    orbitState.target.y += (right.y * dx - up.y * dy) * scale;
    orbitState.target.z += (right.z * dx - up.z * dy) * scale;
  }

  // v73: 「パンするときに回転しちゃう」不具合を修正。
  // 従来はpointerdownのたびにpanning = e.shiftKeyで上書きしていたため、
  // 2本指目が触れた瞬間（shiftKeyはfalseなので）panningがfalseに
  // リセットされ、単指用の回転処理（下のpointermove）がactivePointers
  // ベースの2本指パン処理と同時に動いてしまっていた。
  // activePointersを先に定義し、「今アクティブな指が1本だけか」で
  // 単指ドラッグ＝回転／パンを判定するよう統一する。
  const activePointers = new Map();

  canvas.addEventListener('pointerdown', (e) => {
    if (!modelRoot) return;
    activePointers.set(e.pointerId, e);
    dragging = true;
    panning = e.shiftKey;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 2本指以上がアクティブな間は、下の2本指パン処理に任せる
    // （単指用の回転/パン処理はここで止める）。
    if (activePointers.size >= 2) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (panning) {
      applyScreenPan(dx, dy);
      return;
    }
    orbitState.theta -= dx * 0.008;
    orbitState.phi = clamp(orbitState.phi - dy * 0.008, 0.15, Math.PI - 0.15);
    // 自由に回転させたら「面」に正対する平行投影ではなくなるため抜ける
    exitOrthoView();
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    panning = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (orbitState.ortho) {
      orbitState.orthoZoom = clamp(orbitState.orthoZoom * (1 + e.deltaY * 0.001), 0.5, 500);
    } else {
      orbitState.radius = clamp(orbitState.radius * (1 + e.deltaY * 0.001), 1, 500);
    }
  }, { passive: false });

  // 簡易ピンチズーム（2本指）。二本指スワイプ（中点の移動）はパンとして
  // 同時に処理する。
  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, e);
    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      const midX = (pts[0].clientX + pts[1].clientX) / 2;
      const midY = (pts[0].clientY + pts[1].clientY) / 2;
      if (pinchStartDist === 0) {
        pinchStartDist = dist;
        pinchStartRadius = orbitState.ortho ? orbitState.orthoZoom : orbitState.radius;
        pinchLastMidX = midX;
        pinchLastMidY = midY;
      } else {
        const scaled = clamp(pinchStartRadius * (pinchStartDist / Math.max(1, dist)), orbitState.ortho ? 0.5 : 1, 500);
        if (orbitState.ortho) {
          orbitState.orthoZoom = scaled;
        } else {
          orbitState.radius = scaled;
        }
        applyScreenPan(midX - pinchLastMidX, midY - pinchLastMidY);
        pinchLastMidX = midX;
        pinchLastMidY = midY;
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
  // 調整値の状態と適用
  // -----------------------------------------------------------
  const adjust = {
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: 1,
    offset: { x: 0, y: 0, z: 0 },
  };

  function applyAdjustToGroup() {
    if (!correctionGroup) return;
    const toRad = (d) => (d * Math.PI) / 180;
    correctionGroup.rotation.set(
      toRad(adjust.rotationDeg.x),
      toRad(adjust.rotationDeg.y),
      toRad(adjust.rotationDeg.z)
    );
    correctionGroup.scale.setScalar(adjust.scale);
    correctionGroup.position.set(adjust.offset.x, adjust.offset.y, adjust.offset.z);
    // v61: 回転・スケール・位置オフセットを変えるとモデルの
    // バウンディングボックス（＝接舷面の位置計算の基準）も変わるため、
    // 接舷面ギズモを毎回再計算する。dockingFace未設定時は内部で
    // 早期returnするだけなので無駄コストは小さい。
    // 関数宣言のためホイスティングにより、定義順に関わらず参照可能。
    if (typeof rebuildDockingFaceGizmo === 'function') rebuildDockingFaceGizmo();
  }

  // ---- スライダーDOM ----
  const rotX = document.getElementById('rotX');
  const rotY = document.getElementById('rotY');
  const rotZ = document.getElementById('rotZ');
  const rotXVal = document.getElementById('rotXVal');
  const rotYVal = document.getElementById('rotYVal');
  const rotZVal = document.getElementById('rotZVal');

  const scaleSlider = document.getElementById('scaleSlider'); // log軸: 10^value
  const scaleVal = document.getElementById('scaleVal');

  const offX = document.getElementById('offX');
  const offY = document.getElementById('offY');
  const offZ = document.getElementById('offZ');
  const offXVal = document.getElementById('offXVal');
  const offYVal = document.getElementById('offYVal');
  const offZVal = document.getElementById('offZVal');

  function syncRotUiFromState() {
    rotX.value = adjust.rotationDeg.x;
    rotY.value = adjust.rotationDeg.y;
    rotZ.value = adjust.rotationDeg.z;
    rotXVal.textContent = `${Math.round(adjust.rotationDeg.x)}°`;
    rotYVal.textContent = `${Math.round(adjust.rotationDeg.y)}°`;
    rotZVal.textContent = `${Math.round(adjust.rotationDeg.z)}°`;
  }
  function syncScaleUiFromState() {
    scaleSlider.value = Math.log10(adjust.scale);
    scaleVal.textContent = `×${adjust.scale.toFixed(2)}`;
  }
  function syncOffsetUiFromState() {
    offX.value = adjust.offset.x;
    offY.value = adjust.offset.y;
    offZ.value = adjust.offset.z;
    offXVal.textContent = adjust.offset.x.toFixed(1);
    offYVal.textContent = adjust.offset.y.toFixed(1);
    offZVal.textContent = adjust.offset.z.toFixed(1);
  }

  rotX.addEventListener('input', () => { adjust.rotationDeg.x = Number(rotX.value); rotXVal.textContent = `${rotX.value}°`; applyAdjustToGroup(); });
  rotY.addEventListener('input', () => { adjust.rotationDeg.y = Number(rotY.value); rotYVal.textContent = `${rotY.value}°`; applyAdjustToGroup(); });
  rotZ.addEventListener('input', () => { adjust.rotationDeg.z = Number(rotZ.value); rotZVal.textContent = `${rotZ.value}°`; applyAdjustToGroup(); });

  scaleSlider.addEventListener('input', () => {
    adjust.scale = Math.pow(10, Number(scaleSlider.value));
    scaleVal.textContent = `×${adjust.scale.toFixed(2)}`;
    applyAdjustToGroup();
  });

  offX.addEventListener('input', () => { adjust.offset.x = Number(offX.value); offXVal.textContent = adjust.offset.x.toFixed(1); applyAdjustToGroup(); });
  offY.addEventListener('input', () => { adjust.offset.y = Number(offY.value); offYVal.textContent = adjust.offset.y.toFixed(1); applyAdjustToGroup(); });
  offZ.addEventListener('input', () => { adjust.offset.z = Number(offZ.value); offZVal.textContent = adjust.offset.z.toFixed(1); applyAdjustToGroup(); });

  // クイック回転ボタン（よくある「モデルが上向き/横向きで読み込まれる」
  // ケースのショートカット。既存の回転に加算する）
  document.querySelectorAll('.quick-rot-row button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.quick;
      if (kind === 'yaw180') adjust.rotationDeg.y = wrapDeg180(adjust.rotationDeg.y + 180);
      if (kind === 'pitch90') adjust.rotationDeg.x = wrapDeg180(adjust.rotationDeg.x + 90);
      if (kind === 'pitchm90') adjust.rotationDeg.x = wrapDeg180(adjust.rotationDeg.x - 90);
      if (kind === 'roll90') adjust.rotationDeg.z = wrapDeg180(adjust.rotationDeg.z + 90);
      syncRotUiFromState();
      applyAdjustToGroup();
    });
  });
  function wrapDeg180(d) {
    let v = d % 360;
    if (v > 180) v -= 360;
    if (v < -180) v += 360;
    return v;
  }

  document.querySelectorAll('[data-preset-scale]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.presetScale;
      if (p === 'autofit') {
        adjust.scale = computeAutofitScale();
      } else {
        adjust.scale = Number(p);
      }
      syncScaleUiFromState();
      applyAdjustToGroup();
    });
  });

  // モデルのバウンディングサイズから「艦種の目安の全長」に収まる
  // 倍率を逆算する（GLB/OBJがcm単位・mm単位等でエクスポートされ、
  // 極端に大小になっているケースの救済用）
  function computeAutofitScale() {
    if (!modelRoot) return 1;
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = new THREE.Vector3();
    box.getSize(size);
    const longestAxis = Math.max(size.x, size.y, size.z);
    if (longestAxis <= 0 || !isFinite(longestAxis)) return 1;

    const targetLengthByClass = { rocket: 8, cruiser: 60, battleship: 140 };
    const targetLength = targetLengthByClass[classKey] ?? 8;
    return targetLength / longestAxis;
  }

  document.getElementById('resetAdjustBtn').addEventListener('click', () => {
    adjust.rotationDeg = { x: 0, y: 0, z: 0 };
    adjust.scale = 1;
    adjust.offset = { x: 0, y: 0, z: 0 };
    syncRotUiFromState();
    syncScaleUiFromState();
    syncOffsetUiFromState();
    applyAdjustToGroup();
    // 回転・スケール・位置を変えるとバウンディングボックスが変わり、
    // 接舷面のズレ量(offsetU/V)の基準もズレるため、接舷面もあわせて
    // リセットする（そのまま残すと面の位置が意図せずズレて見える）。
    setDockingFace(null);
  });

  // -----------------------------------------------------------
  // 接舷面（ドッキングフェイス）
  //
  // ship.dockingFace（01-state-and-config.js参照）と同じ形の状態を
  // このビルダー内でも保持し、保存ボタン押下時にモデルデータへ含める。
  // ギズモは「選択した面に半透明の板＋外向き矢印を表示する」形の
  // 簡易実装（面自体をドラッグする方式ではなく、パラメータ入力と
  // 連動して見た目を更新するプレビュー用）。
  // -----------------------------------------------------------
  let dockingFace = null; // { axis, offsetU, offsetV, tiltDeg:{u,v} } | null
  let dockingFaceGizmo = null; // THREE.Group

  const faceOffU = document.getElementById('faceOffU');
  const faceOffV = document.getElementById('faceOffV');
  const faceTiltU = document.getElementById('faceTiltU');
  const faceTiltV = document.getElementById('faceTiltV');
  const faceOffUVal = document.getElementById('faceOffUVal');
  const faceOffVVal = document.getElementById('faceOffVVal');
  const faceTiltUVal = document.getElementById('faceTiltUVal');
  const faceTiltVVal = document.getElementById('faceTiltVVal');
  const dockingFaceDetail = document.getElementById('dockingFaceDetail');

  // 現在のcorrectionGroup（補正後モデル）のバウンディングボックス
  // 半寸法をローカル座標系で返す。index.html側のバウンディングボックス
  // 計算（loadSavedShipModelInto内、補正後correctionGroupから算出）と
  // 基準を一致させるため、ここでも同じくcorrectionGroup全体から取る。
  function computeCurrentHalfExtents() {
    if (!modelRoot) return { x: 0, y: 0, z: 0 };
    const box = new THREE.Box3().setFromObject(correctionGroup);
    if (box.isEmpty()) return { x: 0, y: 0, z: 0 };
    const size = new THREE.Vector3();
    box.getSize(size);
    return { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
  }

  function setDockingFace(next) {
    dockingFace = next;
    syncDockingFaceUiFromState();
    rebuildDockingFaceGizmo();
  }

  function syncDockingFaceUiFromState() {
    document.querySelectorAll('.docking-face-btn').forEach((btn) => {
      btn.classList.toggle('selected', !!dockingFace && btn.dataset.faceAxis === dockingFace.axis);
    });
    dockingFaceDetail.style.display = dockingFace ? '' : 'none';
    if (!dockingFace) return;
    faceOffU.value = dockingFace.offsetU;
    faceOffV.value = dockingFace.offsetV;
    faceTiltU.value = dockingFace.tiltDeg.u;
    faceTiltV.value = dockingFace.tiltDeg.v;
    faceOffUVal.textContent = dockingFace.offsetU.toFixed(1);
    faceOffVVal.textContent = dockingFace.offsetV.toFixed(1);
    faceTiltUVal.textContent = `${Math.round(dockingFace.tiltDeg.u)}°`;
    faceTiltVVal.textContent = `${Math.round(dockingFace.tiltDeg.v)}°`;
  }

  document.querySelectorAll('.docking-face-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!modelRoot) return;
      const axis = btn.dataset.faceAxis;
      // 既に同じ面が選択されている場合はオフセット/傾きを維持したまま
      // 面だけ選び直せるようにする（誤タップでの値消失を避ける）。
      if (dockingFace && dockingFace.axis === axis) return;
      setDockingFace({
        axis,
        offsetU: 0,
        offsetV: 0,
        tiltDeg: { u: 0, v: 0 },
      });
    });
  });

  faceOffU.addEventListener('input', () => {
    if (!dockingFace) return;
    dockingFace.offsetU = Number(faceOffU.value);
    faceOffUVal.textContent = dockingFace.offsetU.toFixed(1);
    rebuildDockingFaceGizmo();
  });
  faceOffV.addEventListener('input', () => {
    if (!dockingFace) return;
    dockingFace.offsetV = Number(faceOffV.value);
    faceOffVVal.textContent = dockingFace.offsetV.toFixed(1);
    rebuildDockingFaceGizmo();
  });
  faceTiltU.addEventListener('input', () => {
    if (!dockingFace) return;
    dockingFace.tiltDeg.u = Number(faceTiltU.value);
    faceTiltUVal.textContent = `${faceTiltU.value}°`;
    rebuildDockingFaceGizmo();
  });
  faceTiltV.addEventListener('input', () => {
    if (!dockingFace) return;
    dockingFace.tiltDeg.v = Number(faceTiltV.value);
    faceTiltVVal.textContent = `${faceTiltV.value}°`;
    rebuildDockingFaceGizmo();
  });

  document.getElementById('clearDockingFaceBtn').addEventListener('click', () => {
    setDockingFace(null);
  });

  // ギズモ（選択面の半透明パネル＋外向き矢印）をcorrectionGroupの
  // 子として再構築する。correctionGroupの子にすることで、回転・
  // スケール・位置オフセットのスライダー操作にも自動追従する。
  function rebuildDockingFaceGizmo() {
    if (dockingFaceGizmo) {
      correctionGroup.remove(dockingFaceGizmo);
      dockingFaceGizmo.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      dockingFaceGizmo = null;
    }
    if (!dockingFace || !modelRoot) return;

    const halfExtents = computeCurrentHalfExtents();
    const local = computeDockingFaceLocalTransform(dockingFace, halfExtents);

    const group = new THREE.Group();
    group.position.set(local.position.x, local.position.y, local.position.z);
    group.quaternion.set(local.quaternion.x, local.quaternion.y, local.quaternion.z, local.quaternion.w);

    // パネルの大きさは、選ばれた面に応じたボックスの残り2辺のサイズを
    // 目安にする（面が小さすぎて見えない/大きすぎて隣の面にかぶる、
    // という事態を避けるための簡易ヒューリスティック）。
    let panelW = 4, panelH = 4;
    if (dockingFace.axis === 'px' || dockingFace.axis === 'nx') {
      panelW = 2 * halfExtents.z || 4; panelH = 2 * halfExtents.y || 4;
    } else if (dockingFace.axis === 'py' || dockingFace.axis === 'ny') {
      panelW = 2 * halfExtents.x || 4; panelH = 2 * halfExtents.z || 4;
    } else {
      panelW = 2 * halfExtents.x || 4; panelH = 2 * halfExtents.y || 4;
    }

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(panelW, panelH),
      new THREE.MeshBasicMaterial({
        color: 0x6cc3ff, transparent: true, opacity: 0.28,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    // 重要: computeDockingFaceLocalTransform()のquaternionは「艦ローカル
    // -Z軸(艦の前方基準)を面の外向き法線に向ける回転」として定義されて
    // いる（01-state-and-config.js参照、オートドッキングの目標姿勢計算
    // と共通の定義）。つまりgroup自体のローカル-Z方向が実際の面の外向き
    // 法線に一致する。一方PlaneGeometry/ArrowHelperはThree.jsの流儀で
    // デフォルトが+Z基準のため、そのままではパネル・矢印が面の内側
    // （艦の中心側）を向いてしまう。ここでgroup配下のローカル空間だけ
    // Y軸180度回転して帳尻を合わせ、外向き法線と一致させる。
    panel.rotation.y = Math.PI;
    group.add(panel);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(panel.geometry),
      new THREE.LineBasicMaterial({ color: 0x6cc3ff, transparent: true, opacity: 0.8 })
    );
    edges.rotation.y = Math.PI;
    group.add(edges);

    const arrowLen = Math.max(panelW, panelH) * 0.4;
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0),
      arrowLen, 0xffcc55, arrowLen * 0.3, arrowLen * 0.18
    );
    group.add(arrow);

    correctionGroup.add(group);
    dockingFaceGizmo = group;
  }

  // -----------------------------------------------------------
  // モデル読み込み
  // -----------------------------------------------------------
  function clearModelRoot() {
    if (modelRoot) {
      correctionGroup.remove(modelRoot);
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

  function frameCameraOnModel() {
    const box = new THREE.Box3().setFromObject(correctionGroup);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    orbitState.target.copy(center);
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    orbitState.radius = maxDim * 1.8;
    orbitState.orthoZoom = maxDim * 1.0;
  }

  function onModelLoadedIntoScene(root) {
    clearModelRoot();
    modelRoot = root;
    correctionGroup.add(modelRoot);
    applyAdjustToGroup();
    frameCameraOnModel();
    // 新しいモデル（差し替え含む）を読み込んだ直後は、以前のモデルの
    // 形状に基づいた接舷面はそのまま流用できないため一旦解除する。
    // 保存済みモデルの復元時(restoreExistingModel)は、この直後に
    // 呼び出し側が保存されていたdockingFaceを明示的に復元する。
    setDockingFace(null);

    emptyState.classList.add('hidden');
    adjustPanel.classList.add('visible');
    footerBar.style.display = '';
    viewportHint.style.display = '';
  }

  loadModelBtn.addEventListener('click', async () => {
    setStatus('読み込み中…', false);
    loadModelBtn.disabled = true;
    try {
      if (activeFormat === 'glb') {
        await loadGlbFromFile(pendingGlbFile);
      } else {
        await loadObjFromFiles(pendingObjFile, pendingMtlFile, pendingTexFiles);
      }
      setStatus('読み込み完了。向き・スケールを調整してください。', false);
    } catch (e) {
      console.error(e);
      setStatus(`読み込みに失敗しました: ${e.message || e}`, true);
    } finally {
      refreshLoadButtonEnabled();
    }
  });

  // GLTFLoaderは既定でテクスチャ読み込みにImageBitmapLoader
  // (createImageBitmap)を使うが、環境によってはこれがエラーも出さず
  // 内部で解決しないまま止まる（コールバックが永久に呼ばれない）
  // ことがあるため、確実に反応するTextureLoader(Image経由)に
  // 強制フォールバックさせる。あわせて、万一何らかの理由で
  // コールバックが呼ばれなかった場合に「読み込み中…」のまま
  // 固まって見えるのを防ぐため、タイムアウトで明示的に失敗させる。
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
            // 保存用にBase64も保持しておく（保存ボタン押下時に使用）
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

        // テクスチャをdata URL化し、MTLLoaderのLoadingManagerで
        // ファイル名解決をそのdata URLに差し替える（相対パス参照が
        // ローカルファイルシステムに存在しないため、素のURLでは
        // 解決できないことへの対処）
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

  function readFilesAsDataUrls(files) {
    const entries = (files || []).map((f) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error(`テクスチャ画像(${f.name})の読み込みに失敗しました`));
      r.onload = () => resolve([f.name, r.result]);
      r.readAsDataURL(f);
    }));
    return Promise.all(entries).then((pairs) => Object.fromEntries(pairs));
  }

  // -----------------------------------------------------------
  // 保存（艦種ごと）
  // -----------------------------------------------------------
  let pendingSaveFormat = null;
  let pendingSaveFileName = null;
  let pendingSaveGlbArrayBuffer = null;
  let pendingSaveObjText = null;
  let pendingSaveMtlText = null;
  let pendingSaveTextures = null;

  function arrayBufferToDataUrl(buffer, mimeType) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  document.getElementById('saveBtn').addEventListener('click', async () => {
    if (!pendingSaveFormat) {
      setStatus('保存できるモデルがありません。', true);
      return;
    }
    const saveBtnEl = document.getElementById('saveBtn');
    saveBtnEl.disabled = true;
    setStatus('保存中…', false);
    try {
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
          rotationDeg: { ...adjust.rotationDeg },
          scale: adjust.scale,
          offset: { ...adjust.offset },
        },
        // v61: 接舷面（ドッキングフェイス）。未設定ならnull。
        dockingFace: dockingFace
          ? {
              axis: dockingFace.axis,
              offsetU: dockingFace.offsetU,
              offsetV: dockingFace.offsetV,
              tiltDeg: { ...dockingFace.tiltDeg },
            }
          : null,
      };
      await saveShipModelData(classKey, data);
      setStatus(`${ShipClassPresets[classKey].label}にモデルを保存しました。`, false);
    } catch (e) {
      console.error(e);
      if (e && e.name === 'QuotaExceededError') {
        // v13: IndexedDBへ移行済みのため、この上限はlocalStorageより
        // はるかに大きい。それでも出る場合は端末のストレージ空き容量
        // 自体が不足している可能性が高い。
        setStatus('保存に失敗しました（容量不足）。端末のストレージ空き容量を確認するか、モデルのファイルサイズを小さくしてください。', true);
      } else {
        setStatus('保存に失敗しました。', true);
      }
    } finally {
      saveBtnEl.disabled = false;
    }
  });

  // v13: 「箱」（ドロップゾーン=emptyState）はモデル読み込み後に
  // hiddenのまま戻す手段が無く、削除（このモデルを削除して仮メッシュに
  // 戻す）以外でモデルを差し替えられなかった。この関数でドロップゾーン
  // を再表示する処理を共通化し、削除ボタンと新設の差し替えボタン
  // 両方から使えるようにする。
  function showDropzoneForReplace() {
    clearModelRoot();
    pendingSaveFormat = null;
    pendingSaveGlbArrayBuffer = null;
    pendingSaveObjText = null;
    pendingSaveMtlText = null;
    pendingSaveTextures = null;
    setDockingFace(null);

    emptyState.classList.remove('hidden');
    adjustPanel.classList.remove('visible');
    footerBar.style.display = 'none';
    viewportHint.style.display = 'none';
  }

  document.getElementById('removeModelBtn').addEventListener('click', async () => {
    try {
      await removeShipModelData(classKey);
      setStatus('モデルを削除しました。次回はゲーム内の仮メッシュが使われます。', false);
    } catch (e) {
      console.error(e);
      setStatus('モデルの削除に失敗しました。', true);
      return;
    }
    showDropzoneForReplace();
  });

  const replaceModelBtn = document.getElementById('replaceModelBtn');
  if (replaceModelBtn) {
    replaceModelBtn.addEventListener('click', () => {
      // 削除とは異なり、保存済みデータはまだ消さない。
      // ここで新しいファイルを読み込んで「保存」ボタンを押すまでは
      // 保存済みモデルはそのまま残る（読み込み失敗時のフォールバック）。
      showDropzoneForReplace();
      setStatus('新しいモデルをドロップまたは選択してください。まだ保存はされていません。', false);
    });
  }

  // -----------------------------------------------------------
  // 既存保存データがあれば起動時に復元
  // -----------------------------------------------------------
  async function restoreExistingModel() {
    setStatus('保存済みのモデルを確認しています…', false);
    let existing;
    try {
      existing = await loadShipModelData(classKey);
    } catch (e) {
      console.error(e);
      setStatus('保存済みモデルの読み込みに失敗しました。', true);
      return;
    }
    if (!existing) {
      setStatus('');
      return;
    }

    adjust.rotationDeg = { ...existing.adjust.rotationDeg };
    adjust.scale = existing.adjust.scale;
    adjust.offset = { ...existing.adjust.offset };
    syncRotUiFromState();
    syncScaleUiFromState();
    syncOffsetUiFromState();

    setStatus('保存済みのモデルを読み込んでいます…', false);

    if (existing.format === 'glb') {
      // v67: fetch(dataUrl)はiPad(iOS WebKit)で巨大なdata URLの読み込みに
      // 失敗することがあったため、atob直接デコード(dataUrlToArrayBuffer、
      // 01-state-and-config.js)に変更。
      try {
        const buf = dataUrlToArrayBuffer(existing.glbDataUrl);
        const loader = createRobustGltfLoader();
        loader.parse(buf, '', (gltf) => {
          onModelLoadedIntoScene(gltf.scene);
          pendingSaveFormat = 'glb';
          pendingSaveFileName = existing.fileName;
          pendingSaveGlbArrayBuffer = buf;
          // onModelLoadedIntoScene内で一旦nullに戻されるため、
          // 保存されていた接舷面をここで明示的に復元する。
          if (existing.dockingFace) setDockingFace({ ...existing.dockingFace, tiltDeg: { ...existing.dockingFace.tiltDeg } });
          setStatus('保存済みモデルを読み込みました。', false);
        }, (err) => setStatus('保存済みモデルの読み込みに失敗しました。', true));
      } catch (e) {
        console.error(e);
        setStatus('保存済みモデルの読み込みに失敗しました。', true);
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
        // onModelLoadedIntoScene内で一旦nullに戻されるため、
        // 保存されていた接舷面をここで明示的に復元する。
        if (existing.dockingFace) setDockingFace({ ...existing.dockingFace, tiltDeg: { ...existing.dockingFace.tiltDeg } });
        setStatus('保存済みモデルを読み込みました。', false);
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
  // 6方向固定視点ボタン（正面/背面/左/右/上/下、平行投影）
  // -----------------------------------------------------------
  const orthoButtons = Array.from(document.querySelectorAll('.ortho-view-btn'));
  function refreshOrthoButtons() {
    orthoButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.orthoFace === orbitState.ortho);
    });
  }
  orthoButtons.forEach((btn) => {
    btn.addEventListener('click', () => setOrthoView(btn.dataset.orthoFace));
  });

  const viewResetBtn = document.getElementById('viewResetBtn');
  if (viewResetBtn) {
    viewResetBtn.addEventListener('click', () => {
      orbitState.ortho = null;
      orbitState.theta = Math.PI * 0.25;
      orbitState.phi = Math.PI * 0.35;
      orbitState.target.set(0, 0, 0);
      if (modelRoot) frameCameraOnModel();
      refreshOrthoButtons();
    });
  }

  // -----------------------------------------------------------
  // 起動
  // -----------------------------------------------------------
  initScene();
  syncRotUiFromState();
  syncScaleUiFromState();
  syncOffsetUiFromState();
  restoreExistingModel();
})();
