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
  logs: { enabled: true, maxSizeKB: 2048, keep: 3 },
  autoTest: { enabled: false, intervalHours: 24 },
  limits: {
    queue: true,              // 同 provider 串行排队（上游并发=1 时不再互撞 429）
    queueTimeoutMs: 120000,   // 排队最长等待，超时返回 503
    retry: { enabled: false, maxAttempts: 2, backoffMs: 800 } // 429/5xx 退避重试，默认关（避免重复计费）
  },
  aliases: {},                // 客户端模型别名 -> "providerId/modelId" 或 "modelId"
  fallback: {                 // 主 provider 失败时自动降级到备用 provider
    enabled: false,
    order: [],                // 备用 provider id，按优先级排列（不含主 provider）
    maxHops: 1,               // 单个请求最多降级几次
    onKinds: ['rate', 'upstream', 'net'], // 触发降级的错误类型
    modelMap: {}              // providerId -> 该 provider 上使用的模型 id
  },
  budget: {                   // 每日预算（本地时区每天 resetHour 点重置）
    enabled: false,
    dailyRequests: 0,         // 0 = 不限制
    dailyPromptTokens: 0,
    dailyCompletionTokens: 0,
    action: 'warn',           // warn = 只告警；reject = 超限直接拒绝
    resetHour: 4
  },
  circuit: {                  // 熔断：连续失败 N 次后短路该 provider 一段时间
    enabled: true,
    threshold: 5,
    cooldownMs: 60000
  }
};

/** 日志轮转的默认与边界 */
const LOG_DEFAULTS = { enabled: true, maxSizeKB: 2048, keep: 3 };
const LOG_ARCHIVE_RE = /^requests\.log(\.\d+)?$/;

/** limits 默认值与边界 */
const LIMIT_DEFAULTS = {
  queue: true, queueTimeoutMs: 120000,
  retry: { enabled: false, maxAttempts: 2, backoffMs: 800 }
};

/** 可触发降级的错误类型（与 testModel 的 kind 口径一致） */
const DEGRADABLE_KINDS = new Set(['rate', 'upstream', 'net', 'auth', 'missing']);
const ALL_DEGRADE_KINDS = ['rate', 'upstream', 'net', 'auth', 'missing', 'reject'];

/** HTTP 状态 -> 错误类型 */
function statusKind(status) {
  if (status === 429) return 'rate';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'missing';
  if (status === 400 || status === 422) return 'reject';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'reject';
  return 'ok';
}

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

/* ---- 策略段归一化：aliases / fallback / budget / circuit ---- */

/** 别名：{"fast":"nextapi/deepseek-v4.1-flash"}；值可以是 "providerId/model" 或纯模型名 */
function normalizeAliases(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k || '').trim();
    const target = String(v || '').trim();
    if (name && target) out[name] = target;
  }
  return out;
}

function normalizeFallback(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const kinds = Array.isArray(r.onKinds)
    ? r.onKinds.filter((k) => ALL_DEGRADE_KINDS.includes(k))
    : ['rate', 'upstream', 'net'];
  const modelMap = {};
  if (r.modelMap && typeof r.modelMap === 'object') {
    for (const [k, v] of Object.entries(r.modelMap)) {
      if (k && v) modelMap[String(k)] = String(v);
    }
  }
  return {
    enabled: !!r.enabled,
    order: Array.isArray(r.order) ? r.order.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20) : [],
    maxHops: clampNum(r.maxHops, 1, 5, 1),
    onKinds: kinds.length ? kinds : ['rate', 'upstream', 'net'],
    modelMap
  };
}

function normalizeBudget(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!r.enabled,
    dailyRequests: clampNum(r.dailyRequests, 0, 100000000, 0),
    dailyPromptTokens: clampNum(r.dailyPromptTokens, 0, 1e12, 0),
    dailyCompletionTokens: clampNum(r.dailyCompletionTokens, 0, 1e12, 0),
    action: r.action === 'reject' ? 'reject' : 'warn',
    resetHour: clampNum(r.resetHour, 0, 23, 4)
  };
}

function normalizeCircuit(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !(r.enabled === false),
    threshold: clampNum(r.threshold, 2, 100, 5),
    cooldownMs: clampNum(r.cooldownMs, 5000, 3600000, 60000)
  };
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
    autoTest: {
      enabled: !!((raw.autoTest || {}).enabled),
      intervalHours: clampNum((raw.autoTest || {}).intervalHours, 1, 168, 24)
    },
    limits: {
      queue: !((raw.limits || {}).queue === false),
      queueTimeoutMs: clampNum((raw.limits || {}).queueTimeoutMs, 5000, 600000, LIMIT_DEFAULTS.queueTimeoutMs),
      retry: {
        enabled: !!((raw.limits || {}).retry || {}).enabled,
        maxAttempts: clampNum(((raw.limits || {}).retry || {}).maxAttempts, 1, 5, LIMIT_DEFAULTS.retry.maxAttempts),
        backoffMs: clampNum(((raw.limits || {}).retry || {}).backoffMs, 100, 30000, LIMIT_DEFAULTS.retry.backoffMs)
      }
    },
    aliases: normalizeAliases(raw.aliases),
    fallback: normalizeFallback(raw.fallback),
    budget: normalizeBudget(raw.budget),
    circuit: normalizeCircuit(raw.circuit),
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

