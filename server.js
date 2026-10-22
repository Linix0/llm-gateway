#!/usr/bin/env node
'use strict';
/**
 * LLM Gateway - 本地大模型统一代理
 * 零依赖，仅使用 Node 内置模块。
 *
 * 能力：
 *  - 把 OpenAI(含 Responses API) / Anthropic 请求原样透传到某个上游 provider
 *  - 多 provider 配置，一键切换 active；也支持 "providerId/model" 精确路由
 *  - 流式（SSE）直通，不做缓冲
 *  - 本地管理界面 + 请求日志
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const RSP = require('./lib/responses-adapter');

const ROOT = __dirname;
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
})();
const DATA_DIR = path.join(ROOT, 'data');
const CFG_PATH = path.join(DATA_DIR, 'config.json');
const LOG_PATH = path.join(DATA_DIR, 'requests.log');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 64 * 1024 * 1024; // 64MB，超出直接拒绝

const DEFAULT_CFG = {
  server: { host: '127.0.0.1', port: 8787 },
  active: 'nextapi',
  providers: [
    {
      id: 'nextapi',
      name: 'NextApi',
      api: 'openai',
      baseUrl: 'https://api.nextapi.store/v1',
      auth: { type: 'bearer', value: 'env:NEXTAPI_API_KEY' },
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 128000 }
      ]
    },
    {
      id: 'agentrouter',
      name: 'AgentRouter',
      api: 'openai',
      baseUrl: 'https://agentrouter.org/v1',
      auth: { type: 'bearer', value: 'env:CODEX_GATEWAY_API_KEY' },
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128000 },
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 128000 },
        { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 128000 }
      ]
    }
  ],
  activeModel: 'deepseek-v4.1-flash',
  modelPolicy: 'fixed',
  logs: { enabled: true, maxSizeKB: 2048, keep: 3 }
};

/** 日志轮转的默认与边界 */
const LOG_DEFAULTS = { enabled: true, maxSizeKB: 2048, keep: 3 };
const LOG_ARCHIVE_RE = /^requests\.log(\.\d+)?$/;

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function loadCfg() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CFG_PATH)) {
    fs.writeFileSync(CFG_PATH, JSON.stringify(DEFAULT_CFG, null, 2), 'utf8');
  }
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const cfg = {
    server: Object.assign({ host: '127.0.0.1', port: 8787 }, raw.server || {}),
    active: raw.active || (raw.providers && raw.providers[0] ? raw.providers[0].id : ''),
    activeModel: raw.activeModel || null,
    modelPolicy: raw.modelPolicy === 'fixed' ? 'fixed' : 'auto',
    logs: {
      enabled: !(raw.logs && raw.logs.enabled === false),
      maxSizeKB: clampNum((raw.logs || {}).maxSizeKB, 64, 512 * 1024, LOG_DEFAULTS.maxSizeKB),
      keep: clampNum((raw.logs || {}).keep, 1, 20, LOG_DEFAULTS.keep)
    },
    providers: Array.isArray(raw.providers) ? raw.providers : []
  };
  cfg.providers.forEach((p) => {
    p.id = String(p.id || p.name || '').trim();
    p.api = (p.api || 'openai').toLowerCase();
    p.baseUrl = String(p.baseUrl || '').trim();
    p.models = Array.isArray(p.models) ? p.models : [];
  });
  reconcileActiveModel(cfg);
  return cfg;
}

let cfg = loadCfg();

