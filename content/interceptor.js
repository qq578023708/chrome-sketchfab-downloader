(function () {
  if (window.__SF_DL_INJECTED__) return;

  function isModelDetailPage() {
    const href = location.href;
    return /sketchfab\.com\/(3d-models\/[^/?#]+-|models\/)([a-f0-9]{32})/.test(href);
  }

  if (!isModelDetailPage()) return;

  window.__SF_DL_INJECTED__ = true;

  const WORKER_PROBE_CODE = `
(function() {
  if (self.__SF_PROBE__) return;
  self.__SF_PROBE__ = true;

  let _bc = null;
  try {
    _bc = new BroadcastChannel('__sf_dl_probe__');
  } catch(e) {}

  function bcSend(payload) {
    if (!_bc) return;
    try { _bc.postMessage(payload); } catch(e) {}
  }

  function extractBigABs(msg, transferList) {
    const found = [];
    const transferredBuffers = new Set();
    if (Array.isArray(transferList)) {
      transferList.forEach(t => {
        if (t instanceof ArrayBuffer && t.byteLength > 1024) {
          transferredBuffers.add(t);
          try { found.push({ ab: t.slice(0), src: 'transfer' }); } catch(_) {}
        }
      });
    }
    function walk(v) {
      if (!v) return;
      if (v instanceof ArrayBuffer && v.byteLength > 1024) {
        if (!transferredBuffers.has(v)) {
          try { found.push({ ab: v.slice(0), src: 'msg' }); } catch(_) {}
        }
        return;
      }
      if (ArrayBuffer.isView(v) && !(v instanceof DataView) && v.byteLength > 1024) {
        if (!transferredBuffers.has(v.buffer)) {
          try { found.push({ ab: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), src: 'view' }); } catch(_) {}
        }
        return;
      }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        try { Object.values(v).forEach(walk); } catch(_) {}
      }
    }
    walk(msg);
    return found;
  }

  const _wOrigPost = self.postMessage.bind(self);
  let _wPostSeq = 0;
  self.postMessage = function(msg, transferOrOpts) {
    let tl = [];
    if (Array.isArray(transferOrOpts)) tl = transferOrOpts;
    else if (transferOrOpts && Array.isArray(transferOrOpts.transfer)) tl = transferOrOpts.transfer;

    try {
      const bigABs = extractBigABs(msg, tl);
      if (bigABs.length > 0) {
        const total = bigABs.reduce((s, x) => s + x.ab.byteLength, 0);
        const seq = ++_wPostSeq;
        bigABs.forEach((x, i) => {
          bcSend({ type: 'decrypt', seq: seq, idx: i, total: bigABs.length,
                   bytes: total, byteLength: x.ab.byteLength, src: x.src, buf: x.ab });
        });
      }
    } catch(_) {}

    return _wOrigPost.apply(self, arguments);
  };

  const _wOrigAddEL = self.addEventListener.bind(self);
  self.addEventListener = function(type, handler, opts) {
    return _wOrigAddEL(type, handler, opts);
  };

  const _wOrigFetch = self.fetch;
  if (_wOrigFetch) {
    self.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0]
                : (args[0] && args[0].url ? args[0].url : String(args[0]));
      const resp = await _wOrigFetch.apply(this, args);
      if (url.includes('.binz') || url.includes('model_file') || url.includes('.usdz')) {
        resp.clone().arrayBuffer().then(ab => {
          bcSend({ type: 'binzUrl', url: url, byteLength: ab.byteLength });
        }).catch(() => {});
      }
      return resp;
    };
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    const _wXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, url) {
      this.__sfUrl = url || '';
      return _wXhrOpen.apply(this, arguments);
    };
    const _wXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
      const xhr = this;
      if (xhr.__sfUrl && (xhr.__sfUrl.includes('.binz') || xhr.__sfUrl.includes('model_file'))) {
        xhr.addEventListener('load', function() {
          if (xhr.response instanceof ArrayBuffer) {
            bcSend({ type: 'binzUrl', url: xhr.__sfUrl, byteLength: xhr.response.byteLength });
          }
        });
      }
      return _wXhrSend.apply(this, arguments);
    };
  }

  if (typeof MessageChannel !== 'undefined') {
    const _wOrigMC = MessageChannel;
    let _wMCCnt = 0;
    self.MessageChannel = function() {
      const ch = new _wOrigMC();
      const cid = ++_wMCCnt;
      ['port1','port2'].forEach(function(pn) {
        const port = ch[pn];
        const _oAEL = port.addEventListener.bind(port);
        port.addEventListener = function(type, handler, opts) {
          if (type === 'message') {
            const wrapped = function(evt) {
              try {
                const bigABs = extractBigABs(evt.data, []);
                bigABs.forEach((x, i) => {
                  bcSend({ type: 'decrypt', idx: i, total: bigABs.length,
                           bytes: x.ab.byteLength, byteLength: x.ab.byteLength,
                           src: 'MC#' + cid + '.' + pn, buf: x.ab });
                });
              } catch(_) {}
              handler.call(this, evt);
            };
            return _oAEL(type, wrapped, opts);
          }
          return _oAEL(type, handler, opts);
        };
      });
      return ch;
    };
  }

  if (typeof importScripts !== 'undefined') {
    const _wOrigIS = importScripts;
    self.importScripts = function(...urls) {
      return _wOrigIS.apply(self, arguments);
    };
  }

  if (typeof WebAssembly !== 'undefined') {
    ['instantiate','compile'].forEach(fn => {
      if (!WebAssembly[fn]) return;
      const orig = WebAssembly[fn];
      WebAssembly[fn] = function() {
        return orig.apply(WebAssembly, arguments);
      };
    });
    if (WebAssembly.instantiateStreaming) {
      const orig = WebAssembly.instantiateStreaming;
      WebAssembly.instantiateStreaming = function() {
        return orig.apply(WebAssembly, arguments);
      };
    }
  }

  if (typeof URL !== 'undefined' && URL.createObjectURL) {
    const _wOrigCOU = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(obj) {
      return _wOrigCOU(obj);
    };
  }
})();
`;

  const _state = {};
  let _flushCount = 0;

  const OSG_MAGIC_LOW  = [0xa1, 0x0e, 0x91, 0x6c];
  const OSG_MAGIC_HIGH = [0x45, 0x45, 0xfb, 0x1a];

  function detectExt(u8) {
    if (u8.byteLength >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) return '.bin.gz';
    if (u8.byteLength >= 4 && u8[0] === 0x50 && u8[1] === 0x4b) return '.zip';
    if (u8.byteLength >= 8) {
      const lowOk  = OSG_MAGIC_LOW.every((b, i) => u8[i]   === b);
      const highOk = OSG_MAGIC_HIGH.every((b, i) => u8[i+4] === b);
      if (lowOk && highOk) return '.osgb';
    }
    if (u8.byteLength >= 4) {
      const hdr = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
      if (hdr.includes('OSG') || u8[0] === 0xAB) return '.osgb';
    }
    if (u8.byteLength >= 4 &&
        u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) return '.glb';
    if (u8[0] === 0x7b || u8[0] === 0x20 || u8[0] === 0x0a || u8[0] === 0x0d) {
      const sample = String.fromCharCode(...u8.subarray(0, Math.min(512, u8.byteLength)));
      if (sample.includes('"osg.') || sample.includes('"Generator"') ||
          sample.includes('OpenSceneGraph') || sample.includes('"osg_node"')) {
        return '.osgjs';
      }
      if (sample.trimStart().startsWith('{') || sample.trimStart().startsWith('[')) return '.json';
    }
    return '.bin';
  }

  function flushState(tid, source) {
    const st = _state[tid];
    if (!st || st.chunks.length === 0) return;
    const totalLen = st.chunks.reduce((s, c) => s + c.byteLength, 0);
    if (totalLen < 1024) return;
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of st.chunks) { merged.set(new Uint8Array(c), off); off += c.byteLength; }
    delete _state[tid];
    const ext = detectExt(merged);
    const h0 = merged[0]?.toString(16).padStart(2,'0') ?? '?';
    const h1 = merged[1]?.toString(16).padStart(2,'0') ?? '?';
    const magic = h0 + h1;
    const uniqueId = `${tid}_${++_flushCount}`;
    window.dispatchEvent(new CustomEvent('SF_DECRYPTED_BUFFER', {
      detail: { taskId: uniqueId, buffer: merged.buffer, size: totalLen, ext, magic }
    }));
  }

  function accumulateAB(ab, tid) {
    if (!_state[tid]) _state[tid] = { chunks: [], total: 0 };
    _state[tid].chunks.push(ab.slice(0));
    _state[tid].total += ab.byteLength;
  }

  try {
    const _probeBc = new BroadcastChannel('__sf_dl_probe__');
    const BC_STREAM_KEY  = 'bc_stream';
    const BC_FLUSH_DELAY = 500;
    const BC_FLUSH_MAX   = 32 * 1024 * 1024;
    let _bcFlushTimer = null;

    function scheduleBcFlush() {
      if (_bcFlushTimer) clearTimeout(_bcFlushTimer);
      _bcFlushTimer = setTimeout(() => {
        _bcFlushTimer = null;
        flushState(BC_STREAM_KEY, 'BC/timeout');
      }, BC_FLUSH_DELAY);
    }

    _probeBc.onmessage = function(evt) {
      const msg = evt.data;
      if (!msg) return;
      if (msg.type === 'decrypt' && msg.buf instanceof ArrayBuffer) {
        accumulateAB(msg.buf, BC_STREAM_KEY);
        const st = _state[BC_STREAM_KEY];
        if (st && st.total >= BC_FLUSH_MAX) {
          if (_bcFlushTimer) { clearTimeout(_bcFlushTimer); _bcFlushTimer = null; }
          flushState(BC_STREAM_KEY, 'BC/maxsize');
        } else {
          scheduleBcFlush();
        }
      }
    };
  } catch(e) {}

  function processMsg(data, label) {
    try {
      if (data instanceof ArrayBuffer && data.byteLength > 4096) {
        const uid = `${label}_${++_flushCount}`;
        window.dispatchEvent(new CustomEvent('SF_DECRYPTED_BUFFER', {
          detail: { taskId: uid, buffer: data.slice(0), size: data.byteLength }
        }));
        return;
      }
      if (ArrayBuffer.isView(data) && !(data instanceof DataView) && data.byteLength > 4096) {
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const uid = `${label}_t_${++_flushCount}`;
        window.dispatchEvent(new CustomEvent('SF_DECRYPTED_BUFFER', {
          detail: { taskId: uid, buffer: ab, size: data.byteLength }
        }));
        return;
      }
      if (Array.isArray(data) && data.length >= 2) {
        const [first, second] = data;
        const tid = typeof first === 'number' ? first : 0;
        if (tid < 0) return;
        if (second === 0) { flushState(tid, 'Array/end'); return; }
        if (second instanceof ArrayBuffer && second.byteLength > 0) {
          accumulateAB(second, tid); return;
        }
        if (ArrayBuffer.isView(second) && !(second instanceof DataView) && second.byteLength > 0) {
          const ab = second.buffer.slice(second.byteOffset, second.byteOffset + second.byteLength);
          accumulateAB(ab, tid); return;
        }
        if (second && typeof second === 'object') processMsg(second, label + '[A-obj]');
        return;
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const tid = typeof data.id === 'number' ? data.id :
                    typeof data.taskId === 'number' ? data.taskId : 0;
        const isDone = data.type === 'done' || data.type === 'end' ||
                       data.type === 'complete' || data.type === 'finished' ||
                       data.done === true || data.finished === true;
        if (isDone) { flushState(tid, 'Obj/done'); return; }
        const vals = Object.values(data);
        for (const v of vals) {
          if (v instanceof ArrayBuffer && v.byteLength > 0) {
            accumulateAB(v, tid); return;
          }
          if (ArrayBuffer.isView(v) && !(v instanceof DataView) && v.byteLength > 0) {
            const ab = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
            accumulateAB(ab, tid); return;
          }
        }
      }
    } catch (e) {}
  }

  const _NativeWorker = window.Worker;
  let _workerCount = 0;

  function PatchedWorker(url, opts) {
    const w     = new _NativeWorker(url, opts);
    const wid   = ++_workerCount;
    const label = `[W${wid}:${String(url).split('/').pop().slice(0, 20)}]`;

    let _savedHandler = null;
    let _hooked       = false;

    function ensureHook() {
      if (_hooked) return;
      _hooked = true;
      _NativeWorker.prototype.addEventListener.call(w, 'message', evt => {
        try { processMsg(evt.data, label); } catch (_e) {}
        try {
          if (_savedHandler) _savedHandler.call(w, evt);
        } catch (err) {
          throw err;
        }
      });
    }

    Object.defineProperty(w, 'onmessage', {
      get() { return _savedHandler; },
      set(fn) {
        ensureHook();
        _savedHandler = fn;
      },
      configurable: true,
    });

    const _origAEL = w.addEventListener.bind(w);
    w.addEventListener = function (type, handler, opts2) {
      if (type === 'message') ensureHook();
      return _origAEL(type, handler, opts2);
    };

    const _origPost = w.postMessage.bind(w);
    w.postMessage = function (msg, transfer) {
      return _origPost(msg, transfer);
    };

    return w;
  }

  PatchedWorker.prototype = _NativeWorker.prototype;
  Object.defineProperty(PatchedWorker, 'name', { value: 'Worker' });

  try {
    window.Worker = PatchedWorker;
  } catch (e) {}

  function isModelAPI(url) {
    return typeof url === 'string' && (
      /sketchfab\.com\/i\/models\/[a-f0-9\-]{8,}/.test(url) ||
      /sketchfab\.com\/2\.0\/models\//.test(url) ||
      /api\.sketchfab\.com\/v\d\/models\//.test(url) ||
      /sketchfab\.com\/a\//.test(url)
    );
  }

  function isBinzUrl(url) {
    return typeof url === 'string' && (
      url.includes('.binz') ||
      url.includes('model_file') ||
      url.includes('.osgjs') ||
      url.includes('.usdz')
    );
  }

  function tryDispatchModelData(data, sourceUrl) {
    if (!data || typeof data !== 'object') return;
    const str = JSON.stringify(data);
    if (str.includes('osgjsUrl') || str.includes('model_file') ||
        str.includes('.binz') || str.includes('files') ||
        str.includes('modelSize') || str.includes('modelFile') ||
        str.includes('downloadUrl') || str.includes('archiveUrl')) {
      window.dispatchEvent(new CustomEvent('SF_MODEL_DATA', { detail: data }));
    }
  }

  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const resp = await _origFetch.apply(this, args);

    if (isModelAPI(url)) {
      resp.clone().json().then(d => tryDispatchModelData(d, url)).catch(() => {});
    }

    if (isBinzUrl(url)) {
      resp.clone().arrayBuffer().then(ab => {
        if (ab.byteLength > 1024) {
          window.dispatchEvent(new CustomEvent('SF_BINZ_DOWNLOADED', {
            detail: { url, buffer: ab }
          }));
        }
      }).catch(() => {});
    }

    return resp;
  };

  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sf_url = url || '';
    return _xhrOpen.apply(this, arguments);
  };

  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (isModelAPI(xhr.__sf_url)) {
      xhr.addEventListener('load', () => {
        try { tryDispatchModelData(JSON.parse(xhr.responseText)); } catch (_) {}
      });
    }
    if (isBinzUrl(xhr.__sf_url)) {
      xhr.addEventListener('load', () => {
        if (xhr.response instanceof ArrayBuffer && xhr.response.byteLength > 1024) {
          window.dispatchEvent(new CustomEvent('SF_BINZ_DOWNLOADED', {
            detail: { url: xhr.__sf_url, buffer: xhr.response }
          }));
        }
      });
    }
    return _xhrSend.apply(this, arguments);
  };

  const _origCreateObjectURL = URL.createObjectURL;
  let _blobUrlCount = 0;

  URL.createObjectURL = function (obj) {
    if (!(obj instanceof Blob)) {
      return _origCreateObjectURL.call(URL, obj);
    }

    const bid = ++_blobUrlCount;
    const isJS = obj.type === 'application/javascript' ||
                 obj.type === 'text/javascript'         ||
                 obj.type === ''                        ||
                 obj.type === 'text/plain';
    const isBin = obj.type === 'application/octet-stream' ||
                  obj.type === 'application/wasm'         ||
                  obj.type === 'model/gltf-binary';

    if (isBin && obj.size > 100 * 1024) {
      obj.arrayBuffer().then(ab => {
        window.dispatchEvent(new CustomEvent('SF_DECRYPTED_BUFFER', {
          detail: { taskId: `blob_${bid}`, buffer: ab, size: ab.byteLength }
        }));
      }).catch(() => {});
      return _origCreateObjectURL.call(URL, obj);
    }

    if (isJS && obj.size < 5 * 1024 * 1024) {
      try {
        const injectedBlob = new Blob([WORKER_PROBE_CODE, obj], { type: obj.type || 'application/javascript' });
        return _origCreateObjectURL.call(URL, injectedBlob);
      } catch(e) {}
    }

    return _origCreateObjectURL.call(URL, obj);
  };

  if (typeof WebAssembly !== 'undefined') {
    const _origInstantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = function (bufferSource, importObject) {
      return _origInstantiate.apply(WebAssembly, arguments);
    };

    if (WebAssembly.instantiateStreaming) {
      const _origIS = WebAssembly.instantiateStreaming;
      WebAssembly.instantiateStreaming = function (source, importObject) {
        return _origIS.apply(WebAssembly, arguments);
      };
    }

    if (WebAssembly.compile) {
      const _origCompile = WebAssembly.compile;
      WebAssembly.compile = function (bufferSource) {
        return _origCompile.apply(WebAssembly, arguments);
      };
    }
  }

  const _NativeMsgChannel = window.MessageChannel;
  let _channelCount = 0;
  window.MessageChannel = function () {
    const ch  = new _NativeMsgChannel();
    const cid = ++_channelCount;

    ['port1', 'port2'].forEach(portName => {
      const port = ch[portName];
      const _origPortAEL = port.addEventListener.bind(port);
      port.addEventListener = function (type, handler, opts) {
        if (type === 'message') {
          const wrapped = function (evt) {
            processMsg(evt.data, `[MC${cid}/${portName}]`);
            handler.call(this, evt);
          };
          return _origPortAEL(type, wrapped, opts);
        }
        return _origPortAEL(type, handler, opts);
      };

      let _portSavedHandler = null;
      Object.defineProperty(port, 'onmessage', {
        get() { return _portSavedHandler; },
        set(fn) {
          _portSavedHandler = fn;
          _origPortAEL('message', evt => {
            processMsg(evt.data, `[MC${cid}/${portName}/onmsg]`);
            if (_portSavedHandler) _portSavedHandler.call(port, evt);
          });
        },
        configurable: true,
      });
    });

    return ch;
  };

  if (window === window.top) {
    if (document.body) {
      const _mo = new MutationObserver(() => {});
      _mo.observe(document.body, { childList: true, subtree: true });
    }
  } else {
    const href = location.href;
    const uidMatch = href.match(/\/models\/([a-f0-9]{32})/) ||
                     href.match(/\/3d-models\/[^/]+-([a-f0-9]{32})/);
    if (uidMatch) {
      const uid = uidMatch[1];
      window.addEventListener('message', function onResult(e) {
        if (!e.data || !e.data.__sfDlReply || e.data.action !== 'modelInfoResult') return;
        window.removeEventListener('message', onResult);
        const resp = e.data;
        if (resp.ok) {
          window.dispatchEvent(new CustomEvent('SF_MODEL_DATA', { detail: resp.data }));
        }
      });
      const target = (window.parent !== window) ? window.parent : window;
      target.postMessage({ __sfDl: true, action: 'getModelInfo', uid }, '*');
    }
  }
})();