/**
 * 原子写配置：先写 .tmp，再把上一版留成 .bak，最后 rename 覆盖。
 * 这样中途崩溃/断电不会留下半个 config.json（曾是直接 writeFileSync 覆盖）。
 */
function saveCfg() {
  ensureDir(DATA_DIR);
  const tmp = CFG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    if (fs.existsSync(CFG_PATH)) fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak');
  } catch (_) { /* 备份失败不影响主流程 */ }
  fs.renameSync(tmp, CFG_PATH);
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
/* 用量统计（按 provider + model 累计请求数 / token / 耗时 / 失败率）     */
/* ------------------------------------------------------------------ */

const USAGE_PATH = path.join(DATA_DIR, 'usage.json');

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

function loadUsage() {
  try {
    const j = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    return {
      since: j.since || null,
      requests: num(j.requests), errors: num(j.errors),
      prompt: num(j.prompt), completion: num(j.completion), ms: num(j.ms),
      items: j.items && typeof j.items === 'object' ? j.items : {},
      today: (j.today && typeof j.today === 'object') ? j.today : null
    };
  } catch (_) {
    return { since: localIso(new Date()), requests: 0, errors: 0, prompt: 0, completion: 0, ms: 0, items: {}, today: null };
  }
}

let usage = loadUsage();
let usageDirty = false;
let usageTimer = null;

function saveUsage() {
  try {
    const tmp = USAGE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(usage), 'utf8');
    fs.renameSync(tmp, USAGE_PATH);
  } catch (_) { /* 统计失败不影响主流程 */ }
  usageDirty = false;
}

/** 合并写盘：5 秒内多次请求只落一次 */
function scheduleUsageSave() {
  usageDirty = true;
  if (usageTimer) return;
  usageTimer = setTimeout(() => { usageTimer = null; if (usageDirty) saveUsage(); }, 5000);
}

/** 预算日：本地时区每天 resetHour 点为一个新周期（凌晨 4 点前算前一天） */
function budgetDayKey(now) {
  const d = new Date((now || new Date()).getTime());
  if (d.getHours() < cfg.budget.resetHour) d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 今日累计；跨过 resetHour 自动开新一天 */
function rollToday() {
  const key = budgetDayKey();
  if (!usage.today || usage.today.date !== key) {
    usage.today = { date: key, requests: 0, errors: 0, prompt: 0, completion: 0 };
    scheduleUsageSave();
  }
  return usage.today;
}

/** 当前预算状态：今日用量 + 是否超限 + 触发了哪几项 */
function budgetState() {
  const b = cfg.budget;
  const t = rollToday();
  const over = [];
  if (b.dailyRequests > 0 && t.requests >= b.dailyRequests) over.push('requests');
  if (b.dailyPromptTokens > 0 && t.prompt >= b.dailyPromptTokens) over.push('prompt');
  if (b.dailyCompletionTokens > 0 && t.completion >= b.dailyCompletionTokens) over.push('completion');
  return {
    enabled: b.enabled,
    action: b.action,
    resetHour: b.resetHour,
    day: t.date,
    today: { requests: t.requests, errors: t.errors, prompt: t.prompt, completion: t.completion },
    limits: { requests: b.dailyRequests, prompt: b.dailyPromptTokens, completion: b.dailyCompletionTokens },
    over,
    exceeded: over.length > 0
  };
}

function recordUsage(providerId, model, status, ms, u) {
  const ok = status >= 200 && status < 300;
  const p = num(u && u.prompt);
  const c = num(u && u.completion);
  usage.requests++;
  usage.ms += num(ms);
  if (!ok) usage.errors++;
  usage.prompt += p;
  usage.completion += c;
  if (!usage.since) usage.since = localIso(new Date());

  const t = rollToday();
  t.requests++;
  if (!ok) t.errors++;
  t.prompt += p;
  t.completion += c;

  const key = `${providerId}||${model || '-'}`;
  const it = usage.items[key] ||
    (usage.items[key] = { provider: providerId, model: model || '-', requests: 0, errors: 0, prompt: 0, completion: 0, ms: 0, lastAt: 0 });
  it.requests++;
  it.ms += num(ms);
  if (!ok) it.errors++;
  it.prompt += p;
  it.completion += c;
  it.lastAt = Date.now();
  scheduleUsageSave();
}

/** 从响应体里抠 usage：整段 JSON 直接取，SSE 取最后一个 usage 片段 */
function extractUsage(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j && j.usage) return j.usage;
  } catch (_) { /* 不是整段 JSON，按 SSE 处理 */ }
  const re = /"usage"\s*:\s*\{[^}]*\}/g;
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m[0];
  if (!last) return null;
  try {
    return JSON.parse('{' + last + '}').usage;
  } catch (_) {
    return null;
  }
}

/** 统一 OpenAI / Anthropic 的 token 字段名 */
function usageToTokens(u) {
  if (!u) return { prompt: 0, completion: 0 };
  return {
    prompt: num(u.prompt_tokens) || num(u.input_tokens),
    completion: num(u.completion_tokens) || num(u.output_tokens)
  };
}

