'use strict';
/**
 * 路由：协议/路径判断、别名、降级链、provider 与模型解析、模型列表。
 */

const { cfg, DEGRADABLE_KINDS } = require('./config');
const { circuitOpen } = require('./queue');

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

/* ---- 别名与降级链 ---- */

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
 * - 熔断中的 provider 跳过（含主 provider 让位给备用——这正是熔断的意义）
 * - 全都熔断时仍然尝试主供应商，保证客户端至少能拿到一个明确错误
 */
function buildCandidates(primary, explicit) {
  const hops = cfg.fallback.maxHops || 1;
  const out = [];
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
  if (!out.length) out.push(primary);
  return out.slice(0, hops + 1);
}

/** 这个错误值不值得换一家再试 */
function isDegradable(kind) {
  return DEGRADABLE_KINDS.has(kind) && cfg.fallback.onKinds.includes(kind);
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
 *  - 别名（aliased=true）：管理员显式定义的语义路由，优先级高于「网关固定」
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

/** GET /v1/models 返回的清单：合并所有 provider 的模型，重复模型名优先 active */
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

module.exports = {
  joinUpstream, isAnthropicPath, isModelPath,
  applyAlias, resolveFallbackModel, buildCandidates, isDegradable,
  pickProvider, mapModel, resolveTarget, listModels
};
