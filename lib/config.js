'use strict';
/**
 * 配置模块：默认配置、归一化、加载/保存（原子写）、密钥解析。
 * cfg 为单例对象，热加载时原地修改（引用不更换），其他模块可放心持有引用。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
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

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

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

/** activeModel 与 active provider 对不上时，尽量纠正成一致的一组 */
function reconcileActiveModel(conf) {
  if (!conf || !conf.activeModel) return;
  const act = conf.providers.find((p) => p.id === conf.active);
  if (act && act.models.some((m) => m.id === conf.activeModel)) return;
  const owner = conf.providers.find((p) => p.models.some((m) => m.id === conf.activeModel));
  if (owner) conf.active = owner.id;
}

/** 从磁盘读出一份新的配置对象（不影响 cfg 单例） */
function loadCfg() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CFG_PATH)) {
    fs.writeFileSync(CFG_PATH, JSON.stringify(DEFAULT_CFG, null, 2), 'utf8');
  }
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const out = {
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
  out.providers.forEach((p) => {
    p.id = String(p.id || p.name || '').trim();
    p.api = (p.api || 'openai').toLowerCase();
    p.baseUrl = String(p.baseUrl || '').trim();
    p.models = Array.isArray(p.models) ? p.models : [];
  });
  reconcileActiveModel(out);
  return out;
}

/** 配置单例。启动时由 reloadCfg() 填充；热加载时原地替换字段，引用保持不变。 */
const cfg = {};

/** 重新从磁盘加载并原地覆盖 cfg 单例的所有字段 */
function reloadCfg() {
  const fresh = loadCfg();
  for (const k of Object.keys(cfg)) delete cfg[k];
  Object.assign(cfg, fresh);
  return cfg;
}

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

module.exports = {
  ROOT, APP_VERSION, DATA_DIR, CFG_PATH, LOG_PATH, PUBLIC_DIR, MAX_BODY,
  DEFAULT_CFG, LOG_DEFAULTS, LOG_ARCHIVE_RE, LIMIT_DEFAULTS, DEGRADABLE_KINDS, ALL_DEGRADE_KINDS,
  clampNum, ensureDir,
  normalizeAliases, normalizeFallback, normalizeBudget, normalizeCircuit, reconcileActiveModel,
  cfg, reloadCfg, saveCfg, resolveKey, maskKey
};
