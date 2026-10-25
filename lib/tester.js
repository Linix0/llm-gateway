'use strict';
/** 连通性与模型级测活，结果持久化，定时自动巡检。 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { cfg, clampNum, resolveKey, DATA_DIR } = require('./config');
const { laneOf } = require('./queue');

/** 连通性测试：只查 /models，不调用任何模型 */
function testProvider(p) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(p.baseUrl);
    } catch (_) {
      return reject(new Error('baseUrl 不合法'));
    }
    const isHttps = target.protocol === 'https:';
    const base = target.pathname.replace(/\/+$/, '');
    const pth = (base.endsWith('/models') ? base : base + '/models');
    const key = resolveKey(p);
    const headers = { accept: 'application/json' };
    if (p.api === 'anthropic') {
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else if (key) {
      headers.authorization = 'Bearer ' + key;
    }
    const upReq = (isHttps ? https : http).request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || (isHttps ? 443 : 80), path: pth, method: 'GET', headers, timeout: 15000 },
      (upRes) => {
        let buf = '';
        upRes.on('data', (c) => (buf += c));
        upRes.on('end', () => {
          let count = null;
          try {
            const j = JSON.parse(buf);
            const arr = j.data || j.models || j;
            if (Array.isArray(arr)) count = arr.length;
          } catch (_) {}
          resolve({
            ok: upRes.statusCode >= 200 && upRes.statusCode < 300,
            status: upRes.statusCode,
            models: count,
            message: upRes.statusCode >= 400 ? buf.slice(0, 200) : '连接正常'
          });
        });
      }
    );
    upReq.on('timeout', () => upReq.destroy(new Error('连接超时(15s)')));
    upReq.on('error', (e) => reject(e));
    upReq.end();
  });
}

/**
 * 单模型真实测活：发一次极小请求（max_tokens=1），拿回真实可用性与错误分类。
 * kind: ok 可用 / rate 限流未验证 / auth 鉴权或权限 / missing 模型不存在
 *       reject 参数被上游拒绝 / upstream 上游故障 / net 网络或超时 / err 其它
 */
function testModel(p, modelId) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(p.baseUrl);
    } catch (_) {
      return resolve({ ok: false, kind: 'net', status: 0, ms: 0, provider: p.id, model: modelId, message: 'baseUrl 不合法' });
    }

    const entry = (p.models || []).find((m) => m.id === modelId) || null;
    const upstream = (entry && entry.upstream) || modelId;
    const isAnth = p.api === 'anthropic';
    const isHttps = target.protocol === 'https:';
    const base = target.pathname.replace(/\/+$/, '');
    const pth = isAnth
      ? (base.endsWith('/messages') ? base : base + '/messages')
      : (base.endsWith('/chat/completions') ? base : base + '/chat/completions');

    const payload = isAnth
      ? { model: upstream, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
      : { model: upstream, max_tokens: 1, stream: false, messages: [{ role: 'user', content: 'hi' }] };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    const key = resolveKey(p);
    const headers = { 'content-type': 'application/json', 'content-length': body.length, accept: 'application/json' };
    if (isAnth) {
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else if (key) {
      headers.authorization = 'Bearer ' + key;
    }

    const started = Date.now();
    const done = (r) => resolve(Object.assign({ ms: Date.now() - started, provider: p.id, model: modelId, upstream }, r));

    const upReq = (isHttps ? https : http).request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || (isHttps ? 443 : 80), path: pth, method: 'POST', headers, timeout: 30000 },
      (upRes) => {
        let buf = '';
        upRes.on('data', (c) => (buf += c));
        upRes.on('end', () => {
          const status = upRes.statusCode || 0;
          let realModel = null;
          let msg = '';
          try {
            const j = JSON.parse(buf);
            realModel = j.model || (j.message && j.message.model) || null;
            msg = (j.error && (j.error.message || j.error.code)) || j.detail || j.message || '';
          } catch (_) {
            msg = buf.slice(0, 160);
          }
          // 注意：结果里的 model 字段统一用"请求时的模型 id"（modelId），
          // 而不是上游回显的模型名（realModel）。否则客户端用 .mid 查结果时会对不上、单元格被清空。
          if (status >= 200 && status < 300) return done({ ok: true, kind: 'ok', status, realModel: realModel || upstream, message: '可用' });
          const kind = status === 429 ? 'rate' : (status === 401 || status === 403) ? 'auth' : status === 404 ? 'missing' : status === 400 ? 'reject' : status >= 500 ? 'upstream' : 'err';
          done({ ok: false, kind, status, message: String(msg || ('HTTP ' + status)).slice(0, 200) });
        });
      }
    );
    upReq.on('timeout', () => { upReq.destroy(); done({ ok: false, kind: 'net', status: 0, message: '请求超时(30s)' }); });
    upReq.on('error', (e) => done({ ok: false, kind: 'net', status: 0, message: e.message }));
    upReq.write(body);
    upReq.end();
  });
}

