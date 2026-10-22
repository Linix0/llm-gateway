'use strict';
/** 管理 API：/api/* 与静态模型列表之外的所有管理端点。 */

const fs = require('fs');
const path = require('path');
const {
  cfg, APP_VERSION, DATA_DIR, LOG_PATH, LOG_ARCHIVE_RE, LOG_DEFAULTS,
  clampNum, saveCfg, reloadCfg, resolveKey, maskKey, reconcileActiveModel,
  normalizeAliases, normalizeFallback, normalizeBudget, normalizeCircuit
} = require('./config');
const { sendJson, readBody, localIso } = require('./util');
const { recent, MAX_RECENT, logFiles, resetLogBytes, logBytes } = require('./logger');
const { usage, saveUsage, budgetState, rollToday } = require('./usage');
const { provLanes, circuitSnapshot, resetCircuit } = require('./queue');
const { testProvider, testModel, recordModelStatus, modelStatusStore, scheduleAutoTest } = require('./tester');

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
    reconcileActiveModel(cfg);
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

  /** 清空用量统计（原地清空，usage 是共享单例，不能重新赋值） */
  if (pathname === '/api/usage/clear' && method === 'POST') {
    for (const k of Object.keys(usage)) delete usage[k];
    Object.assign(usage, { since: localIso(new Date()), requests: 0, errors: 0, prompt: 0, completion: 0, ms: 0, items: {}, today: null });
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
    resetLogBytes();
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
    reloadCfg();
    return sendJson(res, 200, { ok: true, active: cfg.active });
  }

  return sendJson(res, 404, { error: { message: 'not found' } });
}

module.exports = { handleAdmin };