function saveCfg() {
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 解析 provider 的密钥，支持 env:VAR 引用 */
function resolveKey(p) {
  const raw = (p.auth && p.auth.value) || p.apiKey || '';
  if (typeof raw === 'string' && raw.startsWith('env:')) {
    const name = raw.slice(4).trim();
    return process.env[name] || '';
  }
  return raw;
}

function maskKey(v) {
  if (!v) return '';
  if (v.startsWith('env:')) return v;
  if (v.length <= 10) return '***';
  return v.slice(0, 6) + '…' + v.slice(-4);
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

const recent = [];
const MAX_RECENT = 300;

/** 本地时区的 ISO 时间：2026-10-22T16:02:30.531+08:00（保留偏移量，跨时区也能还原） */
function localIso(d) {
  const p = (n, w) => String(n).padStart(w || 2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

/** 当前日志文件字节数，进程启动时初始化，写入时累加 */
let logBytes = 0;
try { logBytes = fs.statSync(LOG_PATH).size; } catch (_) { logBytes = 0; }

function logMaxBytes() {
  const kb = (cfg.logs && cfg.logs.maxSizeKB) || LOG_DEFAULTS.maxSizeKB;
  return kb * 1024;
}

/** 轮转：requests.log → .1 → .2 …，超出 keep 的归档直接删除 */
function rotateLogs(reason) {
  const keep = (cfg.logs && cfg.logs.keep) || LOG_DEFAULTS.keep;
  try { fs.unlinkSync(LOG_PATH + '.' + keep); } catch (_) {}
  for (let i = keep - 1; i >= 1; i--) {
    try { fs.renameSync(LOG_PATH + '.' + i, LOG_PATH + '.' + (i + 1)); } catch (_) {}
  }
  try { fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch (_) {}
  logBytes = 0;
  console.log(`[llm-gateway] 日志已轮转（${reason}），保留 ${keep} 份归档`);
}

function logRequest(entry) {
  const when = entry.at ? new Date(entry.at) : new Date();
  entry.at = when.getTime();         // 客户端用这个做本地时区展示
  entry.ts = localIso(when);         // 文件里可读，带 +08:00 偏移
  recent.push(entry);
  if (recent.length > MAX_RECENT) recent.shift();

  if (cfg.logs && cfg.logs.enabled === false) return;

  const line = JSON.stringify(entry) + '\n';
  const size = Buffer.byteLength(line);
  try {
    if (logBytes > 0 && logBytes + size > logMaxBytes()) rotateLogs('超过 ' + Math.round(logMaxBytes() / 1024) + ' KB');
    fs.appendFile(LOG_PATH, line, () => {});
    logBytes += size;
  } catch (_) {
    /* 日志失败不影响主流程 */
  }
}

/** 日志文件清单（活动文件 + 归档），供界面展示与下载 */
function logFiles() {
  const out = [];
  const push = (name, archive) => {
    try {
      const st = fs.statSync(path.join(DATA_DIR, name));
      out.push({ name, archive, size: st.size, mtime: localIso(st.mtime) });
    } catch (_) {}
  };
  push('requests.log', false);
  for (let i = 1; i <= (cfg.logs.keep || LOG_DEFAULTS.keep); i++) push('requests.log.' + i, true);
  return out;
}

/* ------------------------------------------------------------------ */
/* 路由 & 工具                                                         */
/* ------------------------------------------------------------------ */

/** 把客户端路径拼到 provider baseUrl 的路径上，避免 /v1/v1 重复 */
function joinUpstream(basePathRaw, reqPath) {
  const base = (basePathRaw || '').replace(/\/+$/, '');
  if (!base || base === '/') return reqPath;
  if (reqPath === base || reqPath.startsWith(base + '/')) return reqPath;
  const ver = base.match(/\/v\d+[a-z]*$/i);
  if (ver && reqPath.startsWith(ver[0] + '/')) return base + reqPath.slice(ver[0].length);
  return base + reqPath;
}

/** 根据请求路径判断客户端用的是哪套协议 */
function isAnthropicPath(p) {
  return p.startsWith('/v1/messages') || p.startsWith('/anthropic');
}

/** 是否是模型接口路径（只有这些才会被转发到上游） */
function isModelPath(p) {
  return p.startsWith('/v1') || p.startsWith('/anthropic') ||
    p === '/models' || p === '/chat/completions' || p === '/responses' || p === '/messages';
}

/**
 * 选择上游：
 *  1) "providerId/model" 精确指定
 *  2) 某个 provider 声明了该 model -> 用它（多个命中时优先 active）
 *  3) 回落到 active provider
 */
function pickProvider(model, anthropic) {
  const pool = cfg.providers.filter((p) => (anthropic ? p.api === 'anthropic' : p.api !== 'anthropic'));
  const list = pool.length ? pool : cfg.providers;
  if (!list.length) return { provider: null, model };

  if (model && model.includes('/')) {
    const idx = model.indexOf('/');
    const pid = model.slice(0, idx);
    const rest = model.slice(idx + 1);
    const hit = list.find((p) => p.id === pid);
    if (hit) return { provider: hit, model: rest };
  }

  if (model) {
    const hits = list.filter((p) => p.models.some((m) => m.id === model));
    if (hits.length === 1) return { provider: hits[0], model };
    if (hits.length > 1) {
      const act = hits.find((p) => p.id === cfg.active);
      if (act) return { provider: act, model };
      return { provider: hits[0], model };
    }
  }

  const active = list.find((p) => p.id === cfg.active) || list[0];
  return { provider: active, model };
}

/** 客户端模型名 -> 上游真实模型名 */
function mapModel(provider, model) {
  if (!model) return model;
  const m = provider.models.find((x) => x.id === model);
  if (m && m.upstream) return m.upstream;
  return model;
}

/**
 * 决定这次请求真正用哪个 provider + 哪个模型。
 *
 *  - 模型名写成 "providerId/modelId"：永远精确路由，不受策略影响
 *  - modelPolicy = "fixed" 且设置了 activeModel：忽略客户端传来的模型名，
 *    一律用网关注入的「当前调用模型」（active provider + activeModel）
 *  - modelPolicy = "auto"：按客户端模型名匹配 provider，匹配不到回落 active
 */
function resolveTarget(clientModel, anthropic) {
  if (clientModel && clientModel.includes('/')) {
    return Object.assign({ overridden: false, reason: 'explicit' }, pickProvider(clientModel, anthropic));
  }
  if (cfg.modelPolicy === 'fixed' && cfg.activeModel) {
    const ap = cfg.providers.find((p) => p.id === cfg.active) || pickProvider(null, anthropic).provider;
    if (ap) return { provider: ap, model: cfg.activeModel, overridden: true, reason: 'fixed' };
  }
  return Object.assign({ overridden: false, reason: 'auto' }, pickProvider(clientModel, anthropic));
}

/** activeModel 与 active provider 对不上时，尽量纠正成一致的一组 */
function reconcileActiveModel(c) {
  const conf = c || cfg;
  if (!conf.activeModel) return;
  const act = conf.providers.find((p) => p.id === conf.active);
  if (act && act.models.some((m) => m.id === conf.activeModel)) return;
  const owner = conf.providers.find((p) => p.models.some((m) => m.id === conf.activeModel));
  if (owner) conf.active = owner.id;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体超过 64MB 限制'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function forwardHeaders(src, dropExtra) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (dropExtra && dropExtra.has(key)) continue;
    out[key] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 代理核心                                                            */
/* ------------------------------------------------------------------ */

function proxyRequest(req, res, provider, bodyBuf, model) {
  const started = Date.now();
  const t0 = process.hrtime.bigint();
  let target;
  try {
    target = new URL(provider.baseUrl);
  } catch (_) {
    sendJson(res, 502, { error: { message: `provider ${provider.id} 的 baseUrl 不合法`, type: 'gateway_config' } });
    return;
  }

  const isHttps = target.protocol === 'https:';
  const upstreamPath = joinUpstream(target.pathname, req.url.split('?')[0]) +
    (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '');

  const drop = new Set(['host', 'content-length', 'accept-encoding']);
  const headers = forwardHeaders(req.headers, drop);

  const key = resolveKey(provider);
  if (provider.api === 'anthropic') {
    delete headers['authorization'];
    if (key) headers['x-api-key'] = key;
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  } else {
    if (key) headers['authorization'] = 'Bearer ' + key;
  }
  if (bodyBuf && bodyBuf.length) headers['content-length'] = String(bodyBuf.length);

  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: upstreamPath,
    method: req.method,
    headers
  };

  if (process.env.DEBUG_PROXY === '1') {
    const safe = Object.assign({}, headers);
    if (safe.authorization) safe.authorization = 'Bearer ***';
    if (safe['x-api-key']) safe['x-api-key'] = '***';
    console.log('[proxy]', req.method, provider.id, opts.hostname + upstreamPath, 'body=' + (bodyBuf ? bodyBuf.length : 0));
    console.log('[proxy] headers=', JSON.stringify(safe));
    if (bodyBuf && bodyBuf.length) console.log('[proxy] body=', bodyBuf.toString('utf8').slice(0, 300));
  }

  const transport = isHttps ? https : http;
  const upReq = transport.request(opts, (upRes) => {
    const outHeaders = forwardHeaders(upRes.headers);
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
    upRes.on('end', () => {
      const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
      logRequest({
        path: req.url.split('?')[0],
        model: model || '-',
        provider: provider.id,
        status: upRes.statusCode,
        ms,
        at: started
      });
    });
  });

  // 建连阶段 20s 超时（避免上游不可达时无限等待），拿到响应后放宽为 10 分钟空闲超时（长流式任务）
  upReq.setTimeout(20000, () => upReq.destroy(new Error('连接上游超时(20s)，请检查网络或 baseUrl')));
  upReq.on('response', () => {
    upReq.setTimeout(10 * 60 * 1000, () => upReq.destroy(new Error('上游 10 分钟无数据，已中断')));
  });
  upReq.on('error', (err) => {
    const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
    logRequest({
      path: req.url.split('?')[0], model: model || '-', provider: provider.id,
      status: 502, ms, at: started, error: err.message
    });
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: `上游请求失败: ${err.message}`, type: 'gateway_upstream_error', provider: provider.id }
      });
    } else {
      res.end();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });

  upReq.end(bodyBuf && bodyBuf.length ? bodyBuf : undefined);
}

/* ------------------------------------------------------------------ */
/* /v1/models 聚合                                                      */
/* ------------------------------------------------------------------ */

function listModels() {
  const data = [];
  const seen = new Map();          // id -> index，重复模型名只保留一条（优先 active 供应商）
  for (const p of cfg.providers) {
    for (const m of p.models) {
      const item = {
        id: m.id,
        object: 'model',
        owned_by: p.id,
        display_name: m.name || m.id,
        context_window: m.contextWindow || null
      };
      if (seen.has(m.id)) {
        if (p.id === cfg.active) data[seen.get(m.id)] = item;
        continue;
      }
      seen.set(m.id, data.length);
      data.push(item);
    }
  }
  if (!data.length) {
    // 没有任何声明时，至少让 active provider 的默认模型可见
    data.push({ id: 'default', object: 'model', owned_by: cfg.active });
  }
  return { object: 'list', data };
}

/* ------------------------------------------------------------------ */
/* 管理 API                                                            */
/* ------------------------------------------------------------------ */

async function handleAdmin(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, {
      server: cfg.server,
      active: cfg.active,
      activeModel: cfg.activeModel || null,
      modelPolicy: cfg.modelPolicy,
      runtime: {
        version: APP_VERSION,
        node: process.version,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        startedAt: localIso(new Date(Date.now() - process.uptime() * 1000)),
        requests: recent.length,
        logBytes,
        logs: cfg.logs,
        logFile: LOG_PATH
      },
      providers: cfg.providers.map((p) => ({
        id: p.id, name: p.name, api: p.api, baseUrl: p.baseUrl,
        auth: { type: p.auth && p.auth.type, value: maskKey(resolveKey(p) ? ((p.auth && p.auth.value) || '') : '') },
        hasKey: !!resolveKey(p),
        keyRef: !!(p.auth && typeof p.auth.value === 'string' && p.auth.value.startsWith('env:')),
        models: p.models
      }))
    });
  }

  if (pathname === '/api/providers' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.id || !body.baseUrl) {
      return sendJson(res, 400, { error: { message: 'id 与 baseUrl 必填' } });
    }
    const rec = {
      id: String(body.id).trim(),
      name: String(body.name || body.id).trim(),
      api: String(body.api || 'openai').toLowerCase(),
      baseUrl: String(body.baseUrl).trim(),
      auth: body.auth && body.auth.value !== undefined
        ? { type: body.auth.type || 'bearer', value: String(body.auth.value) }
        : undefined,
      models: Array.isArray(body.models) ? body.models : []
    };
    const i = cfg.providers.findIndex((p) => p.id === rec.id);
    if (i >= 0) {
      if (!rec.auth) rec.auth = cfg.providers[i].auth; // 空值表示不修改密钥
      cfg.providers[i] = rec;
    } else {
      cfg.providers.push(rec);
    }
    if (!cfg.providers.some((p) => p.id === cfg.active)) cfg.active = cfg.providers[0].id;
    if (cfg.activeModel && !cfg.providers.some((p) => p.models.some((m) => m.id === cfg.activeModel))) {
      cfg.activeModel = null; // 该模型已从所有 provider 移除
    }
    reconcileActiveModel();
    saveCfg();
    return sendJson(res, 200, { ok: true, providers: cfg.providers.map((p) => p.id) });
  }

  if (pathname.startsWith('/api/providers/') && method === 'DELETE') {
    const id = decodeURIComponent(pathname.split('/').pop());
    if (cfg.providers.length <= 1) {
      return sendJson(res, 400, { error: { message: '至少保留一个 provider' } });
    }
    cfg.providers = cfg.providers.filter((p) => p.id !== id);
    if (cfg.active === id) cfg.active = cfg.providers[0].id;
    if (cfg.activeModel && !cfg.providers.some((p) => p.models.some((m) => m.id === cfg.activeModel))) {
      cfg.activeModel = null;
    }
    saveCfg();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/active' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!cfg.providers.some((p) => p.id === body.id)) {
      return sendJson(res, 404, { error: { message: 'provider 不存在: ' + body.id } });
    }
    cfg.active = body.id;
    const p = cfg.providers.find((x) => x.id === body.id);
    if (cfg.activeModel && !(p.models || []).some((m) => m.id === cfg.activeModel)) {
      cfg.activeModel = p.models && p.models[0] ? p.models[0].id : null;
    }
    saveCfg();
    return sendJson(res, 200, { ok: true, active: cfg.active, activeModel: cfg.activeModel });
  }

  /** 设置「当前调用模型」：modelId，可选 providerId */
  if (pathname === '/api/model' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const mid = String(body.model || '').trim();
    if (!mid) return sendJson(res, 400, { error: { message: 'model 必填' } });
    let target = body.provider ? cfg.providers.find((x) => x.id === body.provider) : null;
    if (!target) {
      target = cfg.providers.find((x) => x.id === cfg.active && (x.models || []).some((m) => m.id === mid))
        || cfg.providers.find((x) => (x.models || []).some((m) => m.id === mid));
    }
    if (!target) {
      // 允许填上游真实存在、但本地没登记的模型名
      target = cfg.providers.find((x) => x.id === cfg.active) || cfg.providers[0];
    }
    if (!target) return sendJson(res, 400, { error: { message: '还没有可用的 provider' } });
    cfg.active = target.id;
    cfg.activeModel = mid;
    if (body.policy === 'auto' || body.policy === 'fixed') cfg.modelPolicy = body.policy;
    saveCfg();
    return sendJson(res, 200, { ok: true, active: cfg.active, activeModel: cfg.activeModel, modelPolicy: cfg.modelPolicy });
  }

  /** 路由策略：auto=跟随客户端模型名，fixed=固定用当前调用模型 */
  if (pathname === '/api/policy' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    cfg.modelPolicy = body.policy === 'fixed' ? 'fixed' : 'auto';
    if (cfg.modelPolicy === 'fixed' && !cfg.activeModel) {
      const p = cfg.providers.find((x) => x.id === cfg.active) || cfg.providers[0];
      if (p && p.models && p.models[0]) cfg.activeModel = p.models[0].id;
    }
    saveCfg();
    return sendJson(res, 200, { ok: true, modelPolicy: cfg.modelPolicy, activeModel: cfg.activeModel });
  }

  if (pathname === '/api/test' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const p = cfg.providers.find((x) => x.id === body.id);
    if (!p) return sendJson(res, 404, { error: { message: 'provider 不存在' } });
    try {
      const result = await testProvider(p);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 200, { ok: false, status: 0, message: e.message });
    }
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const limit = Math.min(Number(query.get('limit') || 50), MAX_RECENT);
    return sendJson(res, 200, { items: recent.slice(-limit).reverse() });
  }

  /** 日志文件与容量信息 */
  if (pathname === '/api/logs/meta' && method === 'GET') {
    const files = logFiles();
    return sendJson(res, 200, {
      conf: cfg.logs,
      activeBytes: logBytes,
      totalBytes: files.reduce((a, f) => a + f.size, 0),
      dir: DATA_DIR,
      files
    });
  }

  /** 调整轮转策略 */
  if (pathname === '/api/logs/config' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (body.maxSizeKB !== undefined) cfg.logs.maxSizeKB = clampNum(body.maxSizeKB, 64, 512 * 1024, cfg.logs.maxSizeKB);
    if (body.keep !== undefined) cfg.logs.keep = clampNum(body.keep, 1, 20, cfg.logs.keep);
    if (body.enabled !== undefined) cfg.logs.enabled = !!body.enabled;
    saveCfg();
    return sendJson(res, 200, { ok: true, conf: cfg.logs });
  }

  /** 清空日志：默认只清活动文件，archives=true 连归档一起删 */
  if (pathname === '/api/logs/clear' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    let removed = 0;
    try { fs.writeFileSync(LOG_PATH, ''); } catch (_) {}
    logBytes = 0;
    recent.length = 0;
    if (body.archives === true) {
      for (let i = 1; i <= 20; i++) {
        try { fs.unlinkSync(LOG_PATH + '.' + i); removed++; } catch (_) {}
      }
    }
    return sendJson(res, 200, { ok: true, removedArchives: removed });
  }

  /** 下载日志文件（只允许 requests.log 与 requests.log.N） */
  if (pathname === '/api/logs/download' && method === 'GET') {
    const name = String(query.get('name') || 'requests.log');
    if (!LOG_ARCHIVE_RE.test(name)) return sendJson(res, 400, { error: { message: '文件名不合法' } });
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: { message: '日志文件不存在' } });
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store'
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (pathname === '/api/reload' && method === 'POST') {
    cfg = loadCfg();
    return sendJson(res, 200, { ok: true, active: cfg.active });
  }

  return sendJson(res, 404, { error: { message: 'not found' } });
}

