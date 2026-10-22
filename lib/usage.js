'use strict';
/** 用量统计 + 每日预算：按 provider+model 累计请求数 / token / 耗时 / 失败率。 */

const fs = require('fs');
const path = require('path');
const { cfg, DATA_DIR } = require('./config');
const { localIso } = require('./util');

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

/** 用量单例：启动时加载一次，之后原地累加（引用不更换） */
const usage = loadUsage();
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

module.exports = {
  usage, saveUsage, scheduleUsageSave,
  budgetDayKey, rollToday, budgetState,
  recordUsage, extractUsage, usageToTokens
};
