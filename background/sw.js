/**
 * background/sw.js — Service Worker v2
 *
 * 职责：
 * 1. webRequest 监听：记录 sketchfab.com 所有网络请求（帮助诊断）
 * 2. 直接请求 Sketchfab 模型 API，提取下载 URL
 * 3. 处理 content script 的下载请求
 */

const LOG = (...a) => console.log('[SF-DL SW]', ...a);

// ══════════════════════════════════════════════════════
// 1. webRequest 监听 — 记录所有 sketchfab.com 请求 URL
//    （帮助诊断模型资源加载路径）
// ══════════════════════════════════════════════════════

if (chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = details.url;
      // 只关注模型相关请求
      if (
        url.includes('.binz') ||
        url.includes('.osgjs') ||
        url.includes('.usdz') ||
        url.includes('model_file') ||
        url.includes('/i/models/') ||
        url.includes('/2.0/models/') ||
        (url.includes('sketchfab.com') && url.includes('file'))
      ) {
        LOG('🌐 拦截到模型资源:', url.slice(0, 200), 'type:', details.type);
        // 通知所有 sketchfab tab
        notifyTabs({ type: 'networkRequest', url, resourceType: details.type });
      }
    },
    {
      urls: [
        'https://sketchfab.com/*',
        'https://*.sketchfab.com/*',
        'https://media.sketchfab.com/*',
        'https://*.amazonaws.com/*',
        'https://*.cloudfront.net/*'
      ]
    }
  );
  LOG('webRequest listener installed ✓');
}

// ══════════════════════════════════════════════════════
// 工具：通知所有 sketchfab tab
// ══════════════════════════════════════════════════════

async function notifyTabs(msg) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://sketchfab.com/*' });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    }
  } catch (e) {
    LOG('notifyTabs error:', e.message);
  }
}

// ══════════════════════════════════════════════════════
// 2. 直接调用 Sketchfab API 获取模型信息
//    背景：SW 不受 CSP 限制，可以自由 fetch
// ══════════════════════════════════════════════════════

async function fetchModelInfo(uid) {
  LOG('fetchModelInfo uid:', uid);

  // 尝试多个 API 端点
  const endpoints = [
    `https://sketchfab.com/i/models/${uid}`,
    `https://sketchfab.com/2.0/models/${uid}`,
    `https://api.sketchfab.com/v3/models/${uid}`,
  ];

  for (const url of endpoints) {
    try {
      LOG('尝试 API:', url);
      const resp = await fetch(url, {
        credentials: 'include',  // 携带用户登录 cookie
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        }
      });

      if (!resp.ok) {
        LOG(`API ${url} 返回 ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      LOG('API 响应:', JSON.stringify(data).slice(0, 500));
      return { url, data };
    } catch (e) {
      LOG(`API ${url} 失败:`, e.message);
    }
  }
  return null;
}

// 提取模型下载 URL
function extractModelUrls(data) {
  const urls = {};

  // 递归搜索所有包含 URL 的字段
  function traverse(obj, path = '') {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && (
        v.includes('.binz') || v.includes('.osgjs') || v.includes('.glb') ||
        v.includes('.gltf') || v.includes('.usdz') || v.includes('model_file') ||
        (v.startsWith('http') && v.includes('sketchfab'))
      )) {
        urls[p] = v;
        LOG(`找到模型 URL [${p}]:`, v.slice(0, 100));
      } else if (typeof v === 'object') {
        traverse(v, p);
      }
    }
  }

  traverse(data);
  return urls;
}

// ══════════════════════════════════════════════════════
// 3. 消息处理
// ══════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 下载文件
  if (msg.action === 'download') {
    chrome.downloads.download(
      {
        url: msg.url,
        filename: msg.filename || 'sketchfab_model',
        saveAs: false,
        conflictAction: 'uniquify',
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          LOG('下载失败:', chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          LOG('下载已启动, ID:', downloadId);
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true;
  }

  // 获取模型信息（content script 发起）
  if (msg.action === 'getModelInfo') {
    const uid = msg.uid;
    if (!uid) { sendResponse({ ok: false, error: 'no uid' }); return true; }

    fetchModelInfo(uid).then(result => {
      if (!result) {
        sendResponse({ ok: false, error: 'all API endpoints failed' });
        return;
      }
      const modelUrls = extractModelUrls(result.data);
      sendResponse({ ok: true, data: result.data, modelUrls, apiUrl: result.url });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  // 诊断：直接 fetch 任意 URL（content script 请求时用）
  if (msg.action === 'proxyFetch') {
    const { url, options } = msg;
    fetch(url, options || { credentials: 'include' })
      .then(r => r.text())
      .then(text => sendResponse({ ok: true, text: text.slice(0, 5000) }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

});

LOG('service worker v2 ready ✓');
