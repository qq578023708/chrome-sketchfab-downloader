function isModelDetailPage() {
  return /sketchfab\.com\/(3d-models\/[^/?#]+-|models\/)([a-f0-9]{32})/.test(location.href);
}

if (!isModelDetailPage()) {
  // 非模型详情页，不挂载任何逻辑
} else {

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'networkRequest' && msg.url) {
    const url = msg.url;
    if (url.includes('.binz') || url.includes('model_file') || url.includes('.osgjs')) {
      parseModelData({ files: [{ osgjsUrl: url, url: url }] });
    }
  }
});

window.addEventListener('message', (e) => {
  if (!e.data || !e.data.__sfDl) return;

  if (e.data.action === 'getModelInfo') {
    const uid = e.data.uid;
    const iframeWindow = e.source;

    chrome.runtime.sendMessage({ action: 'getModelInfo', uid }, (resp) => {
      if (chrome.runtime.lastError) {
        const errResp = { __sfDlReply: true, action: 'modelInfoResult',
          ok: false, error: chrome.runtime.lastError.message };
        if (iframeWindow) iframeWindow.postMessage(errResp, '*');
        return;
      }

      const reply = { __sfDlReply: true, action: 'modelInfoResult', ...(resp || {}) };
      if (iframeWindow) iframeWindow.postMessage(reply, '*');

      if (resp && resp.ok && resp.data) {
        parseModelData(resp.data);
      }
    });
  }
});

const STATE = {
  uid: null,
  modelName: '',
  fileEntries: [],
  binzUrls: [],
  decryptedBuffers: [],
  apiToken: '',
  panelMounted: false,
  probing: false,
  _pendingUpdate: false,
};

chrome.storage.local.get('sf_api_token', r => {
  STATE.apiToken = r.sf_api_token || '';
  const input = document.getElementById('sf-token-input');
  if (input) input.value = STATE.apiToken;
});

window.addEventListener('SF_MODEL_DATA', e => parseModelData(e.detail));

window.addEventListener('SF_DECRYPTED_BUFFER', e => {
  const { taskId, buffer, size, ext = '.bin', magic = '??' } = e.detail;
  if (size < 1024) return;
  const name = `model_decrypted_${taskId}${ext}`;
  const existing = STATE.decryptedBuffers.findIndex(b => b.taskId === taskId);
  if (existing >= 0) {
    STATE.decryptedBuffers[existing] = { name, buffer, size, taskId, ext, magic };
  } else {
    STATE.decryptedBuffers.push({ name, buffer, size, taskId, ext, magic });
  }
  updatePanel();
  showToast(`✅ 解密完成！${(size / 1024 / 1024).toFixed(1)} MB (${ext})，可下载`);
});

window.addEventListener('SF_BINZ_DOWNLOADED', e => {
  const { buffer } = e.detail;
  setStatus(`📦 已捕获加密文件 ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB，等待 wasm 解密…`);
});

function parseModelData(data) {
  if (!data || typeof data !== 'object') return;
  let changed = false;

  if (data.name && !STATE.modelName) {
    STATE.modelName = data.name;
    changed = true;
  }

  let filesArr = [];
  if (Array.isArray(data.files)) {
    filesArr = data.files;
  } else if (data.files && typeof data.files === 'object') {
    filesArr = Object.values(data.files);
  }

  const urls = new Set(STATE.binzUrls);
  let newEntries = [...STATE.fileEntries];

  filesArr.forEach(f => {
    if (!f || typeof f !== 'object') return;
    const u = f.osgjsUrl || f.modelFileUrl || f.modelFile || f.url || f.downloadUrl || f.archiveUrl;
    if (u && typeof u === 'string') urls.add(u);
    if (!newEntries.some(e => (e.osgjsUrl || e.modelFileUrl || e.url) === u)) {
      newEntries.push(f);
    }
  });

  if (newEntries.length > STATE.fileEntries.length || urls.size > STATE.binzUrls.length) {
    STATE.fileEntries = newEntries;
    STATE.binzUrls = [...urls];
    changed = true;
  }

  if (changed) {
    if (!STATE.panelMounted) {
      STATE._pendingUpdate = true;
    } else {
      updatePanel();
    }
  }
}

