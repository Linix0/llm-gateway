'use strict';
/** 通用工具：HTTP 响应、请求体、头转发、静态资源、错误分类。 */

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR, MAX_BODY } = require('./config');

/** HTTP 状态 -> 错误类型（与降级/测活的 kind 口径一致） */
function statusKind(status) {
  if (status === 429) return 'rate';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'missing';
  if (status === 400 || status === 422) return 'reject';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'reject';
  return 'ok';
}

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

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

module.exports = {
  statusKind, localIso, readBody, sendJson, forwardHeaders, HOP_BY_HOP, MIME, serveStatic
};