/** 用上游 /models 探活 */
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

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: { message: 'forbidden' } });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: { message: 'not found' } });
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Responses API 适配代理（上游只支持 chat/completions 时使用）        */
/* ------------------------------------------------------------------ */

function sseWrite(res, event, payload) {
  if (res.writableEnded) return;
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n');
}

function handleResponsesProxy(req, res, provider, body, model) {
  const started = Date.now();
  const t0 = process.hrtime.bigint();

  let target;
  try {
    target = new URL(provider.baseUrl);
  } catch (_) {
    sendJson(res, 502, { error: { message: `provider ${provider.id} 的 baseUrl 不合法`, type: 'gateway_config' } });
    return;
  }

  const { chat, custom } = RSP.toChatRequest(body, model);
  const basePath = (target.pathname || '').replace(/\/+$/, '');
  const upstreamPath = basePath + '/chat/completions';
  const payload = Buffer.from(JSON.stringify(chat), 'utf8');

  const headers = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    accept: chat.stream ? 'text/event-stream' : 'application/json'
  };
  const key = resolveKey(provider);
  if (key) headers.authorization = 'Bearer ' + key;

  if (process.env.DEBUG_PROXY === '1') {
    console.log('[responses]', provider.id, target.hostname + upstreamPath, 'stream=' + chat.stream);
    console.log('[responses] chat body=', JSON.stringify(chat).slice(0, 500));
  }

  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const upReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: upstreamPath,
    method: 'POST',
    headers
  }, (upRes) => {
    const status = upRes.statusCode || 502;

    if (status >= 400) {
      let err = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (c) => { err += c; });
      upRes.on('end', () => {
        const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
        logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status, ms, at: started, error: err.slice(0, 200) });
        const msg = '上游 ' + status + ': ' + err.slice(0, 600);
        if (chat.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
          if (res.flushHeaders) res.flushHeaders();
          const tr = new RSP.StreamTranslator((e, p) => sseWrite(res, e, p), model, custom);
          tr.start();
          tr.fail(msg);
          res.end();
        } else {
          sendJson(res, status, { error: { message: msg, type: 'upstream_error', provider: provider.id } });
        }
      });
      return;
    }

    if (!chat.stream) {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status: 502, ms, at: started, error: 'bad json' });
          sendJson(res, 502, { error: { message: '上游返回非 JSON: ' + Buffer.concat(chunks).toString('utf8').slice(0, 300), type: 'upstream_bad_body' } });
          return;
        }
        logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status: 200, ms, at: started });
        sendJson(res, 200, RSP.chatToResponses(json, model, custom));
      });
      upRes.on('error', (e) => {
        if (!res.headersSent) sendJson(res, 502, { error: { message: '上游中断: ' + e.message, type: 'upstream_aborted' } });
        else res.end();
      });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();

    const tr = new RSP.StreamTranslator((e, p) => sseWrite(res, e, p), model, custom);
    tr.start();

    let buf = '';
    const handleLine = (line) => {
      if (!line || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') { tr.finish(); return; }
      let obj;
      try { obj = JSON.parse(data); } catch (_) { return; }
      if (obj && obj.error) { tr.fail(obj.error.message || JSON.stringify(obj.error)); return; }
      tr.push(obj);
    };

    upRes.setEncoding('utf8');
    upRes.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });
    upRes.on('end', () => {
      if (buf.trim()) handleLine(buf.trim());
      tr.finish();
      res.end();
      const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
      logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status: 200, ms, at: started });
    });
    upRes.on('error', (e) => {
      tr.fail('上游流中断: ' + e.message);
      res.end();
    });
  });

  upReq.setTimeout(20000, () => upReq.destroy(new Error('连接上游超时(20s)，请检查网络或 baseUrl')));
  upReq.on('response', () => {
    upReq.setTimeout(10 * 60 * 1000, () => upReq.destroy(new Error('上游 10 分钟无数据，已中断')));
  });
  upReq.on('error', (err) => {
    const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
    logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status: 502, ms, at: started, error: err.message });
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `上游请求失败: ${err.message}`, type: 'gateway_upstream_error', provider: provider.id } });
    } else {
      res.end();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });

  upReq.end(payload);
}

