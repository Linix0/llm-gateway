'use strict';
/**
 * 代理核心：通用透传 proxyRequest + Responses 适配 handleResponsesProxy。
 * 两者都返回"响应彻底结束"的 Promise，供 withLane 排队与优雅退出使用。
 *
 * 重试：仅当还没给客户端写过任何字节（headersSent=false）且状态为 429/5xx 或网络错误时
 *       整请求重放（body 可重用）；一旦开始流式输出就绝不再试。
 * 软失败：opts.softFail=true 时，可降级的错误（429/5xx/网络）不写客户端，只把结果返回给
 *         降级链，由下一个 provider 接手；只有最后一个候选才真正把错误写给客户端。
 */

const http = require('http');
const https = require('https');
const RSP = require('./responses-adapter');
const { cfg, LIMIT_DEFAULTS, resolveKey } = require('./config');
const { statusKind, sendJson, forwardHeaders } = require('./util');
const { logRequest } = require('./logger');
const { recordUsage, extractUsage, usageToTokens } = require('./usage');
const { joinUpstream, isDegradable } = require('./routing');

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

    const opts2 = {
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
      console.log('[proxy]', req.method, provider.id, opts2.hostname + upstreamPath, 'body=' + (bodyBuf ? bodyBuf.length : 0));
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
      currentReq = transport.request(opts2, (upRes) => {
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

  send(); // 必须显式发起：漏了这行请求永远不发出，Promise 挂起 → 车道永久占用
  });
}

module.exports = { proxyRequest, handleResponsesProxy, sseWrite };
