'use strict';
/**
 * 每 provider 串行队列（车道）+ 熔断。
 * 上游常有"并发=1"的硬限制，直接透传会导致并发的两个请求互相挤掉对方。
 * 熔断：某 provider 连续失败到阈值后短路一段时间，避免每个请求都白等超时。
 */

const { cfg, LIMIT_DEFAULTS } = require('./config');

/* ---- 串行车道 ---- */

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
      if (e && e.code === 'CLIENT_ABORTED') return undefined; // 排队中被取消，没占到车道，无需释放
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

/* ---- 熔断 ---- */

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

module.exports = {
  provLanes, laneOf, pumpLane, acquireLane, releaseLane, withLane,
  circuits, circuitOpen, circuitSnapshot, noteUpstreamResult, resetCircuit
};