/* ------------------------------------------------------------------ */
/* 每 provider 串行队列                                                 */
/* 上游常有"并发=1"的硬限制，直接透传会导致并发的两个请求互相挤掉对方。     */
/* ------------------------------------------------------------------ */

const provLanes = new Map(); // providerId -> { running, queue: [task] }

function laneOf(providerId) {
  let l = provLanes.get(providerId);
  if (!l) {
    l = { running: 0, queue: [] };
    provLanes.set(providerId, l);
  }
  return l;
}

function pumpLane(l) {
  while (l.running < 1 && l.queue.length) {
    const t = l.queue.shift();
    clearTimeout(t.timer);
    l.running++;
    t.resolve();
  }
}

/** 占用该 provider 的"车道"；queue=false 时直接放行。onRegister(cancel) 用于排队期间客户端断开时取消 */
function acquireLane(providerId, onRegister) {
  if (cfg.limits && cfg.limits.queue === false) return Promise.resolve();
  const l = laneOf(providerId);
  if (l.running < 1 && !l.queue.length) {
    l.running = 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const task = { resolve, reject, timer: null };
    if (onRegister) {
      onRegister(() => {
        const i = l.queue.indexOf(task);
        if (i >= 0) {
          l.queue.splice(i, 1);
          clearTimeout(task.timer);
          reject(Object.assign(new Error('客户端已断开，取消排队'), { code: 'CLIENT_ABORTED' }));
        }
        // 若已被 pump 消费（正在执行），取消无效——由代理层的 res close 处理
      });
    }
    task.timer = setTimeout(() => {
      const i = l.queue.indexOf(task);
      if (i >= 0) l.queue.splice(i, 1);
      reject(Object.assign(new Error('排队超时：该上游当前繁忙'), { code: 'QUEUE_TIMEOUT' }));
    }, (cfg.limits && cfg.limits.queueTimeoutMs) || LIMIT_DEFAULTS.queueTimeoutMs);
    l.queue.push(task);
  });
}

function releaseLane(providerId) {
  if (cfg.limits && cfg.limits.queue === false) return;
  const l = laneOf(providerId);
  l.running = Math.max(0, l.running - 1);
  pumpLane(l);
}