/* ------------------------------------------------------------------ */
/* 主服务                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  try {
    if (pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        active: cfg.active,
        activeModel: cfg.activeModel || null,
        modelPolicy: cfg.modelPolicy,
        providers: cfg.providers.length,
        uptime: Math.round(process.uptime())
      });
    }

    if (pathname.startsWith('/api/')) {
      return await handleAdmin(req, res, pathname, u.searchParams);
    }

    if (req.method === 'GET' && pathname === '/v1/models' && u.searchParams.get('raw') !== '1') {
      return sendJson(res, 200, listModels());
    }

    if (req.method === 'GET' && !pathname.startsWith('/v1') && !pathname.startsWith('/anthropic')) {
      return serveStatic(res, pathname);
    }

    // 只转发真正的模型接口，避免误把页面请求当成模型调用打到上游
    if (!isModelPath(pathname)) {
      return sendJson(res, 404, { error: { message: 'unknown endpoint: ' + pathname } });
    }

    // ---- 代理 ----
    const anthropic = isAnthropicPath(pathname);
    const rawBody = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

    let model = null;
    let bodyBuf = rawBody;
    let parsed = null;
    const ctype = (req.headers['content-type'] || '').toLowerCase();
    if (rawBody.length && ctype.includes('json')) {
      try { parsed = JSON.parse(rawBody.toString('utf8')); } catch (_) { parsed = null; }
    }
    if (parsed && typeof parsed.model === 'string') model = parsed.model;

    const picked = resolveTarget(model, anthropic);
    if (!picked.provider) {
      return sendJson(res, 503, { error: { message: '没有可用的 provider，请先在管理界面添加', type: 'gateway_no_provider' } });
    }

    const upstreamModel = mapModel(picked.provider, picked.model) || picked.model;
    if (upstreamModel) model = upstreamModel;

    // Responses 协议：上游只支持 chat/completions 时走适配层
    if (parsed && pathname.replace(/\/+$/, '') === '/v1/responses' &&
        !anthropic && picked.provider.upstreamResponses !== true) {
      return handleResponsesProxy(req, res, picked.provider, parsed, model);
    }

    // 把最终模型名写回请求体：覆盖客户端传的、或客户端压根没传时补上
    if (parsed && upstreamModel && upstreamModel !== parsed.model) {
      parsed.model = upstreamModel;
      bodyBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
    }
    return proxyRequest(req, res, picked.provider, bodyBuf, model);
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: e.message, type: 'gateway_internal' } });
    } else {
      res.end();
    }
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(cfg.server.port, cfg.server.host, () => {
  ensureDir(DATA_DIR);
  console.log(`[llm-gateway] listening on http://${cfg.server.host}:${cfg.server.port}`);
  console.log(`[llm-gateway] route: ${cfg.active} / ${cfg.activeModel || '(跟随客户端)'} · policy=${cfg.modelPolicy}`);
  console.log(`[llm-gateway] 管理界面: http://${cfg.server.host}:${cfg.server.port}/`);
});

process.on('SIGINT', () => { console.log('\n[llm-gateway] bye'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (e) => console.error('[llm-gateway] uncaught:', e.message));
