// popup.js — Popup 界面逻辑

const $ = id => document.getElementById(id);

// ── 加载已保存的 Token ─────────────────────────
chrome.storage.local.get('sf_api_token', r => {
  if (r.sf_api_token) {
    $('token-input').value = r.sf_api_token;
  }
});

// ── 保存 Token ──────────────────────────────────
$('save-token').addEventListener('click', () => {
  const val = $('token-input').value.trim();
  if (!val) {
    showStatus('token-status', 'error', '❌ Token 不能为空');
    return;
  }
  chrome.storage.local.set({ sf_api_token: val }, () => {
    showStatus('token-status', 'ok', '✅ Token 已保存');
    // 同步通知当前 Sketchfab 页面
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'update_token', token: val })
          .catch(() => {});
      }
    });
  });
});

// ── 检测当前页面状态 ────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const tab = tabs[0];
  if (!tab) return;

  const url = tab.url || '';
  const uidMatch = url.match(/[a-f0-9]{32}/);

  if (!/sketchfab\.com\/(3d-models|models)\//.test(url)) {
    $('page-status').textContent = '❌ 非模型页面';
    $('page-status').style.color = '#666';
    return;
  }

  $('page-status').textContent = '✅ Sketchfab 模型页面';
  $('page-status').style.color = '#00c864';

  if (uidMatch) {
    $('page-uid').textContent = uidMatch[0];
  }

  // 询问 content script 已获取的文件数
  chrome.tabs.sendMessage(tab.id, { action: 'get_state' }, resp => {
    if (chrome.runtime.lastError || !resp) {
      $('file-count').textContent = '页面未完全加载';
      return;
    }
    const cnt = (resp.osgjsUrl ? 1 : 0) + (resp.modelFileUrl ? 1 : 0) + (resp.binzCount || 0);
    $('file-count').textContent = cnt > 0 ? `${cnt} 个文件已就绪` : '等待模型加载…';
  });
});

function showStatus(id, type, msg) {
  const el = $(id);
  if (!el) return;
  el.className = `status ${type}`;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}