/** 把一个"返回完成 Promise 的代理动作"放进车道执行；排队期间客户端断开则取消排队 */
async function withLane(providerId, fn, res) {
  let cancelQueue = null;
  const onAbort = () => { if (cancelQueue) cancelQueue(); };
  if (res) res.on('close', onAbort);
  try {
    try {
      await acquireLane(providerId, (c) => { cancelQueue = c; });
    } catch (e) {
      if (e && e.code === 'CLIENT_ABORTED') return; // 排队中被取消，没占到车道，无需释放
      throw e; // QUEUE_TIMEOUT 等交给外层返回 503
    }
    try {
      // 必须把 fn() 的结果返回出去：调用方靠它判断成功/失败（熔断与降级都依赖）
      return await fn();
    } finally {
      releaseLane(providerId);
    }
  } finally {
    if (res) res.removeListener('close', onAbort);
  }
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
/* ------------------------------------------------------------------ */
/* 熔断                                                                */
/* 某个 provider 连续失败到阈值后短路一段时间，避免每个请求都白等 20s 超时。 */
/* ------------------------------------------------------------------ */

const circuits = new Map(); // providerId -> { fails, openUntil, lastKind, lastError }

function circuitOf(pid) {
  let c = circuits.get(pid);
  if (!c) {
    c = { fails: 0, openUntil: 0, lastKind: null, lastError: null };
    circuits.set(pid, c);
  }
  return c;
}

function circuitOpen(pid) {
  if (!cfg.circuit.enabled) return false;
  return circuitOf(pid).openUntil > Date.now();
}

function circuitSnapshot() {
  const out = {};
  for (const [pid, c] of circuits.entries()) {
    if (!c.fails && !c.openUntil) continue;
    out[pid] = {
      fails: c.fails,
      open: c.openUntil > Date.now(),
      openForMs: Math.max(0, c.openUntil - Date.now()),
      lastKind: c.lastKind,
      lastError: c.lastError
    };
  }
  return out;
}

function noteUpstreamResult(pid, ok, kind, message) {
  if (!cfg.circuit.enabled) return;
  const c = circuitOf(pid);
  if (ok) {
    c.fails = 0;
    c.openUntil = 0;
    c.lastKind = null;
    c.lastError = null;
    return;
  }
  c.fails++;
  c.lastKind = kind || null;
  c.lastError = message || null;
  if (c.fails >= cfg.circuit.threshold) {
    c.openUntil = Date.now() + cfg.circuit.cooldownMs;
    console.log(`[llm-gateway] 熔断 ${pid}：连续失败 ${c.fails} 次，${Math.round(cfg.circuit.cooldownMs / 1000)}s 内不再请求`);
  }
}

/** 手动复位某个（或全部）provider 的熔断 */
function resetCircuit(pid) {
  if (pid) circuits.delete(pid);
  else circuits.clear();
}

/* ------------------------------------------------------------------ */
/* 别名与降级链                                                        */
/* ------------------------------------------------------------------ */

/** 客户端模型名 -> 别名目标（可能是 "providerId/model" 或纯模型名） */
function applyAlias(model) {
  if (!model || !cfg.aliases) return { model, alias: null };
  const hit = cfg.aliases[model];
  if (hit && String(hit).trim()) return { model: String(hit).trim(), alias: model };
  return { model, alias: null };
}

/** 降级时模型怎么取：同名优先 → modelMap → 该 provider 第一个模型 → 原名 */
function resolveFallbackModel(provider, model) {
  if (!model) return model;
  if ((provider.models || []).some((m) => m.id === model)) return model;
  const mapped = cfg.fallback.modelMap[provider.id];
  if (mapped) return mapped;
  if (provider.models && provider.models[0]) return provider.models[0].id;
  return model;
}

/**
 * 构造候选 provider 列表：[主, 备用1, 备用2…]
 * - 客户端显式写 "providerId/model" 时不降级（用户已明确指定）
 * - 熔断中的 provider 跳过
 */
function buildCandidates(primary, explicit) {
  const hops = cfg.fallback.maxHops || 1;
  const out = [];
  // 主供应商熔断中且有备用时，直接让位给备用（这正是熔断的意义）
  if (!circuitOpen(primary.id)) out.push(primary);
  if (!cfg.fallback.enabled || explicit) {
    return out.length ? out : [primary];
  }
  for (const id of cfg.fallback.order) {
    if (out.length > hops) break;
    if (id === primary.id) continue;
    const p = cfg.providers.find((x) => x.id === id);
    if (!p) continue;
    if (circuitOpen(p.id)) continue;
    out.push(p);
  }
  // 全都熔断时仍然尝试主供应商，保证客户端至少能拿到一个明确错误
  if (!out.length) out.push(primary);
  return out.slice(0, hops + 1);
}

/** 这个错误值不值得换一家再试 */
function isDegradable(kind) {
  return DEGRADABLE_KINDS.has(kind) && cfg.fallback.onKinds.includes(kind);
}

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
function resolveTarget(clientModel, anthropic, aliased) {
  if (clientModel && clientModel.includes('/')) {
    return Object.assign({ overridden: false, reason: 'explicit' }, pickProvider(clientModel, anthropic));
  }
  // 别名是管理员显式定义的语义路由，优先级高于「网关固定」
  if (!aliased && cfg.modelPolicy === 'fixed' && cfg.activeModel) {
    const ap = cfg.providers.find((p) => p.id === cfg.active) || pickProvider(null, anthropic).provider;
    if (ap) return { provider: ap, model: cfg.activeModel, overridden: true, reason: 'fixed' };
  }
  return Object.assign({ overridden: aliased ? true : false, reason: aliased ? 'alias' : 'auto' }, pickProvider(clientModel, anthropic));
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
  // 客户端可能已断开（重试/排队期间），往销毁的响应上写会抛异常
  if (res.destroyed || res.writableEnded) return;
  try {
    const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (_) { /* 连接已断，忽略 */ }
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

/**
 * 通用透传代理。返回"响应彻底结束"的 Promise，供 withLane 排队与优雅退出使用。
 * 重试：仅当还没给客户端写过任何字节（headersSent=false）且状态为 429/5xx 或网络错误时，
 *       整个请求重放（bodyBuf 可重用）；一旦开始流式输出就绝不再试。
 * 软失败：opts.softFail=true 时，可降级的错误（429/5xx/网络）不写客户端，只把结果返回给
 *         降级链，由下一个 provider 接手；只有最后一个候选才真正把错误写给客户端。
 */
function proxyRequest(req, res, provider, bodyBuf, model, opts) {
  const softFail = !!(opts && opts.softFail);
  return new Promise((finish) => {
    const started = Date.now();
    const t0 = process.hrtime.bigint();
    let result = { ok: false, status: 502, kind: 'net', message: '未拿到上游响应' };
    let target;
    try {
      target = new URL(provider.baseUrl);
    } catch (_) {
      result = { ok: false, status: 502, kind: 'config', message: `provider ${provider.id} 的 baseUrl 不合法` };
      if (!softFail) sendJson(res, 502, { error: { message: result.message, type: 'gateway_config' } });
      return finish(result);
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
    const retry = (cfg.limits && cfg.limits.retry) || LIMIT_DEFAULTS.retry;
    let attempt = 0;
    let currentReq = null;
    let retryTimer = null;
    let finished = false;
    const done = () => { if (!finished) { finished = true; finish(result); } };
    const canRetry = () => retry.enabled && attempt < retry.maxAttempts &&
      !res.headersSent && !res.writableEnded && !res.destroyed;

    const send = () => {
      attempt++;
      currentReq = transport.request(opts, (upRes) => {
        const status = upRes.statusCode || 0;

        // 软失败：可降级的错误不写客户端，交回降级链换下一家
        if (softFail && !canRetry() && isDegradable(statusKind(status))) {
          const kind = statusKind(status);
          upRes.setEncoding('utf8');
          let errBody = '';
          upRes.on('data', (c) => { if (errBody.length < 2048) errBody += c; });
          upRes.on('end', () => {
            const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
            recordUsage(provider.id, model, status, ms, null);
            logRequest({
              path: req.url.split('?')[0], model: model || '-', provider: provider.id,
              status, ms, at: started, error: `降级：上游 ${status} ${errBody.slice(0, 160)}`
            });
            result = { ok: false, status, kind, message: errBody.slice(0, 400) || ('上游 ' + status) };
            done();
          });
          upRes.on('error', () => { result = { ok: false, status, kind, message: '上游中断' }; done(); });
          return;
        }

        // 429/5xx：还没给客户端写过任何字节，可以整请求重放
        if (canRetry() && (status === 429 || status >= 500)) {
          const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
          recordUsage(provider.id, model, status, ms, null);
          logRequest({
            path: req.url.split('?')[0], model: model || '-', provider: provider.id,
            status, ms, at: started, error: `第 ${attempt} 次尝试 ${status}，${retry.backoffMs * attempt}ms 后重试`
          });
          upRes.resume(); // 丢弃本次响应体
          retryTimer = setTimeout(send, retry.backoffMs * attempt);
          return;
        }

        const outHeaders = forwardHeaders(upRes.headers);
        res.writeHead(status || 502, outHeaders);

        // 只留最后 8KB 用来抠 usage（usage 出现在响应末尾），不缓存完整响应
        const ct = String(upRes.headers['content-type'] || '');
        const collect = status < 300 && (ct.includes('json') || ct.includes('event-stream'));
        let tail = '';
        upRes.on('data', (c) => {
          if (collect) tail = (tail + c.toString('utf8')).slice(-8192);
          res.write(c);
        });
        upRes.on('end', () => {
          res.end();
          const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
          recordUsage(provider.id, model, status, ms, usageToTokens(extractUsage(tail)));
          logRequest({
            path: req.url.split('?')[0],
            model: model || '-',
            provider: provider.id,
            status,
            ms,
            at: started
          });
          result = { ok: status >= 200 && status < 300, status, kind: statusKind(status), message: '' };
          done();
        });
        upRes.on('error', () => {
          try { res.end(); } catch (_) { /* 已关 */ }
          done();
        });
      });

      // 建连阶段 20s 超时（避免上游不可达时无限等待），拿到响应后放宽为 10 分钟空闲超时（长流式任务）
      currentReq.setTimeout(20000, () => currentReq.destroy(new Error('连接上游超时(20s)，请检查网络或 baseUrl')));
      currentReq.on('response', () => {
        currentReq.setTimeout(10 * 60 * 1000, () => currentReq.destroy(new Error('上游 10 分钟无数据，已中断')));
      });
      currentReq.on('error', (err) => {
        const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
        if (canRetry()) {
          // 网络层失败且还没写过任何字节：同样整请求重放
          recordUsage(provider.id, model, 502, ms, null);
          logRequest({
            path: req.url.split('?')[0], model: model || '-', provider: provider.id,
            status: 502, ms, at: started, error: `连接失败(第 ${attempt} 次)：${err.message}，退避重试`
          });
          retryTimer = setTimeout(send, retry.backoffMs * attempt);
          return;
        }
        try {
          recordUsage(provider.id, model, 502, ms, null);
          logRequest({
            path: req.url.split('?')[0], model: model || '-', provider: provider.id,
            status: 502, ms, at: started, error: err.message
          });
          result = { ok: false, status: 502, kind: 'net', message: err.message };
          if (softFail) { done(); return; }
          if (!res.headersSent) {
            sendJson(res, 502, {
              error: { message: `上游请求失败: ${err.message}`, type: 'gateway_upstream_error', provider: provider.id }
            });
          } else {
            try { res.end(); } catch (_) { /* 已断 */ }
          }
        } finally {
          done();
        }
      });
      currentReq.end(bodyBuf && bodyBuf.length ? bodyBuf : undefined);
    };

    res.on('close', () => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } // 客户端已走，别再重试
      if (currentReq && !res.writableEnded) currentReq.destroy();
      done();
    });

    send();
  });
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
      aliases: cfg.aliases,
      fallback: cfg.fallback,
      budget: cfg.budget,
      circuit: cfg.circuit,
      usage: {
        requests: usage.requests,
        errors: usage.errors,
        prompt: usage.prompt,
        completion: usage.completion,
        avgMs: usage.requests ? Math.round(usage.ms / usage.requests) : 0,
        items: Object.values(usage.items).sort((a, b) => b.requests - a.requests)
      },
      budgetState: budgetState(),
      runtime: {
        version: APP_VERSION,
        node: process.version,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        startedAt: localIso(new Date(Date.now() - process.uptime() * 1000)),
        requests: recent.length,
        logBytes,
        logs: cfg.logs,
        logFile: LOG_PATH,
        limits: cfg.limits,
        circuits: circuitSnapshot(),
        lanes: Array.from(provLanes.entries()).map(([id, l]) => ({
          id, running: l.running, queued: l.queue.length
        })).filter((l) => l.running > 0 || l.queued > 0)
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

  /** 单模型真实测活：body { provider, model } */
  if (pathname === '/api/test/model' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const p = cfg.providers.find((x) => x.id === body.provider);
    if (!p) return sendJson(res, 404, { error: { message: 'provider 不存在' } });
    if (!body.model) return sendJson(res, 400, { error: { message: '缺少 model' } });
    const r = await testModel(p, String(body.model));
    recordModelStatus(p.id, String(body.model), r);
    return sendJson(res, 200, r);
  }

  /** 批量模型测活：串行 + 节流（上游常有并发/RPM 限制，并发打会全是 429 假失败） */
  if (pathname === '/api/test/models' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    const delay = clampNum(body.delayMs, 0, 10000, 1200);
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const p = cfg.providers.find((x) => x.id === it.provider);
      if (!p) {
        out.push({ provider: it.provider, model: it.model, ok: false, kind: 'err', status: 0, ms: 0, message: 'provider 不存在' });
      } else {
        const r = await testModel(p, String(it.model || ''));
        recordModelStatus(p.id, String(it.model || ''), r);
        out.push(r);
      }
      if (delay > 0 && i < items.length - 1) await new Promise((r) => setTimeout(r, delay));
    }
    return sendJson(res, 200, { items: out, okCount: out.filter((x) => x.ok).length });
  }

  /** 已持久化的测活结果（界面启动时回填 chip 着色） */
  if (pathname === '/api/test/status' && method === 'GET') {
    return sendJson(res, 200, {
      providers: modelStatusStore.providers,
      lastAutoTestAt: modelStatusStore.lastAutoTestAt,
      autoTest: cfg.autoTest
    });
  }

  /** 开关定时自动测活 */
  if (pathname === '/api/test/auto' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (body.enabled !== undefined) cfg.autoTest.enabled = !!body.enabled;
    if (body.intervalHours !== undefined) cfg.autoTest.intervalHours = clampNum(body.intervalHours, 1, 168, cfg.autoTest.intervalHours);
    saveCfg();
    scheduleAutoTest();
    return sendJson(res, 200, { ok: true, autoTest: cfg.autoTest });
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const limit = Math.min(Number(query.get('limit') || 50), MAX_RECENT);
    return sendJson(res, 200, { items: recent.slice(-limit).reverse() });
  }

  /** 用量统计：总额 + 按 provider/model 明细 */
  if (pathname === '/api/usage' && method === 'GET') {
    const items = Object.values(usage.items)
      .map((it) => Object.assign({}, it, { avgMs: it.requests ? Math.round(it.ms / it.requests) : 0 }))
      .sort((a, b) => b.requests - a.requests);
    return sendJson(res, 200, {
      since: usage.since,
      requests: usage.requests,
      errors: usage.errors,
      prompt: usage.prompt,
      completion: usage.completion,
      total: usage.prompt + usage.completion,
      avgMs: usage.requests ? Math.round(usage.ms / usage.requests) : 0,
      items
    });
  }

  /** 清空用量统计 */
  if (pathname === '/api/usage/clear' && method === 'POST') {
    usage = { since: localIso(new Date()), requests: 0, errors: 0, prompt: 0, completion: 0, ms: 0, items: {} };
    saveUsage();
    return sendJson(res, 200, { ok: true });
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

  /* ---- 策略：别名 / 降级 / 预算 / 熔断 ---- */

  if (pathname === '/api/aliases' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    cfg.aliases = normalizeAliases(body.aliases);
    saveCfg();
    return sendJson(res, 200, { ok: true, aliases: cfg.aliases });
  }

  if (pathname === '/api/fallback' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    cfg.fallback = normalizeFallback(Object.assign({}, cfg.fallback, body));
    saveCfg();
    return sendJson(res, 200, { ok: true, fallback: cfg.fallback });
  }

  if (pathname === '/api/budget' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    cfg.budget = normalizeBudget(Object.assign({}, cfg.budget, body));
    if (body.resetToday) usage.today = null; // 今日计数清零
    rollToday();
    saveUsage();
    saveCfg();
    return sendJson(res, 200, { ok: true, budget: cfg.budget, budgetState: budgetState() });
  }

  if (pathname === '/api/circuit' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    cfg.circuit = normalizeCircuit(Object.assign({}, cfg.circuit, body));
    if (body.reset === true || body.reset === 'all') resetCircuit();
    else if (typeof body.reset === 'string') resetCircuit(body.reset);
    saveCfg();
    return sendJson(res, 200, { ok: true, circuit: cfg.circuit, circuits: circuitSnapshot() });
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
          if (status >= 200 && status < 300) return done({ ok: true, kind: 'ok', status, model: realModel || upstream, message: '可用' });
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

/* ------------------------------------------------------------------ */
/* 测活结果持久化 + 定时自动测活                                        */
/* ------------------------------------------------------------------ */

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

let modelStatusStore = loadModelStatus();
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

/** Responses 代理：翻译 + 透传，返回完成 Promise；429/5xx 未写字节前可整请求重放。
 *  opts.softFail：可降级错误不写客户端，交回降级链（同 proxyRequest） */
function handleResponsesProxy(req, res, provider, body, model, opts) {
  const softFail = !!(opts && opts.softFail);
  return new Promise((finish) => {
  const started = Date.now();
  const t0 = process.hrtime.bigint();
  let result = { ok: false, status: 502, kind: 'net', message: '未拿到上游响应' };

  let target;
  try {
    target = new URL(provider.baseUrl);
  } catch (_) {
    result = { ok: false, status: 502, kind: 'config', message: `provider ${provider.id} 的 baseUrl 不合法` };
    if (!softFail) sendJson(res, 502, { error: { message: result.message, type: 'gateway_config' } });
    return finish(result);
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
  const retry = (cfg.limits && cfg.limits.retry) || LIMIT_DEFAULTS.retry;
  let attempt = 0;
  let currentReq = null;
  let retryTimer = null;
  let finished = false;
  const done = () => { if (!finished) { finished = true; finish(result); } };
  const canRetry = () => retry.enabled && attempt < retry.maxAttempts &&
    !res.headersSent && !res.writableEnded && !res.destroyed;

  const send = () => {
    attempt++;
    currentReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: upstreamPath,
    method: 'POST',
    headers
  }, (upRes) => {
    const status = upRes.statusCode || 502;

    // 429/5xx：尚未给客户端写过任何字节（SSE 头都还没发），整请求重放
    if (canRetry() && (status === 429 || status >= 500)) {
      const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
      recordUsage(provider.id, model, status, ms, null);
      logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status, ms, at: started, error: `第 ${attempt} 次尝试 ${status}，${retry.backoffMs * attempt}ms 后重试` });
      upRes.resume();
      retryTimer = setTimeout(send, retry.backoffMs * attempt);
      return;
    }

    if (status >= 400) {
      const kind = statusKind(status);
      // 软失败：可降级的错误不写客户端，交回降级链
      if (softFail && isDegradable(kind)) {
        let errB = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { if (errB.length < 2048) errB += c; });
        upRes.on('end', () => {
          const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
          logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status, ms, at: started, error: `降级：${status} ${errB.slice(0, 160)}` });
          recordUsage(provider.id, model, status, ms, null);
          result = { ok: false, status, kind, message: errB.slice(0, 400) || ('上游 ' + status) };
          done();
        });
        upRes.on('error', () => { result = { ok: false, status, kind, message: '上游中断' }; done(); });
        return;
      }
      let err = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (c) => { err += c; });
      upRes.on('end', () => {
        const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
        logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status, ms, at: started, error: err.slice(0, 200) });
        recordUsage(provider.id, model, status, ms, null);
        const msg = '上游 ' + status + ': ' + err.slice(0, 600);
        result = { ok: false, status, kind, message: msg };
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
        done();
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
          done();
          return;
        }
        logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status: 200, ms, at: started });
        recordUsage(provider.id, model, 200, ms, usageToTokens(json && json.usage));
        sendJson(res, 200, RSP.chatToResponses(json, model, custom));
        result = { ok: true, status: 200, kind: 'ok', message: '' };
        done();
      });
      upRes.on('error', (e) => {
        if (!res.headersSent) sendJson(res, 502, { error: { message: '上游中断: ' + e.message, type: 'upstream_aborted' } });
        else res.end();
        done();
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
    let streamUsage = null;
    const handleLine = (line) => {
      if (!line || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') { tr.finish(); return; }
      let obj;
      try { obj = JSON.parse(data); } catch (_) { return; }
      if (obj && obj.error) { tr.fail(obj.error.message || JSON.stringify(obj.error)); return; }
      if (obj && obj.usage) streamUsage = obj.usage;   // 流式最后一个 chunk 才带 usage
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
      recordUsage(provider.id, model, 200, ms, usageToTokens(streamUsage));
      result = { ok: true, status: 200, kind: 'ok', message: '' };
      done();
    });
    upRes.on('error', (e) => {
      tr.fail('上游流中断: ' + e.message);
      res.end();
      done();
    });
  });

  currentReq.setTimeout(20000, () => currentReq.destroy(new Error('连接上游超时(20s)，请检查网络或 baseUrl')));
  currentReq.on('response', () => {
    currentReq.setTimeout(10 * 60 * 1000, () => currentReq.destroy(new Error('上游 10 分钟无数据，已中断')));
  });
  currentReq.on('error', (err) => {
    const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
    if (canRetry()) {
      recordUsage(provider.id, model, 502, ms, null);
      logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status: 502, ms, at: started, error: `连接失败(第 ${attempt} 次)：${err.message}，退避重试` });
      retryTimer = setTimeout(send, retry.backoffMs * attempt);
      return;
    }
    try {
      logRequest({ path: '/v1/responses', model: model || '-', provider: provider.id, status: 502, ms, at: started, error: err.message });
      result = { ok: false, status: 502, kind: 'net', message: err.message };
      if (softFail) { done(); return; }
      if (!res.headersSent) {
        sendJson(res, 502, { error: { message: `上游请求失败: ${err.message}`, type: 'gateway_upstream_error', provider: provider.id } });
      } else {
        try { res.end(); } catch (_) { /* 已断 */ }
      }
    } finally {
      done();
    }
  });

  res.on('close', () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (currentReq && !res.writableEnded) currentReq.destroy();
    done();
  });

  currentReq.end(payload);
  };
  });
}

