#!/usr/bin/env node
'use strict';
/**
 * LLM Gateway - 本地大模型统一代理（主入口）
 * 零依赖，仅使用 Node 内置模块。
 *
 * 模块结构（均在 lib/ 下，按需组合，均只依赖 Node 内置模块）：
 *   config.js     配置单例、归一化、原子写、密钥解析
 *   util.js       HTTP 工具（readBody/sendJson/forwardHeaders/serveStatic/statusKind）
 *   logger.js     请求日志：内存最近记录 + JSONL 落盘 + 按大小轮转
 *   usage.js      用量统计 + 每日预算
 *   queue.js      每 provider 串行车道 + 熔断
 *   routing.js    协议判断、别名、降级链、provider/模型解析、模型列表
 *   proxy.js      代理核心：proxyRequest（透传）+ handleResponsesProxy（协议翻译）
 *   tester.js     连通性/模型级测活、结果持久化、定时自动巡检
 *   admin-api.js  管理 API（/api/*）
 *   responses-adapter.js  Codex Responses ⇄ chat/completions 协议翻译
 */

const http = require('http');
const { cfg, reloadCfg, ensureDir, DATA_DIR } = require('./lib/config');
const { sendJson, readBody, serveStatic } = require('./lib/util');
const { budgetState } = require('./lib/usage');
const {
  applyAlias, resolveTarget, buildCandidates, resolveFallbackModel, mapModel,
  isModelPath, isAnthropicPath, isDegradable, listModels
} = require('./lib/routing');
const { withLane, noteUpstreamResult } = require('./lib/queue');
const { proxyRequest, handleResponsesProxy } = require('./lib/proxy');
const { handleAdmin } = require('./lib/admin-api');
const { scheduleAutoTest } = require('./lib/tester');

// 启动：从磁盘加载配置进 cfg 单例
reloadCfg();

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
      const pid = cands[cands.length - 1].id;
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