/* ---- 测活结果持久化 ---- */

const STATUS_PATH = path.join(DATA_DIR, 'model-status.json');

function loadModelStatus() {
  try {
    const j = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
    return {
      providers: j.providers && typeof j.providers === 'object' ? j.providers : {},
      lastAutoTestAt: j.lastAutoTestAt || 0
    };
  } catch (_) {
    return { providers: {}, lastAutoTestAt: 0 };
  }
}

/** 测活结果单例 */
const modelStatusStore = loadModelStatus();
let statusTimer = null;

function saveModelStatus() {
  try {
    const tmp = STATUS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(modelStatusStore), 'utf8');
    fs.renameSync(tmp, STATUS_PATH);
  } catch (_) { /* 失败不影响主流程 */ }
}

function scheduleStatusSave() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = null; saveModelStatus(); }, 3000);
}

/** 测活结果落盘：界面重启后仍能回看上次状态（chip 着色） */
function recordModelStatus(providerId, modelId, r) {
  const p = modelStatusStore.providers[providerId] || (modelStatusStore.providers[providerId] = {});
  p[modelId] = {
    ok: !!r.ok, kind: r.kind, status: r.status || 0, ms: r.ms || 0,
    message: r.message || '', upstream: r.upstream || null, at: Date.now()
  };
  scheduleStatusSave();
}

/* ---- 定时自动测活 ---- */

let autoTestTimer = null;

/** 自动测活：逐 provider 逐模型串行（1.2s 节流），对应上游正忙时跳过，不打扰正常流量 */
async function runAutoTest(reason) {
  console.log('[llm-gateway] 自动测活开始（' + reason + '）');
  for (const p of cfg.providers) {
    for (const m of (p.models || [])) {
      const l = laneOf(p.id);
      if (l.running > 0 || l.queue.length) continue; // 正忙，跳过这个模型
      try {
        recordModelStatus(p.id, m.id, await testModel(p, m.id));
      } catch (_) { /* 单个失败不影响其它 */ }
      await new Promise((rr) => setTimeout(rr, 1200));
    }
  }
  modelStatusStore.lastAutoTestAt = Date.now();
  saveModelStatus();
  console.log('[llm-gateway] 自动测活完成');
}

function scheduleAutoTest() {
  if (autoTestTimer) { clearInterval(autoTestTimer); autoTestTimer = null; }
  if (!cfg.autoTest || !cfg.autoTest.enabled) return;
  const hours = clampNum(cfg.autoTest.intervalHours, 1, 168, 24);
  setTimeout(() => { if (cfg.autoTest && cfg.autoTest.enabled) runAutoTest('启动'); }, 90 * 1000);
  autoTestTimer = setInterval(() => {
    if (cfg.autoTest && cfg.autoTest.enabled) runAutoTest('定时 ' + hours + 'h');
  }, hours * 3600 * 1000);
  console.log(`[llm-gateway] 定时测活已开启：每 ${hours}h，上游空闲时执行`);
}

module.exports = {
  testProvider, testModel,
  modelStatusStore, recordModelStatus, saveModelStatus,
  runAutoTest, scheduleAutoTest
};