/* ------------------------------------------------------------------ */
/* 主服务                                                              */
/* ------------------------------------------------------------------ */

/** 在途请求计数，优雅退出时要等它们走完 */
let inFlight = 0;
let shuttingDown = false;

function trackRequest(res) {
  inFlight++;
  let done = false;
  const dec = () => { if (!done) { done = true; inFlight--; } };
  res.on('finish', dec);
  res.on('close', dec);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  if (shuttingDown) {
    return sendJson(res, 503, { error: { message: '网关正在退出，请稍后重试', type: 'gateway_shutting_down' } });
  }
  trackRequest(res);

  try {
    if (pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        active: cfg.active,
        activeModel: cfg.activeModel || null,
        modelPolicy: cfg.modelPolicy,
        providers: cfg.providers.length,
        uptime: Math.round(process.uptime()),
        inFlight,
        shuttingDown
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

    // 预算：超限且策略为 reject 时，在转发前直接挡掉
    const bud = budgetState();
    if (bud.enabled && bud.action === 'reject' && bud.exceeded) {
      return sendJson(res, 429, {
        error: {
          message: `今日预算已用尽（${bud.over.join(' / ')}），网关暂停转发。可在「策略 → 每日预算」调整或清零。`,
          type: 'gateway_budget_exceeded',
          budget: bud
        }
      });
    }

    // 模型别名：客户端写 fast/smart/cheap 也能路由到具体模型
    const aliased = applyAlias(model);
    if (aliased.alias) model = aliased.model;

    const picked = resolveTarget(model, anthropic, !!(aliased && aliased.alias));
    if (!picked.provider) {
      return sendJson(res, 503, { error: { message: '没有可用的 provider，请先在管理界面添加', type: 'gateway_no_provider' } });
    }

    // 客户端显式写了 "providerId/model" 时不降级（用户已明确指定）
    const explicit = !!(model && model.includes('/'));
    const cands = buildCandidates(picked.provider, explicit);
    const baseModel = (mapModel(picked.provider, picked.model) || picked.model);

    let lastRes = null;
    let used = null;
    for (let i = 0; i < cands.length; i++) {
      const p = cands[i];
      // 只有"原本选定的那个 provider"才沿用原模型名；其余（含主熔断让位后的新主）
      // 都要按目标 provider 重新解析，否则会把别家的模型名发过去导致 403/404
      const m = (p.id === picked.provider.id)
        ? baseModel
        : mapModel(p, resolveFallbackModel(p, baseModel));
      const softFail = i < cands.length - 1;

      let body = rawBody;
      if (parsed && m) {
        parsed.model = m;
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
      }

      const useResponses = parsed && pathname.replace(/\/+$/, '') === '/v1/responses' &&
        !anthropic && p.upstreamResponses !== true;

      let r = null;
      try {
        r = await withLane(p.id, () => (useResponses
          ? handleResponsesProxy(req, res, p, parsed, m, { softFail })
          : proxyRequest(req, res, p, body, m, { softFail })), res);
      } catch (e) {
        if (e && e.code === 'QUEUE_TIMEOUT') {
          r = { ok: false, status: 503, kind: 'upstream', message: e.message }; // 上游太忙也算可降级
        } else {
          throw e;
        }
      }

      noteUpstreamResult(p.id, !!(r && r.ok), r && r.kind, r && r.message);
      if (r && r.ok) {
        used = { provider: p.id, model: m, hop: i };
        break;
      }
      lastRes = r || { ok: false, status: 502, kind: 'net', message: '未拿到上游响应' };
      if (i === cands.length - 1) return; // 最后一个候选负责把错误写给客户端
      if (!isDegradable(lastRes.kind)) break;
    }

    if (!used) {
      // 走到这里说明提前放弃（错误不可降级），此时客户端还没收到任何响应
      const pid = cands[Math.min(cands.length - 1, Math.max(0, cands.length - 1))].id;
      sendJson(res, lastRes.status || 502, {
        error: {
          message: lastRes.message || '上游请求失败',
          type: lastRes.kind === 'rate' ? 'upstream_rate_limited' : 'upstream_error',
          provider: pid,
          kind: lastRes.kind
        }
      });
    } else if (used.hop > 0) {
      console.log(`[llm-gateway] 已降级到第 ${used.hop} 候选：${used.provider} / ${used.model}`);
    }
  } catch (e) {
    if (e && e.code === 'QUEUE_TIMEOUT') {
      return sendJson(res, 503, { error: { message: e.message, type: 'gateway_queue_timeout' } });
    }
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
  scheduleAutoTest();
});

/** 优雅退出：停收新请求 → 等在途完成（最多 15s）→ 退出 */
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[llm-gateway] 收到 ${sig}，停止接收新请求，等待 ${inFlight} 个在途请求…`);
  try { server.close(); } catch (_) {}
  const t0 = Date.now();
  while (inFlight > 0 && Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`[llm-gateway] 在途 ${inFlight} 个，退出`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[llm-gateway] uncaught:', e.message));
