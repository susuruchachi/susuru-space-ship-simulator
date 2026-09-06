// 08-main.js — 起動処理・保存/読込UI・最終モデルの自動読込

function setupSaveLoadUI() {
  const btnSave = document.getElementById('btnSaveConfig');
  const btnLoadSaved = document.getElementById('btnLoadSaved');
  const statusEl = document.getElementById('saveStatus');

  btnSave.addEventListener('click', async () => {
    if (!State.model.root) {
      showToast('保存するにはまずモデルを読み込んでください', true);
      return;
    }
    let name = State.configName;
    const input = prompt('保存名を入力してください', name || State.model.name || 'default');
    if (input === null) return; // キャンセル
    name = input.trim() || 'default';

    statusEl.textContent = '保存中…';
    try {
      await saveCurrentConfig(name);
      statusEl.textContent = `「${name}」を保存しました（${formatNow()}）`;
      showToast('設定とモデルを保存しました');
    } catch (err) {
      console.error(err);
      statusEl.textContent = '保存に失敗しました';
      showToast('保存に失敗しました', true);
    }
  });

  btnLoadSaved.addEventListener('click', async () => {
    const configs = await listAllConfigs();
    if (configs.length === 0) {
      showToast('保存済みの設定がありません', true);
      return;
    }
    const listText = configs
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((c, i) => `${i + 1}. ${c.name}（${c.modelName || '不明'} / ${new Date(c.savedAt).toLocaleString('ja-JP')}）`)
      .join('\n');
    const choice = prompt(`読み込む設定の番号を入力してください:\n\n${listText}`, '1');
    if (choice === null) return;
    const idx = parseInt(choice, 10) - 1;
    const sorted = configs.sort((a, b) => b.savedAt - a.savedAt);
    const record = sorted[idx];
    if (!record) {
      showToast('番号が正しくありません', true);
      return;
    }
    await applyLoadedConfig(record);
  });
}

async function applyLoadedConfig(record) {
  try {
    await loadModelFromArrayBuffer(record.modelBuffer, record.modelName, record.modelFileType);
    rebuildPartsFromSaved(record.parts || []);
    State.configName = record.name;
    document.getElementById('saveStatus').textContent = `「${record.name}」を読み込みました`;
    showToast(`「${record.name}」を読み込みました`);
  } catch (err) {
    console.error(err);
    showToast('設定の読込に失敗しました', true);
  }
}

function formatNow() {
  return new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// 起動時：最後に開いた設定があれば自動読込
async function autoLoadLastConfig() {
  try {
    const lastName = await getLastConfigName();
    if (!lastName) return;
    const record = await loadConfigByName(lastName);
    if (record) {
      await applyLoadedConfig(record);
    }
  } catch (err) {
    console.warn('自動読込に失敗:', err);
  }
}

async function bootstrap() {
  try {
    initScene();
    setupModelLoaderUI();
    setupPartTypeButtons();
    setupGizmoUI();
    setupViewportPicking();
    setupSaveLoadUI();
    await autoLoadLastConfig();
  } catch (err) {
    console.error('初期化中にエラーが発生しました:', err);
    showToast('初期化に失敗しました。コンソールを確認してください', true);
  }
}

bootstrap();