function getUid() {
  const m = location.href.match(/([a-f0-9]{32})/);
  return m ? m[1] : null;
}

function initPanel() {
  if (STATE.panelMounted) return;
  STATE.panelMounted = true;
  STATE.uid = getUid();

  injectStyles();
  const panel = document.createElement('div');
  panel.id = 'sf-dl-panel';
  panel.innerHTML = buildHTML();
  document.body.appendChild(panel);
  bindEvents();

  if (STATE._pendingUpdate) {
    STATE._pendingUpdate = false;
    updatePanel();
  }

  if (STATE.uid) {
    setTimeout(() => probeAPI(), 600);
    [4000, 10000].forEach(d => setTimeout(() => { if (!hasData()) probeAPI(); }, d));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPanel);
} else {
  initPanel();
}

async function probeAPI() {
  if (!STATE.uid || STATE.probing) return;
  STATE.probing = true;
  setStatus('⟳ 正在获取模型数据…');
  try {
    const resp = await fetch(`https://sketchfab.com/i/models/${STATE.uid}`, {
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
    if (resp.ok) {
      const data = await resp.json();
      parseModelData(data);
      setStatus(hasData() ? '' : '⚠️ 未找到文件 URL，等待模型加载…');
    } else {
      setStatus(`⚠️ API 返回 ${resp.status}`);
    }
  } catch (e) {
    setStatus(`⚠️ 请求失败: ${e.message}`);
  }
  STATE.probing = false;
}

function hasData() {
  return STATE.binzUrls.length > 0 || STATE.fileEntries.length > 0 || STATE.decryptedBuffers.length > 0;
}

function triggerDownload(url, filename) {
  chrome.runtime.sendMessage({ action: 'download', url, filename });
  showProgressSection(filename);
}

function downloadDecryptedBuffer(idx) {
  const entry = STATE.decryptedBuffers[idx];
  if (!entry) return;
  const blob = new Blob([entry.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = entry.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function sanitize(name) {
  return (name || 'model').replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 80);
}

function downloadGltf() {
  if (!STATE.apiToken) {
    showStatus('sf-gltf-status', 'error', '❌ 请先填写并保存 API Token');
    return;
  }
  showStatus('sf-gltf-status', 'info', '⏳ 请求下载链接…');
  fetch(`https://api.sketchfab.com/v3/models/${STATE.uid}/download`, {
    headers: { Authorization: `Token ${STATE.apiToken}` },
  })
    .then(r => {
      if (r.status === 401) throw new Error('Token 无效，请重新填写');
      if (r.status === 403) throw new Error('此模型不允许下载（可能需购买）');
      return r.json();
    })
    .then(data => {
      const gltf = data.gltf || data.source;
      if (!gltf?.url) throw new Error('未获取到下载链接');
      const mb = ((gltf.size || 0) / 1024 / 1024).toFixed(1);
      showStatus('sf-gltf-status', 'ok', `✅ ${mb} MB，正在下载…`);
      triggerDownload(gltf.url, `${sanitize(STATE.modelName || STATE.uid)}.zip`);
    })
    .catch(e => showStatus('sf-gltf-status', 'error', `❌ ${e.message}`));
}

function buildHTML() {
  return `
    <div id="sf-dl-drawer">
      <div class="sf-drawer-header">
        <h3 id="sf-model-title">Sketchfab 模型下载</h3>
        <button class="sf-close-btn" id="sf-close">✕</button>
      </div>

      <div class="sf-section" id="sf-decrypted-section" style="display:none">
        <div class="sf-section-title">✅ 已解密文件（直接可用）</div>
        <div id="sf-decrypted-files"></div>
        <div class="sf-hint-box" id="sf-format-hint">
          💡 <b>.bin.gz</b> = gzip 压缩的 OSG 二进制格式，用 <b>7-Zip</b> 解压后可用 Blender OSG 插件打开<br>
          <b>.bin</b> / <b>.osgb</b> = OSG 二进制格式，可直接用 Blender OSG 插件打开，无需解压
        </div>
      </div>

      <div class="sf-section">
        <div class="sf-section-title">📦 原始文件（加密状态）
          <button class="sf-btn sf-btn-ghost" id="sf-refresh" style="float:right;padding:2px 10px;font-size:11px">⟳ 刷新</button>
        </div>
        <div id="sf-scan-status" class="sf-scan-hint" style="margin-bottom:6px">
          <span class="spin">⟳</span> <span id="sf-scan-msg">正在获取数据…</span>
        </div>
        <div class="sf-hint-box" style="margin-bottom:8px">
          💡 binz 经过加密，<b>请让模型完整加载到页面</b>，wasm 解密完成后将自动出现在上方
        </div>
        <div id="sf-raw-files"></div>
      </div>

      <div class="sf-section">
        <div class="sf-section-title">🔑 官方 glTF 下载（需 API Token）</div>
        <div class="sf-input-row" style="margin-bottom:8px">
          <input class="sf-input" id="sf-token-input" type="password"
            placeholder="sketchfab.com/settings/password → API Token">
          <button class="sf-btn sf-btn-ghost" id="sf-token-save">保存</button>
        </div>
        <div class="sf-file-row">
          <div class="sf-file-info">
            <span class="sf-file-icon">📐</span>
            <span class="sf-file-name">model.zip（glTF 格式，含贴图）</span>
            <span class="sf-file-tag tag-gltf">glTF</span>
          </div>
          <button class="sf-btn sf-btn-primary" id="sf-dl-gltf">下载</button>
        </div>
        <div id="sf-gltf-status" class="sf-status" style="display:none"></div>
      </div>

      <div class="sf-section" id="sf-progress-section" style="display:none">
        <div class="sf-section-title">📥 下载进度</div>
        <div id="sf-progress-label" style="color:#888;font-size:12px;margin-bottom:6px">准备中…</div>
        <div class="sf-progress-wrap"><div class="sf-progress-bar" id="sf-bar"></div></div>
      </div>

      <div class="sf-section">
        <div class="sf-section-title">ℹ️ 模型 UID</div>
        <code style="color:#00d4ff;font-size:11px;word-break:break-all" id="sf-uid-display">${getUid() || '—'}</code>
        <button class="sf-copy-btn" id="sf-copy-uid" style="margin-left:6px">⎘</button>
      </div>
    </div>
    <button id="sf-dl-toggle">
      <span class="icon">⬇️</span>
      <span class="label">下载模型</span>
      <span class="badge" id="sf-badge">…</span>
    </button>
  `;
}

function bindEvents() {
  const $ = id => document.getElementById(id);
  $('sf-dl-toggle').addEventListener('click', () => $('sf-dl-drawer').classList.toggle('open'));
  $('sf-close').addEventListener('click', () => $('sf-dl-drawer').classList.remove('open'));
  $('sf-token-save').addEventListener('click', () => {
    const v = $('sf-token-input').value.trim();
    STATE.apiToken = v;
    chrome.storage.local.set({ sf_api_token: v });
    showToast('Token 已保存');
  });
  $('sf-dl-gltf').addEventListener('click', downloadGltf);
  $('sf-copy-uid').addEventListener('click', () => {
    if (STATE.uid) navigator.clipboard.writeText(STATE.uid).then(() => showToast('UID 已复制'));
  });
  $('sf-refresh').addEventListener('click', () => {
    STATE.probing = false;
    probeAPI();
  });
}

function updatePanel() {
  if (STATE.modelName) {
    const t = document.getElementById('sf-model-title');
    if (t) t.textContent = STATE.modelName;
  }

  const badge = document.getElementById('sf-badge');
  const total = STATE.decryptedBuffers.length + STATE.binzUrls.length;
  if (badge) badge.textContent = total > 0 ? `${total} 个文件` : '扫描中';

  const decryptedSection = document.getElementById('sf-decrypted-section');
  const decryptedFiles = document.getElementById('sf-decrypted-files');
  if (decryptedSection && decryptedFiles) {
    if (STATE.decryptedBuffers.length > 0) {
      decryptedSection.style.display = '';
      const hint = document.getElementById('sf-format-hint');
      if (hint) {
        const hasGz   = STATE.decryptedBuffers.some(e => e.ext === '.bin.gz');
        const hasOsgb = STATE.decryptedBuffers.some(e => e.ext === '.osgb');
        const hasOsgjs= STATE.decryptedBuffers.some(e => e.ext === '.osgjs');
        const hasBin  = STATE.decryptedBuffers.some(e => e.ext === '.bin');
        let hintLines = [];
        if (hasGz)    hintLines.push('💡 <b>.bin.gz</b> = gzip 压缩的 OSG 格式，请用 <b>7-Zip</b> 解压（WinRAR 可能报错），解压后用 Blender OSG 插件打开');
        if (hasOsgb)  hintLines.push('💡 <b>.osgb</b> = OSG binary 格式，可直接用 Blender OSG 插件打开，无需解压');
        if (hasOsgjs) hintLines.push('💡 <b>.osgjs</b> = OSG JSON 场景图，可直接用 Blender <b>OSGJS 插件</b>打开，是完整可用的模型文件');
        if (hasBin)   hintLines.push('💡 <b>.bin</b> = 解密后原始数据（格式未能识别），可尝试用十六进制编辑器查看头部字节');
        hint.innerHTML = hintLines.join('<br>') || hint.innerHTML;
      }
      decryptedFiles.innerHTML = STATE.decryptedBuffers.map((entry, idx) => {
        const ext = entry.ext || '.bin';
        const tagClass = ext === '.bin.gz' ? 'tag-gz'
                       : ext === '.osgb'   ? 'tag-osgb'
                       : ext === '.osgjs'  ? 'tag-osgjs'
                       : ext === '.glb'    ? 'tag-gltf'
                       : 'tag-bin';
        const tagLabel = ext.replace('.', '');
        return `
        <div class="sf-file-row">
          <div class="sf-file-info">
            <span class="sf-file-icon">🔓</span>
            <div style="min-width:0">
              <div class="sf-file-name" title="${entry.name}">${entry.name}</div>
              <div class="sf-url-mini">${(entry.size / 1024 / 1024).toFixed(2)} MB · 魔数 ${entry.magic || '?'}</div>
            </div>
            <span class="sf-file-tag ${tagClass}">${tagLabel}</span>
          </div>
          <button class="sf-btn sf-btn-primary" data-decrypt-idx="${idx}">💾 保存</button>
        </div>`;
      }).join('');
      decryptedFiles.querySelectorAll('[data-decrypt-idx]').forEach(btn => {
        btn.addEventListener('click', () => downloadDecryptedBuffer(parseInt(btn.dataset.decryptIdx)));
      });
    } else {
      decryptedSection.style.display = 'none';
    }
  }

  const raw = document.getElementById('sf-raw-files');
  if (!raw) return;

  let html = '';
  const renderedUrls = new Set();
  STATE.fileEntries.forEach((f, i) => {
    const url = f.osgjsUrl || f.modelFileUrl || f.modelFile || f.url || f.downloadUrl;
    if (!url) return;
    renderedUrls.add(url);
    const filename = url.split('/').pop().split('?')[0] || `file_${i}`;
    const sizeBytes = f.size || f.osgjsSize || f.modelFileSize || 0;
    const sizeStr = sizeBytes ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB（加密）` : '（加密）';
    html += `
      <div class="sf-file-row">
        <div class="sf-file-info">
          <span class="sf-file-icon">🔒</span>
          <div style="min-width:0">
            <div class="sf-file-name" title="${url}">${filename}</div>
            <div class="sf-url-mini">${sizeStr}</div>
          </div>
          <span class="sf-file-tag tag-binz">binz</span>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="sf-btn sf-btn-ghost" data-copy="${url}" title="复制链接">⎘ 复制</button>
          <button class="sf-btn sf-btn-primary" data-dl="${url}" data-name="${filename}" title="直接下载（加密）">⬇ 下载</button>
        </div>
      </div>`;
  });

  STATE.binzUrls.filter(u => !renderedUrls.has(u)).forEach(u => {
    const filename = u.split('/').pop().split('?')[0] || 'model_file.binz';
    html += `
      <div class="sf-file-row">
        <div class="sf-file-info">
          <span class="sf-file-icon">🔒</span>
          <div style="min-width:0">
            <div class="sf-file-name" title="${u}">${filename}</div>
            <div class="sf-url-mini">（加密）</div>
          </div>
          <span class="sf-file-tag tag-binz">binz</span>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="sf-btn sf-btn-ghost" data-copy="${u}">⎘ 复制</button>
          <button class="sf-btn sf-btn-primary" data-dl="${u}" data-name="${filename}">⬇ 下载</button>
        </div>
      </div>`;
  });

  if (!html) {
    html = `<div class="sf-scan-hint" style="color:#555">
      等待 wasm 解密完成…（模型需在页面中完整加载）
    </div>`;
  }

  raw.innerHTML = html;
  raw.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).then(() => showToast('链接已复制'));
    });
  });
  raw.querySelectorAll('[data-dl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.dl;
      const name = btn.dataset.name || 'model_file.binz';
      triggerDownload(url, name);
      showToast(`⬇️ 开始下载: ${name}`);
    });
  });

  if (hasData()) {
    const scanEl = document.getElementById('sf-scan-status');
    if (scanEl) scanEl.style.display = 'none';
  }
}

function setStatus(msg) {
  const el = document.getElementById('sf-scan-msg');
  if (el) el.textContent = msg;
  const wrap = document.getElementById('sf-scan-status');
  if (wrap) wrap.style.display = msg ? '' : 'none';
}

function showStatus(id, type, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `sf-status ${type}`;
  el.textContent = msg;
  el.style.display = 'flex';
}

function showProgressSection(label) {
  const s = document.getElementById('sf-progress-section');
  if (s) s.style.display = '';
  const bar = document.getElementById('sf-bar');
  if (bar) bar.style.width = '30%';
  const lbl = document.getElementById('sf-progress-label');
  if (lbl) lbl.textContent = `⬇️ 下载中: ${label}`;
}

function showToast(msg) {
  const t = document.createElement('div');
  Object.assign(t.style, {
    position: 'fixed', bottom: '90px', right: '24px',
    background: '#1a2a3a', color: '#00d4ff',
    border: '1px solid rgba(0,212,255,0.3)',
    borderRadius: '8px', padding: '8px 16px',
    fontSize: '13px', zIndex: '100001',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    pointerEvents: 'none',
  });
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    #sf-dl-panel{position:fixed;bottom:24px;right:24px;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px}
    #sf-dl-toggle{display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#e0e0e0;border:1px solid rgba(100,220,255,.3);border-radius:50px;padding:10px 18px;cursor:pointer;box-shadow:0 4px 24px rgba(0,0,0,.5);transition:all .25s;user-select:none}
    #sf-dl-toggle:hover{border-color:rgba(100,220,255,.6);transform:translateY(-2px);box-shadow:0 6px 32px rgba(0,0,0,.6)}
    #sf-dl-toggle .icon{font-size:16px} #sf-dl-toggle .label{font-weight:600}
    #sf-dl-toggle .badge{background:#00d4ff;color:#0a0a1a;border-radius:20px;padding:1px 8px;font-size:11px;font-weight:700}
    #sf-dl-drawer{display:none;flex-direction:column;background:#0d1117;border:1px solid rgba(100,220,255,.2);border-radius:16px;margin-bottom:10px;min-width:400px;max-width:460px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.7)}
    #sf-dl-drawer.open{display:flex;animation:sf-up .25s cubic-bezier(.16,1,.3,1)}
    @keyframes sf-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
    .sf-drawer-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(100,220,255,.04);position:sticky;top:0;z-index:2}
    .sf-drawer-header h3{margin:0;color:#e0e0e0;font-size:14px;font-weight:700;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sf-close-btn{background:none;border:none;color:#555;font-size:18px;cursor:pointer;padding:0 4px}.sf-close-btn:hover{color:#aaa}
    .sf-section{padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.04)}.sf-section:last-child{border-bottom:none}
    .sf-section-title{color:#888;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
    .sf-file-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding:8px 10px;background:rgba(255,255,255,.02);border-radius:8px;border:1px solid rgba(255,255,255,.04)}
    .sf-file-row:last-child{margin-bottom:0}
    .sf-file-info{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
    .sf-file-icon{font-size:15px;flex-shrink:0}
    .sf-file-name{color:#c9d1d9;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
    .sf-url-mini{color:#444;font-size:10px;margin-top:1px}
    .sf-file-tag{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600;flex-shrink:0}
    .tag-gz{background:rgba(255,180,0,.12);color:#ffb400;border:1px solid rgba(255,180,0,.25)}
    .tag-osgb{background:rgba(0,200,150,.12);color:#00c896;border:1px solid rgba(0,200,150,.25)}
    .tag-osgjs{background:rgba(100,160,255,.12);color:#64a0ff;border:1px solid rgba(100,160,255,.25)}
    .tag-bin{background:rgba(180,180,180,.12);color:#aaa;border:1px solid rgba(180,180,180,.25)}
    .tag-gltf{background:rgba(0,200,100,.12);color:#00c864;border:1px solid rgba(0,200,100,.25)}
    .tag-binz{background:rgba(200,100,255,.12);color:#c864ff;border:1px solid rgba(200,100,255,.25)}
    .sf-btn{display:inline-flex;align-items:center;justify-content:center;padding:5px 12px;border-radius:6px;border:none;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;flex-shrink:0}
    .sf-btn-primary{background:linear-gradient(135deg,#00b4ff,#0066ff);color:#fff}.sf-btn-primary:hover{transform:translateY(-1px);box-shadow:0 3px 10px rgba(0,150,255,.3)}
    .sf-btn-ghost{background:rgba(255,255,255,.06);color:#aaa;border:1px solid rgba(255,255,255,.1)}.sf-btn-ghost:hover{background:rgba(255,255,255,.1);color:#ddd}
    .sf-input-row{display:flex;gap:8px;align-items:center}
    .sf-input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:6px 10px;color:#c9d1d9;font-size:12px;outline:none}.sf-input:focus{border-color:rgba(0,180,255,.4)}.sf-input::placeholder{color:#444}
    .sf-status{align-items:center;gap:8px;padding:8px 12px;border-radius:8px;font-size:12px;margin-top:8px}
    .sf-status.info{display:flex;background:rgba(0,180,255,.07);color:#00b4ff;border:1px solid rgba(0,180,255,.2)}
    .sf-status.ok{display:flex;background:rgba(0,200,100,.07);color:#00c864;border:1px solid rgba(0,200,100,.2)}
    .sf-status.error{display:flex;background:rgba(255,80,80,.07);color:#ff6060;border:1px solid rgba(255,80,80,.2)}
    .sf-progress-wrap{background:rgba(255,255,255,.05);border-radius:4px;height:4px;overflow:hidden;margin-top:6px}
    .sf-progress-bar{height:100%;background:linear-gradient(90deg,#00b4ff,#0066ff);border-radius:4px;transition:width .4s;width:0}
    .sf-scan-hint{color:#666;font-size:11px;text-align:center;padding:10px 0 4px}
    .sf-scan-hint .spin,.spin{display:inline-block;animation:sf-spin 1s linear infinite}
    @keyframes sf-spin{to{transform:rotate(360deg)}}
    .sf-copy-btn{background:none;border:none;color:#555;cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px}.sf-copy-btn:hover{color:#aaa}
    .sf-hint-box{background:rgba(0,180,255,.05);border:1px solid rgba(0,180,255,.15);border-radius:8px;padding:8px 12px;font-size:11px;color:#888;line-height:1.5;margin-bottom:4px}
    .sf-hint-box b{color:#aaa}
  `;
  document.head.appendChild(style);
}

} // end isModelDetailPage

