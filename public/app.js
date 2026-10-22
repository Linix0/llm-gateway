'use strict';
/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let state = { server: { host: '127.0.0.1', port: 8787 }, providers: [], active: '', runtime: {} };
let selId = null;
let isNew = false;
let dirty = false;
let provStatus = {};
/** 模型级测活结果：providerId -> { modelId: result } */
const modelStatus = {};
let provOpen = new Set();
let provFilter = '';
let logs = [];
let logFilter = 'all';
let logMeta = null;
let snipKey = 'codex';
let autoTimer = null;

const LS_THEME = 'lg.theme';
const LS_AUTO = 'lg.autorefresh';
const LS_COLLAPSE = 'lg.collapsed';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts));
  let j = {};
  try { j = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j;
}

function toast(msg, kind) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'info');
  const ico = kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i';
  el.innerHTML = `<span class="ico">${ico}</span><span>${escapeHtml(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, 2800);
}

function copyText(text) {
  const done = () => toast('已复制到剪贴板', 'ok');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (_) { toast('复制失败，请手动选取', 'err'); }
  ta.remove();
}

function fmtUptime(sec) {
  if (!sec && sec !== 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分`;
  return `${Math.max(1, Math.round(sec))} 秒`;
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 HH:MM:SS；跨天时带上月/日 */
function fmtLogTime(item) {
  const d = item.at ? new Date(item.at) : item.ts ? new Date(item.ts) : null;
  if (!d || isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (sameDay) return t;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return (sameYear ? md : `${d.getFullYear()}/${md}`) + ' ' + t;
}

function fmtLogFull(item) {
  const d = item.at ? new Date(item.at) : item.ts ? new Date(item.ts) : null;
  if (!d || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function confirmBox(title, desc, okText) {
  return new Promise((resolve) => {
    $('#mTitle').textContent = title;
    $('#mDesc').textContent = desc || '';
    $('#mOk').textContent = okText || '确定';
    const bd = $('#backdrop');
    bd.hidden = false;
    const close = (v) => { bd.hidden = true; $('#mOk').onclick = null; $('#mCancel').onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); if (e.key === 'Enter') close(true); };
    $('#mOk').onclick = () => close(true);
    $('#mCancel').onclick = () => close(false);
    document.addEventListener('keydown', onKey);
    setTimeout(() => $('#mCancel').focus(), 30);
  });
}

function setDirty(v) {
  dirty = v;
  $('#dirtyTag').hidden = !v;
}

/* ------------------------------------------------------------------ */
/* 折叠                                                                */
/* ------------------------------------------------------------------ */
let collapsed = new Set();
(function initCollapse() {
  const raw = localStorage.getItem(LS_COLLAPSE);
  if (raw === null) collapsed = new Set();
  else { try { collapsed = new Set(JSON.parse(raw)); } catch (_) { collapsed = new Set(); } }
})();

function applyCollapse() {
  $$('.card[data-cid]').forEach((c) => c.classList.toggle('collapsed', collapsed.has(c.dataset.cid)));
}
function toggleCard(id, force) {
  const willCollapse = force === undefined ? !collapsed.has(id) : force;
  if (willCollapse) collapsed.add(id); else collapsed.delete(id);
  localStorage.setItem(LS_COLLAPSE, JSON.stringify(Array.from(collapsed)));
  applyCollapse();
}

$$('[data-toggle]').forEach((h) => {
  h.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select, label')) return;
    toggleCard(h.dataset.toggle);
  });
});
$$('[data-sec]').forEach((h) => {
  h.addEventListener('click', (e) => {
    if (e.target.closest('.help-btn')) return;
    h.closest('.sec').classList.toggle('collapsed');
  });
});

/* ------------------------------------------------------------------ */
/* 分页导航                                                            */
/* ------------------------------------------------------------------ */
const LS_PAGE = 'lg.page';

function showPage(id) {
  const page = document.getElementById('page-' + id);
  if (!page) return;
  $$('.page').forEach((p) => p.classList.toggle('on', p === page));
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('on', b.dataset.page === id));
  localStorage.setItem(LS_PAGE, id);
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  if (id === 'snippets') toggleCard('snip', false); // 片段页独占一屏，默认展开
  if (helpEl) hideHelp();
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (b) showPage(b.dataset.page);
});
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && document.getElementById('page-' + id)) showPage(id);
});

/* ------------------------------------------------------------------ */
/* 帮助释意（? 按钮 → 浮层）                                            */
/* ------------------------------------------------------------------ */
const HELP = {
  route: {
    t: '当前调用模型',
    b: '<p>决定每个请求<b>实际打到哪个模型</b>。两种策略：</p>' +
       '<p><b>网关固定</b>：客户端（Codex / Cursor…）里写什么模型名都会被替换成这里选的模型。换模型只需要在网关上点一下，客户端完全不用改。<br />' +
       '<b>跟随客户端</b>：按客户端传来的模型名路由，匹配不到时用这里的设置兜底。</p>' +
       '<p>例外：模型名写成 <span class="mono">providerId/modelId</span>（如 <span class="mono">nextapi/deepseek-v4.1-flash</span>）时，无论哪种策略都会精确路由到指定供应商的指定模型。</p>'
  },
  providers: {
    t: '供应商（Provider）',
    b: '<p>一个供应商 = 一家上游服务（中转站、官方 API、自建服务…），包含地址、协议、key 和模型清单。</p>' +
       '<p>点击列表项可在右侧编辑；<b>当前</b> 标签表示请求默认走它。展开箭头可看它下面的模型，芯片颜色是上次测活结果：绿 = 可用、黄 = 限流未验证、红 = 不可用。</p>' +
       '<p>「全部测连接」只验证地址与 key（查模型列表）；「测所有模型」会真实调用每个模型验证可用性。</p>'
  },
  editor: {
    t: '编辑供应商',
    b: '<p>修改选中供应商的配置，改完记得点 <b>保存</b>（或 <span class="mono">Ctrl+S</span>）。</p>' +
       '<p><b>协议</b>决定转发方式：OpenAI 兼容走 <span class="mono">/v1/chat/completions</span>，Anthropic 走 <span class="mono">/v1/messages</span>。' +
       'API Key 建议 写 <span class="mono">env:变量名</span>，避免明文 key 存在配置文件里；留空保存不会改动已存的 key。</p>' +
       '<p>「设为当前」把请求默认切到这个供应商；「测试连接」只验证地址和 key 是否有效。</p>'
  },
  models: {
    t: '模型列表',
    b: '<p>声明这个供应商提供哪些模型。每行三个字段：</p>' +
       '<p><b>模型 ID</b>：发给上游的真实模型名（必填）；<b>显示名</b>：只在界面上展示（可选）；<b>上下文</b>：写进 <span class="mono">/v1/models</span> 的 contextWindow，留空用上游默认。</p>' +
       '<p>⚡ 按钮对这个模型<b>真实测活</b>：发一次 <span class="mono">max_tokens=1</span> 的极小请求（成本可忽略），返回真实可用性；批量测活串行执行，避免触发上游限速。429 只代表限流，不代表模型坏了。</p>'
  },
  snippets: {
    t: '客户端接入',
    b: '<p>把 Codex / Cursor / Claude Code 等客户端指向本网关的配置片段，选好客户端类型后一键复制粘贴即可。</p>' +
       '<p>片段里的 key 统一填 <span class="mono">local</span> 占位：<b>真实 key 由网关在转发时注入</b>，客户端本机不保存任何密钥，换上游也不用动客户端。</p>'
  },
  usage: {
    t: '用量统计',
    b: '<p>按 供应商/模型 累计的请求数、失败数、输入/输出 token 和平均耗时，数据来自上游返回的 usage 字段（流式取最后一个 chunk），每 5 秒落盘一次。</p>' +
       '<p>用途：观察哪个模型用得最多、失败率是否异常、测活等操作消耗了多少 token。「清零」只清统计数字，不影响日志和配置。</p>'
  },
  logs: {
    t: '请求日志',
    b: '<p>经过网关的每个请求一行：状态码、供应商、模型、路径、耗时、时间。点「策略」可配置日志轮转（单文件上限 / 保留归档份数），超限自动滚动，不会无限增长。</p>' +
       '<p>默认 4 秒自动刷新，可关闭。排查问题时切「仅失败」快速看错误请求；错误详情在 <span class="mono">data/requests.log</span> 的 JSONL 里。</p>'
  },
  alias: {
    t: '模型别名',
    b: '<p>给模型起一个固定的短名字，客户端只写别名，真实模型在网关上随时换。</p>' +
       '<p>例如 <span class="mono">fast</span> → <span class="mono">nextapi/deepseek-v4.1-flash</span>：以后想换模型只改别名指向，客户端配置一行都不用动。</p>' +
       '<p>每一行选一个「供应商 + 模型」；供应商留「按模型名自动匹配」时只记录模型名，按正常路由规则匹配。别名优先于「网关固定」策略。</p>'
  },
  fallback: {
    t: '失败降级',
    b: '<p>主供应商失败时自动换下一家重试，避免一个上游限流就把整个客户端卡住。</p>' +
       '<p><b>备用供应商</b>按点击顺序排优先级；<b>最多降级次数</b>限制单个请求尝试几个供应商；' +
       '<b>触发条件</b>决定哪些错误值得换一家（限流、上游故障、网络超时等）。参数错误 400 不会降级——换一家也一样。</p>' +
       '<p>降级时模型名按「同名模型 → 下面指定的映射 → 该供应商第一个模型」决定。注意降级会产生额外的上游调用。</p>'
  },
  budget: {
    t: '每日预算',
    b: '<p>按天统计请求数与输入/输出 token，到达上限后<b>仅告警</b>或<b>直接拒绝</b>请求（拒绝时返回 429）。</p>' +
       '<p>每天在设定的时刻（默认凌晨 4 点，本地时区）自动开启新一天。填 0 表示该项不限。</p>' +
       '<p>用途：防止脚本失控烧额度、测活与自动巡检的消耗心里有数。「今日清零」只重置当天计数。</p>'
  },
  circuit: {
    t: '熔断保护',
    b: '<p>某个供应商连续失败到设定次数后，短时间内直接跳过它，不再让每个请求白等超时。</p>' +
       '<p>熔断中的供应商会被降级链自动跳过；冷却结束后首次成功即清零计数。适合上游整段不可用、或 key 失效时快速失败而不是拖慢整个客户端。</p>'
  }
};

let helpEl = null;

function hideHelp() {
  if (helpEl) { helpEl.remove(); helpEl = null; }
}

function showHelp(key, anchor) {
  hideHelp();
  const h = HELP[key];
  if (!h) return;
  helpEl = document.createElement('div');
  helpEl.className = 'help-pop';
  helpEl.innerHTML = `<h4>${h.t}</h4>${h.b}`;
  document.body.appendChild(helpEl);
  const r = anchor.getBoundingClientRect();
  const w = helpEl.offsetWidth;
  const hh = helpEl.offsetHeight;
  let x = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
  let y = r.bottom + 9;
  if (y + hh > window.innerHeight - 12) y = Math.max(12, r.top - hh - 9);
  helpEl.style.left = x + 'px';
  helpEl.style.top = y + 'px';
}

$$('.help-btn').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (helpEl && helpEl.dataset.k === b.dataset.help) { hideHelp(); return; }
    showHelp(b.dataset.help, b);
    helpEl.dataset.k = b.dataset.help;
  });
});
document.addEventListener('click', (e) => {
  if (helpEl && !e.target.closest('.help-pop') && !e.target.closest('.help-btn')) hideHelp();
});

/* ------------------------------------------------------------------ */
/* 渲染：当前调用模型                                                  */
/* ------------------------------------------------------------------ */
function ctxLabel(m) {
  const n = Number(m && m.contextWindow);
  if (!n) return '';
  return n >= 1024 ? ' · ' + Math.round(n / 1024) + 'K' : '';
}

function renderRoute() {
  const sel = $('#modelSelect');
  const cur = state.activeModel;
  const groups = state.providers.map((p) => {
    const opts = (p.models || []).map((m) => {
      const val = p.id + '::' + m.id;
      const on = p.id === state.active && m.id === cur ? ' selected' : '';
      return `<option value="${escapeHtml(val)}"${on}>${escapeHtml(m.name || m.id)} — ${escapeHtml(m.id)}${ctxLabel(m)}</option>`;
    }).join('');
    return opts ? `<optgroup label="${escapeHtml(p.name || p.id)} (${escapeHtml(p.id)})">${opts}</optgroup>` : '';
  }).join('');

  sel.innerHTML = groups || '<option value="">（还没有模型）</option>';
  sel.disabled = !groups;

  const ap = state.providers.find((p) => p.id === state.active);
  const am = ap && (ap.models || []).find((m) => m.id === cur);
  const fixed = state.modelPolicy === 'fixed';
  $$('#policySeg button').forEach((b) => b.classList.toggle('on', b.dataset.p === state.modelPolicy));

  if (!groups) {
    $('#routeMeta').innerHTML = '先在左边加一个供应商和模型。';
    return;
  }
  if (fixed) {
    if (!cur) {
      $('#routeMeta').innerHTML = '<span class="warn-t">固定模式下还没选模型</span>，选一个即可生效。';
    } else {
      $('#routeMeta').innerHTML =
        `请求固定走 <b>${escapeHtml(state.active)}</b> / <b>${escapeHtml(cur)}</b>${am ? ctxLabel(am) : ''}。<br />` +
        `客户端里写什么模型名都不影响；要临时指定别的，写成 <b>providerId/modelId</b>。`;
    }
  } else {
    $('#routeMeta').innerHTML =
      `按客户端传来的模型名路由，<b>${escapeHtml(state.active)}</b> 作为兜底` +
      (cur ? `（默认 <b>${escapeHtml(cur)}</b>）` : '') + '。<br />客户端没传模型时用这里的设置。';
  }
}

/* ------------------------------------------------------------------ */
/* 渲染：provider 列表                                                  */
/* ------------------------------------------------------------------ */
function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return url || ''; }
}

function renderList() {
  const el = $('#list');
  $('#provCount').textContent = state.providers.length;
  $('#provTools').hidden = state.providers.length < 5;

  if (!state.providers.length) {
    el.innerHTML = '<li class="empty">还没有配置<br />点右上角「新增」加一个上游</li>';
    return;
  }

  const kw = provFilter.trim().toLowerCase();
  const list = kw
    ? state.providers.filter((p) =>
        (p.name || '').toLowerCase().includes(kw) ||
        p.id.toLowerCase().includes(kw) ||
        (p.baseUrl || '').toLowerCase().includes(kw) ||
        (p.models || []).some((m) => (m.id || '').toLowerCase().includes(kw)))
    : state.providers;

  if (!list.length) {
    el.innerHTML = '<li class="empty">没有匹配的供应商</li>';
    return;
  }

  el.innerHTML = list.map((p) => {
    const st = provStatus[p.id] || '';
    const models = p.models || [];
    const tags = [
      p.id === state.active ? '<span class="tag cur">当前</span>' : '',
      p.api === 'anthropic' ? '<span class="tag a">A</span>' : '<span class="tag o">O</span>',
      p.hasKey ? '' : '<span class="tag warn">无KEY</span>'
    ].join('');
    const open = provOpen.has(p.id);
    return `<li class="prov ${p.id === selId ? 'sel' : ''} ${open ? 'open' : ''}" data-id="${escapeHtml(p.id)}">
      <div class="prov-row" role="button" tabindex="0">
        <span class="pstatus ${st}"></span>
        <div class="info">
          <div class="nm"><span class="t">${escapeHtml(p.name || p.id)}</span>${tags}</div>
          <div class="mt">${escapeHtml(hostOf(p.baseUrl))} · ${models.length} 模型</div>
        </div>
        <button class="prov-more" title="展开模型" aria-label="展开模型">▶</button>
      </div>
      ${models.length ? `<div class="prov-models">${models.slice(0, 40).map((m) => {
        const ms = (modelStatus[p.id] || {})[m.id];
        const cls = [m.id === state.activeModel ? 'cur' : '', ms ? (ms.kind === 'ok' ? 'ok' : ms.kind === 'rate' ? 'rate' : 'bad') : ''].filter(Boolean).join(' ');
        const tip = ms ? `${m.id} · ${ms.ok ? '可用' : KIND_TEXT[ms.kind] || '失败'}${ms.status ? ' · HTTP ' + ms.status : ''}${ms.ms != null ? ' · ' + ms.ms + 'ms' : ''}${ms.message && !ms.ok ? '\n' + ms.message : ''}` : m.id;
        return `<span class="mchip ${cls}" title="${escapeHtml(tip)}">${escapeHtml(m.id)}</span>`;
      }).join('')}</div>` : ''}
    </li>`;
  }).join('');

  el.querySelectorAll('.prov').forEach((n) => {
    const id = n.dataset.id;
    const go = () => selectProvider(id);
    n.querySelector('.prov-row').onclick = go;
    n.querySelector('.prov-row').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    n.querySelector('.prov-more').onclick = (e) => {
      e.stopPropagation();
      if (provOpen.has(id)) provOpen.delete(id); else provOpen.add(id);
      renderList();
    };
  });
}

/* ------------------------------------------------------------------ */
/* 渲染：模型行                                                        */
/* ------------------------------------------------------------------ */
function addModelRow(m) {
  const row = document.createElement('div');
  row.className = 'mrow';
  row.innerHTML = `
    <input class="mid mono" placeholder="模型 ID" value="${escapeHtml(m && m.id ? m.id : '')}" autocomplete="off" spellcheck="false" />
    <input class="mname" placeholder="显示名（可选）" value="${escapeHtml(m && m.name ? m.name : '')}" autocomplete="off" />
    <input class="mctx mono" placeholder="上下文" inputmode="numeric" value="${escapeHtml(m && m.contextWindow ? m.contextWindow : '')}" autocomplete="off" />
    <span class="mstate" title="尚未测活"></span>
    <button class="icon-btn mtest" title="测活这个模型（发一次 max_tokens=1 的极小请求）" aria-label="测活这个模型" style="width:26px;height:26px;font-size:11px">⚡</button>
    <button class="icon-btn danger" title="删除这一行" aria-label="删除这一行" style="width:26px;height:26px;font-size:11px">✕</button>`;
  row.querySelector('.icon-btn.danger').onclick = () => {
    row.remove();
    if (!$$('#modelRows .mrow').length) addModelRow();
    updateModelCount();
    setDirty(true);
  };
  row.querySelector('.mtest').onclick = () => {
    const id = row.querySelector('.mid').value.trim();
    if (!id) return toast('先填模型 ID', 'err');
    if (isNew || !selId) return toast('先保存供应商再测活', 'err');
    runModelTests(selId, [id], [row]);
  };
  row.querySelectorAll('input').forEach((i) => (i.oninput = () => setDirty(true)));
  $('#modelRows').appendChild(row);
  updateModelCount();
}

function updateModelCount() {
  const rows = $$('#modelRows .mrow');
  const n = rows.filter((r) => r.querySelector('.mid').value.trim()).length;
  $('#modelCount').textContent = n;
  $('#modelRows').classList.toggle('scroll', rows.length > 8);
}

function modelsFromRows() {
  return $$('#modelRows .mrow').map((r) => {
    const id = r.querySelector('.mid').value.trim();
    if (!id) return null;
    const name = r.querySelector('.mname').value.trim();
    const ctxRaw = r.querySelector('.mctx').value.trim();
    const m = { id };
    if (name) m.name = name;
    if (ctxRaw && !isNaN(Number(ctxRaw))) m.contextWindow = Number(ctxRaw);
    return m;
  }).filter(Boolean);
}

function setModelRows(models) {
  const box = $('#modelRows');
  box.innerHTML = '';
  (models && models.length ? models : [{}]).forEach((m) => addModelRow(m));
  updateModelCount();
  paintRowsFromStatus();
}

/* ------------------------------------------------------------------ */
/* 策略：别名 / 降级 / 预算 / 熔断                                      */
/* ------------------------------------------------------------------ */

let fbOrder = [];
let policyReady = false;

/* ---- 别名 ---- */

/** 某供应商的模型 id 列表；pid 为空时返回全库去重 */
function modelIdsOf(pid) {
  const out = [];
  const push = (id) => { if (id && out.indexOf(id) < 0) out.push(id); };
  (state.providers || []).forEach((p) => {
    if (!pid || p.id === pid) (p.models || []).forEach((m) => push(m.id));
  });
  return out;
}

function providerOptions(sel) {
  return '<option value="">按模型名自动匹配</option>' +
    (state.providers || []).map((p) => {
      const label = p.name && p.name !== p.id ? `${p.id} · ${p.name}` : p.id;
      return `<option value="${escapeHtml(p.id)}"${p.id === sel ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
}

function modelOptions(pid, sel, emptyText) {
  const ids = modelIdsOf(pid);
  if (sel && ids.indexOf(sel) < 0) ids.unshift(sel);
  return `<option value="">${escapeHtml(emptyText || '选择模型…')}</option>` +
    ids.map((m) => `<option value="${escapeHtml(m)}"${m === sel ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');
}

/** "providerId/modelId" -> {pid, mid}；前半段不是已知供应商时视为纯模型名 */
function splitTarget(t) {
  const i = (t || '').indexOf('/');
  if (i > 0) {
    const head = t.slice(0, i);
    if ((state.providers || []).some((p) => p.id === head)) return { pid: head, mid: t.slice(i + 1) };
  }
  return { pid: '', mid: t || '' };
}

function addAliasRow(name, target) {
  const { pid, mid } = splitTarget(target);
  const row = document.createElement('div');
  row.className = 'arow';
  row.innerHTML = `
    <input class="aname mono" placeholder="别名，如 fast" value="${escapeHtml(name || '')}" autocomplete="off" spellcheck="false" />
    <select class="aprov" title="目标供应商">${providerOptions(pid)}</select>
    <select class="amodel" title="目标模型">${modelOptions(pid, mid, pid ? '该供应商第一个模型' : '选择模型…')}</select>
    <button class="icon-btn danger" title="删除这一行" aria-label="删除这一行" style="width:26px;height:26px;font-size:11px">✕</button>`;
  row.querySelector('.icon-btn.danger').onclick = () => {
    row.remove();
    if (!$$('#aliasRows .arow').length) addAliasRow();
    updateAliasCount();
    markAliasDirty();
  };
  const prov = row.querySelector('.aprov');
  const msel = row.querySelector('.amodel');
  row.querySelector('.aname').oninput = () => { updateAliasCount(); markAliasDirty(); };
  prov.onchange = () => {
    const ids = modelIdsOf(prov.value);
    msel.innerHTML = modelOptions(prov.value, ids.length ? ids[0] : '', prov.value ? '该供应商第一个模型' : '选择模型…');
    markAliasDirty();
  };
  msel.onchange = markAliasDirty;
  $('#aliasRows').appendChild(row);
  updateAliasCount();
}

function markAliasDirty() {
  const el = $('#aliasResult');
  if (el) el.textContent = '未保存';
}

function updateAliasCount() {
  const rows = $$('#aliasRows .arow');
  const n = rows.filter((r) => r.querySelector('.aname').value.trim()).length;
  $('#aliasCount').textContent = n;
}

function aliasesFromRows() {
  const out = {};
  $$('#aliasRows .arow').forEach((r) => {
    const k = r.querySelector('.aname').value.trim();
    const pid = r.querySelector('.aprov').value.trim();
    const mid = r.querySelector('.amodel').value.trim();
    if (k && mid) out[k] = pid ? pid + '/' + mid : mid;
  });
  return out;
}

function setAliasRows(aliases) {
  const box = $('#aliasRows');
  box.innerHTML = '';
  const entries = Object.entries(aliases || {});
  if (!entries.length) addAliasRow();
  else entries.forEach(([k, v]) => addAliasRow(k, v));
  updateAliasCount();
}

/* ---- 降级链 ---- */

function renderFbPick() {
  const box = $('#fbPick');
  box.innerHTML = '';
  (state.providers || []).forEach((p) => {
    const isCur = p.id === state.active;
    const idx = fbOrder.indexOf(p.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fb-chip' + (idx >= 0 ? ' on' : '') + (isCur ? ' cur' : '');
    b.innerHTML = (idx >= 0 ? `<span class="ord">${idx + 1}</span>` : '') +
      escapeHtml(p.id) + (isCur ? ' · 当前' : '');
    if (!isCur) {
      b.onclick = () => {
        const i = fbOrder.indexOf(p.id);
        if (i >= 0) fbOrder.splice(i, 1);
        else fbOrder.push(p.id);
        renderFbPick();
        renderFbModelMap();
        $('#fbResult').textContent = '未保存';
      };
    }
    box.appendChild(b);
  });
  if (!(state.providers || []).length) {
    box.innerHTML = '<span class="hint">还没有供应商，先去「供应商」页添加。</span>';
  }
}

function renderFbModelMap() {
  const box = $('#fbModelMap');
  box.innerHTML = '';
  if (!fbOrder.length) return;
  const title = document.createElement('label');
  title.className = 'f';
  title.innerHTML = '降级到该供应商时使用的模型 <span class="opt">选「自动」则按：同名模型 → 该供应商第一个模型</span>';
  box.appendChild(title);
  fbOrder.forEach((pid) => {
    const p = (state.providers || []).find((x) => x.id === pid);
    if (!p) return;
    const wrap = document.createElement('div');
    wrap.className = 'arow';
    wrap.style.gridTemplateColumns = 'minmax(0,150px) minmax(0,1fr)';
    const map = (state.fallback && state.fallback.modelMap) || {};
    wrap.innerHTML =
      `<input class="mono" value="${escapeHtml(pid)}" disabled />` +
      `<select class="fbmap" data-pid="${escapeHtml(pid)}" title="该供应商降级时使用的模型">` +
      modelOptions(pid, map[pid] || '', '自动选择') + '</select>';
    box.appendChild(wrap);
  });
}

/* ---- 预算 ---- */

function renderBudgetInputs() {
  const b = state.budget || {};
  $('#budEnabled').checked = !!b.enabled;
  $('#budReq').value = b.dailyRequests || 0;
  $('#budPrompt').value = b.dailyPromptTokens || 0;
  $('#budComp').value = b.dailyCompletionTokens || 0;
  $('#budHour').value = b.resetHour == null ? 4 : b.resetHour;
  $$('#budAction button').forEach((btn) => btn.classList.toggle('on', btn.dataset.a === (b.action || 'warn')));
}

function renderBudgetToday() {
  const bs = state.budgetState;
  const box = $('#budToday');
  if (!bs) { box.innerHTML = ''; return; }
  const limit = bs.limits || {};
  const t = bs.today || {};
  const rows = [
    ['请求数', t.requests || 0, limit.requests || 0],
    ['输入 token', t.prompt || 0, limit.prompt || 0],
    ['输出 token', t.completion || 0, limit.completion || 0]
  ];
  box.innerHTML = `<label class="f">今日用量 <span class="opt">${escapeHtml(bs.day || '')} · 每天 ${bs.resetHour}:00 重置</span></label>` +
    rows.map(([label, val, lim]) => {
      const pct = lim > 0 ? Math.min(100, Math.round((val / lim) * 100)) : 0;
      const cls = lim > 0 && val >= lim ? 'over' : (lim > 0 && pct >= 80 ? 'warn' : '');
      const limTxt = lim > 0 ? ' / ' + fmtNum(lim) : ' · 不限';
      return `<div class="bud-row"><span>${label}</span><span class="val">${fmtNum(val)}${limTxt}</span></div>` +
        (lim > 0 ? `<div class="bud-bar"><i class="${cls}" style="width:${pct}%"></i></div>` : '');
    }).join('') +
    (bs.enabled && bs.exceeded
      ? `<div class="hint" style="margin-top:6px;color:var(--warn)">已超限：${escapeHtml((bs.over || []).join(' / '))} · 当前策略「${bs.action === 'reject' ? '拒绝请求' : '仅告警'}」</div>`
      : '');
}

/* ---- 熔断 ---- */

function renderCircuitInputs() {
  const c = state.circuit || {};
  $('#cirEnabled').checked = c.enabled !== false;
  $('#cirThreshold').value = c.threshold || 5;
  $('#cirCooldown').value = Math.round((c.cooldownMs || 60000) / 1000);
}

function renderCircuitList() {
  const box = $('#circuitList');
  const cs = (state.runtime && state.runtime.circuits) || {};
  const ids = Object.keys(cs);
  if (!ids.length) {
    box.innerHTML = '<div class="circ-item"><span>全部正常，暂无失败记录</span></div>';
    return;
  }
  box.innerHTML = ids.map((id) => {
    const c = cs[id];
    const txt = c.open
      ? `已熔断 · ${Math.max(1, Math.ceil((c.openForMs || 0) / 1000))}s 后恢复`
      : `连续失败 ${c.fails || 0} 次`;
    return `<div class="circ-item${c.open ? ' open' : ''}">
      <span class="nm">${escapeHtml(id)}</span><span>${escapeHtml(txt)}</span>
      <div class="grow"></div>
      ${c.lastError ? `<span class="hint">${escapeHtml(String(c.lastError).slice(0, 40))}</span>` : ''}
    </div>`;
  }).join('');
}

/** force=true 时用服务端数据覆盖表单（保存后调用）；否则只刷新动态部分，避免打断编辑 */
function renderPolicy(force) {
  if (force || !policyReady) {
    setAliasRows(state.aliases);
    fbOrder = Array.isArray(state.fallback && state.fallback.order) ? state.fallback.order.slice() : [];
    $('#fbEnabled').checked = !!(state.fallback && state.fallback.enabled);
    $('#fbHops').value = String((state.fallback && state.fallback.maxHops) || 1);
    const kinds = (state.fallback && state.fallback.onKinds) || [];
    $$('#fbKinds input').forEach((i) => (i.checked = kinds.includes(i.value)));
    renderFbPick();
    renderFbModelMap();
    renderBudgetInputs();
    renderCircuitInputs();
    policyReady = true;
  }
  renderBudgetToday();
  renderCircuitList();
}

/* ------------------------------------------------------------------ */
/* 表单                                                               */
/* ------------------------------------------------------------------ */
function selectProvider(id) {
  if (id === selId) return;
  const go = () => {
    const p = state.providers.find((x) => x.id === id);
    if (!p) return;
    selId = id;
    isNew = false;
    setDirty(false);
    $('#formTitle').textContent = '编辑供应商';
    $('#editorId').textContent = p.id;
    $('#f_id').value = p.id;
    $('#f_id').disabled = true;
    $('#f_name').value = p.name || '';
    $('#f_api').value = p.api || 'openai';
    $('#f_base').value = p.baseUrl || '';
    $('#f_key').value = '';
    $('#f_key').placeholder = p.hasKey
      ? '已保存 ' + (p.auth && p.auth.value ? p.auth.value : '****') + ' · 留空不修改'
      : 'sk-… 或 env:NEXTAPI_API_KEY';
    $('#keyHint').innerHTML = p.keyRef
      ? '当前用环境变量引用，key 不存在配置文件里。'
      : p.hasKey
        ? '想换 key 直接覆盖输入；留空保存不会改动已存的 key。'
        : '尚未配置 key，该供应商的请求会返回 401。';
    setModelRows(p.models || []);
    $('#testResult').className = 'result';
    $('#testResult').textContent = '';
    $('#btnDel').disabled = state.providers.length <= 1;
    $('#btnActive').disabled = p.id === state.active;
    renderList();
    updateSnippets();
  };
  if (dirty) {
    confirmBox('放弃未保存的修改？', '当前表单有未保存的改动，切换供应商会丢失它们。', '放弃修改').then((ok) => { if (ok) go(); });
  } else {
    go();
  }
}

function newProvider() {
  const go = () => {
    selId = null;
    isNew = true;
    setDirty(false);
    $('#formTitle').textContent = '新增供应商';
    $('#editorId').textContent = '未保存';
    $('#f_id').disabled = false;
    $('#f_id').value = '';
    $('#f_name').value = '';
    $('#f_api').value = 'openai';
    $('#f_base').value = '';
    $('#f_key').value = '';
    $('#f_key').placeholder = 'sk-… 或 env:NEXTAPI_API_KEY';
    $('#keyHint').innerHTML = '建议写 <span class="mono">env:变量名</span>，避免明文 key 落在配置文件里。';
    setModelRows([{}]);
    $('#testResult').className = 'result';
    $('#testResult').textContent = '';
    $('#btnDel').disabled = true;
    $('#btnActive').disabled = true;
    renderList();
    toggleCard('editor', false);
    $('#f_id').focus();
  };
  if (dirty) {
    confirmBox('放弃未保存的修改？', '当前表单有未保存的改动，新增供应商会丢失它们。', '放弃修改').then((ok) => { if (ok) go(); });
  } else {
    go();
  }
}

function collectForm() {
  const id = $('#f_id').value.trim();
  const body = {
    id,
    name: $('#f_name').value.trim() || id,
    api: $('#f_api').value,
    baseUrl: $('#f_base').value.trim(),
    models: modelsFromRows()
  };
  const key = $('#f_key').value.trim();
  if (key) body.auth = { type: 'bearer', value: key };
  return body;
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */
async function load() {
  const s = await api('/api/state');
  state = s;
  $('#dot').className = 'dot on';
  $('#statusText').textContent = '已运行 ' + fmtUptime(s.runtime && s.runtime.uptime);
  const fixed = s.modelPolicy === 'fixed';
  $('#pillModel').textContent = s.activeModel || '未指定';
  $('#pillMode').textContent = fixed ? '固定' : '自动';
  $('#pillMode').title = fixed ? '所有请求固定用这个模型' : '按客户端模型名路由';
  $('#verChip').textContent = 'v' + ((s.runtime && s.runtime.version) || '1.3');
  renderRoute();

  const total = new Set();
  s.providers.forEach((p) => (p.models || []).forEach((m) => total.add(m.id)));
  renderList();

  const rt = s.runtime || {};
  $('#footRuntime').textContent =
    `v${rt.version || '—'} · Node ${rt.node || '—'} · PID ${rt.pid || '—'} · 启动于 ${(rt.startedAt || '').replace('T', ' ').slice(0, 19)}`;
  updateSnippets();
  renderPolicy(false);
  if (isNew) return;
  if (!selId || !s.providers.some((p) => p.id === selId)) {
    const first = s.active || (s.providers[0] && s.providers[0].id);
    if (first) selectProvider(first);
  } else {
    const p = s.providers.find((x) => x.id === selId);
    if (p) {
      $('#f_name').value = p.name || '';
      $('#f_api').value = p.api || 'openai';
      $('#f_base').value = p.baseUrl || '';
      $('#btnActive').disabled = p.id === state.active;
    }
  }
}

/* ---- 策略页：保存与操作 ---- */

$('#btnAliasAdd').onclick = () => addAliasRow();

$('#btnAliasSave').onclick = async () => {
  try {
    const r = await api('/api/aliases', { method: 'POST', body: JSON.stringify({ aliases: aliasesFromRows() }) });
    state.aliases = r.aliases;
    renderPolicy(true);
    $('#aliasResult').textContent = '已保存';
    toast('别名已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
};

$('#btnFbSave').onclick = async () => {
  const modelMap = {};
  $$('#fbModelMap .fbmap').forEach((i) => {
    const v = i.value.trim();
    if (v) modelMap[i.dataset.pid] = v;
  });
  const body = {
    enabled: $('#fbEnabled').checked,
    order: fbOrder,
    maxHops: Number($('#fbHops').value) || 1,
    onKinds: $$('#fbKinds input').filter((i) => i.checked).map((i) => i.value),
    modelMap
  };
  if (body.enabled && !body.onKinds.length) return toast('至少选一种触发降级的错误', 'err');
  try {
    const r = await api('/api/fallback', { method: 'POST', body: JSON.stringify(body) });
    state.fallback = r.fallback;
    renderPolicy(true);
    $('#fbResult').textContent = body.enabled ? '已启用' : '已关闭';
    toast('降级策略已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
};

$('#btnFbReset').onclick = async () => {
  try {
    await api('/api/circuit', { method: 'POST', body: JSON.stringify({ reset: 'all' }) });
    await load();
    toast('熔断已全部复位', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
};

$$('#budAction button').forEach((b) => {
  b.onclick = () => $$('#budAction button').forEach((x) => x.classList.toggle('on', x === b));
});

$('#btnBudSave').onclick = async () => {
  const onBtn = $$('#budAction button').filter((x) => x.classList.contains('on'))[0];
  const body = {
    enabled: $('#budEnabled').checked,
    dailyRequests: Number($('#budReq').value) || 0,
    dailyPromptTokens: Number($('#budPrompt').value) || 0,
    dailyCompletionTokens: Number($('#budComp').value) || 0,
    resetHour: Math.min(23, Math.max(0, Number($('#budHour').value) || 0)),
    action: onBtn ? onBtn.dataset.a : 'warn'
  };
  try {
    const r = await api('/api/budget', { method: 'POST', body: JSON.stringify(body) });
    state.budget = r.budget;
    state.budgetState = r.budgetState;
    renderPolicy(true);
    $('#budResult').textContent = body.enabled ? '已启用' : '已关闭';
    toast('预算已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
};

$('#btnBudReset').onclick = async () => {
  try {
    const r = await api('/api/budget', { method: 'POST', body: JSON.stringify({ resetToday: true }) });
    state.budgetState = r.budgetState;
    renderBudgetToday();
    toast('今日计数已清零', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
};

$('#btnCirSave').onclick = async () => {
  const body = {
    enabled: $('#cirEnabled').checked,
    threshold: Number($('#cirThreshold').value) || 5,
    cooldownMs: (Number($('#cirCooldown').value) || 60) * 1000
  };
  try {
    const r = await api('/api/circuit', { method: 'POST', body: JSON.stringify(body) });
    state.circuit = r.circuit;
    state.runtime = state.runtime || {};
    state.runtime.circuits = r.circuits;
    renderPolicy(true);
    $('#cirResult').textContent = body.enabled ? '已启用' : '已关闭';
    toast('熔断配置已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
};

async function save() {
  const body = collectForm();
  if (!body.id) return toast('ID 必填', 'err');
  if (!/^[A-Za-z0-9._-]+$/.test(body.id)) return toast('ID 只能用字母、数字、点、下划线、短横线', 'err');
  if (!body.baseUrl) return toast('Base URL 必填', 'err');
  if (!/^https?:\/\//i.test(body.baseUrl)) return toast('Base URL 需以 http:// 或 https:// 开头', 'err');
  if (!body.models.length) return toast('至少填一个模型', 'err');

  const btn = $('#btnSave');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 保存中';
  try {
    await api('/api/providers', { method: 'POST', body: JSON.stringify(body) });
    const wasNew = isNew;
    isNew = false;
    selId = body.id;
    setDirty(false);
    await load();
    toast(wasNew ? '已新增供应商' : '已保存', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

/* ------------------------------------------------------------------ */
/* 接入片段                                                            */
/* ------------------------------------------------------------------ */
function currentProv() {
  return state.providers.find((p) => p.id === state.active) || state.providers[0] || null;
}
function firstModel() {
  if (state.activeModel) return state.activeModel;
  const p = currentProv();
  return (p && p.models && p.models[0] && p.models[0].id) || 'deepseek-v4.1-flash';
}
function updateSnippets() {
  const s = state.server || { host: '127.0.0.1', port: 8787 };
  const base = `http://${s.host}:${s.port}`;
  const model = firstModel();
  const fixedNote = state.modelPolicy === 'fixed'
    ? '\n# 模型由网关决定：换模型在网关界面点，这里不用改'
    : '';
  const map = {
    codex: `# ~/.codex/config.toml
model = "${model}"${fixedNote}
model_provider = "localgateway"

[model_providers.localgateway]
name = "localgateway"
base_url = "${base}/v1"
wire_api = "responses"
experimental_bearer_token = "local"   # 随便填，真实 key 由网关注入
requires_openai_auth = false`,
    cursor: `Base URL : ${base}/v1
API Key  : local        # 任意值
Model    : ${model}`,
    curl: `curl ${base}/v1/chat/completions \\
  -H "content-type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`,
    claude: `# 环境变量方式（Claude Code）
export ANTHROPIC_BASE_URL=${base}
export ANTHROPIC_AUTH_TOKEN=local
export ANTHROPIC_MODEL=${model}`
  };
  $('#snip').textContent = map[snipKey] || '';
}

/* ------------------------------------------------------------------ */
/* 日志                                                               */
/* ------------------------------------------------------------------ */
function renderLogs() {
  const tb = $('#logs');
  const rows = logFilter === 'err'
    ? logs.filter((i) => !i.status || i.status >= 400)
    : logs;
  $('#logCount').textContent = rows.length;
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="6" class="hint" style="padding:22px 12px;text-align:center">${
      logFilter === 'err' ? '没有失败的请求' : '暂无请求'
    }</td></tr>`;
    return;
  }
  const maxMs = Math.max.apply(null, rows.map((i) => i.ms || 0).concat([1]));
  tb.innerHTML = rows.map((i) => {
    const s = i.status || 0;
    const cls = !s ? 'none' : s >= 500 ? 'err' : s >= 400 ? 'warn' : 'ok';
    const label = s ? s : '—';
    const w = Math.max(2, Math.round(((i.ms || 0) / maxMs) * 44));
    const color = cls === 'err' ? 'background:var(--err)' : cls === 'warn' ? 'background:var(--warn)' : '';
    return `<tr>
      <td><span class="st ${cls}">${label}</span></td>
      <td>${i.provider ? `<span class="prov-chip">${escapeHtml(i.provider)}</span>` : '<span class="hint">—</span>'}</td>
      <td class="mono" style="color:var(--text)">${escapeHtml(i.model || '—')}</td>
      <td class="mono hint">${escapeHtml(i.path || '')}</td>
      <td><div class="bars"><span class="bar-fill" style="width:${w}px;${color}"></span><span class="num hint">${i.ms != null ? i.ms + ' ms' : '—'}</span></div></td>
      <td class="num hint" title="${escapeHtml(fmtLogFull(i))}">${fmtLogTime(i)}</td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* 用量统计                                                             */
/* ------------------------------------------------------------------ */
let usageData = null;

function fmtNum(n) {
  n = Number(n) || 0;
  return n >= 100000 ? (n / 1000).toFixed(0) + 'k' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

async function loadUsage() {
  try {
    usageData = await api('/api/usage');
    renderUsage();
  } catch (_) { /* 静默，等下次刷新 */ }
}

function renderUsage() {
  const d = usageData;
  if (!d) return;
  $('#usageSummary').textContent = `${fmtNum(d.requests)} 次请求 · 失败 ${fmtNum(d.errors)}`;
  $('#usageTotals').innerHTML = [
    ['请求', fmtNum(d.requests)],
    ['失败', fmtNum(d.errors)],
    ['输入 token', fmtNum(d.prompt)],
    ['输出 token', fmtNum(d.completion)],
    ['合计 token', fmtNum(d.total)],
    ['平均耗时', (d.avgMs || 0) + 'ms']
  ].map((x) => `<div class="usage-cell"><div class="k">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');

  const rows = (d.items || []).map((it) => `<tr>
      <td class="mono">${escapeHtml(it.provider)}</td>
      <td class="mono">${escapeHtml(it.model)}</td>
      <td class="num">${it.requests}</td>
      <td class="num ${it.errors ? 'err' : ''}">${it.errors || 0}</td>
      <td class="num">${fmtNum(it.prompt)}</td>
      <td class="num">${fmtNum(it.completion)}</td>
      <td class="num">${it.avgMs || 0}ms</td>
      <td class="num dim">${it.lastAt ? new Date(it.lastAt).toLocaleString() : ''}</td>
    </tr>`).join('');
  $('#usageTable').innerHTML = rows
    ? `<thead><tr><th>provider</th><th>模型</th><th class="num">次数</th><th class="num">失败</th><th class="num">输入</th><th class="num">输出</th><th class="num">均耗时</th><th class="num">最近</th></tr></thead><tbody>${rows}</tbody>`
    : '<tbody><tr><td class="hint" style="padding:14px">还没有记录，发几个请求试试</td></tr></tbody>';
}

$('#btnUsageClear').onclick = async () => {
  const ok = await confirmBox('用量统计清零？', '只清统计数字，不影响请求日志与配置。', '清零');
  if (!ok) return;
  try {
    await api('/api/usage/clear', { method: 'POST', body: '{}' });
    toast('用量统计已清零', 'ok');
    loadUsage();
  } catch (e) {
    toast(e.message, 'err');
  }
};

async function loadLogs() {
  try {
    const r = await api('/api/logs?limit=80');
    logs = r.items || [];
    renderLogs();
  } catch (_) { /* 静默 */ }
}

async function loadLogMeta() {
  try {
    const m = await api('/api/logs/meta');
    logMeta = m;
    const conf = m.conf || {};
    const max = (conf.maxSizeKB || 2048) * 1024;
    const pct = Math.min(100, Math.round((m.activeBytes / max) * 100));
    $('#logBar').style.width = pct + '%';
    $('#logBar').classList.toggle('warn', pct > 80);
    $('#logSizeText').textContent = `${fmtBytes(m.activeBytes)} / ${fmtBytes(max)}${conf.enabled === false ? ' · 已停写' : ''}`;
    $('#cfgMaxSize').value = String(conf.maxSizeKB || 2048);
    $('#cfgKeep').value = String(conf.keep || 3);
    $('#cfgEnabled').checked = conf.enabled !== false;
    $('#logFiles').innerHTML = (m.files || []).length
      ? m.files.map((f) => `<a class="file-link" href="/api/logs/download?name=${encodeURIComponent(f.name)}" download title="${f.mtime} · ${fmtBytes(f.size)}">${f.name === 'requests.log' ? '当前 · ' : ''}${escapeHtml(f.name)} · ${fmtBytes(f.size)}</a>`).join('')
      : '<span class="hint">暂无日志文件</span>';
  } catch (_) { /* 静默 */ }
}

/* ------------------------------------------------------------------ */
/* 事件                                                               */
/* ------------------------------------------------------------------ */
$('#btnSave').onclick = save;
$('#btnNew').onclick = newProvider;

$('#modelPill').onclick = () => {
  showPage('overview');
  toggleCard('route', false);
  setTimeout(() => $('#modelSelect').focus(), 80);
};

$('#modelSelect').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (!v) return;
  const [provider, model] = v.split('::');
  try {
    await api('/api/model', { method: 'POST', body: JSON.stringify({ provider, model }) });
    toast('当前模型：' + model, 'ok');
    await load();
    renderList();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#policySeg').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-p]');
  if (!b || b.dataset.p === state.modelPolicy) return;
  try {
    const r = await api('/api/policy', { method: 'POST', body: JSON.stringify({ policy: b.dataset.p }) });
    toast(r.modelPolicy === 'fixed' ? '已切换：网关固定模型' : '已切换：跟随客户端模型名', 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btnAddModel').onclick = () => { addModelRow(); setDirty(true); };

$('#provFilter').addEventListener('input', (e) => { provFilter = e.target.value; renderList(); });

['#f_id', '#f_name', '#f_api', '#f_base', '#f_key'].forEach((sel) => {
  $(sel).addEventListener('input', () => setDirty(true));
  $(sel).addEventListener('change', () => setDirty(true));
});

$('#btnActive').onclick = async () => {
  if (!selId) return;
  const btn = $('#btnActive');
  btn.disabled = true;
  try {
    await api('/api/active', { method: 'POST', body: JSON.stringify({ id: selId }) });
    toast('已切换当前供应商：' + selId, 'ok');
    await load();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

$('#btnTest').onclick = async () => {
  if (isNew) return toast('先保存再测试连接', 'err');
  if (!selId) return;
  const btn = $('#btnTest');
  const out = $('#testResult');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 测试中';
  out.className = 'result';
  out.textContent = '';
  provStatus[selId] = 'load';
  renderList();
  try {
    const r = await api('/api/test', { method: 'POST', body: JSON.stringify({ id: selId }) });
    if (r.ok) {
      provStatus[selId] = 'ok';
      out.className = 'result ok';
      out.innerHTML = `<span class="ico">✓</span> 连接正常 · HTTP ${r.status}${r.models != null ? ' · ' + r.models + ' 模型' : ''}`;
    } else {
      provStatus[selId] = 'err';
      out.className = 'result err';
      out.innerHTML = `<span class="ico">✗</span> ${escapeHtml(r.status ? 'HTTP ' + r.status : '连接失败')}${r.message ? ' · ' + escapeHtml(String(r.message).slice(0, 90)) : ''}`;
    }
  } catch (e) {
    provStatus[selId] = 'err';
    out.className = 'result err';
    out.innerHTML = `<span class="ico">✗</span> ${escapeHtml(e.message)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
    renderList();
  }
};

$('#btnTestAll').onclick = async () => {
  if (!state.providers.length) return;
  const btn = $('#btnTestAll');
  btn.disabled = true;
  $('#testAllHint').textContent = '检测中…';
  const results = [];
  for (const p of state.providers) {
    provStatus[p.id] = 'load';
    renderList();
    try {
      const r = await api('/api/test', { method: 'POST', body: JSON.stringify({ id: p.id }) });
      provStatus[p.id] = r.ok ? 'ok' : 'err';
      results.push({ id: p.id, ok: !!r.ok });
    } catch (e) {
      provStatus[p.id] = 'err';
      results.push({ id: p.id, ok: false });
    }
    renderList();
  }
  btn.disabled = false;
  const okN = results.filter((r) => r.ok).length;
  $('#testAllHint').textContent = `${okN}/${results.length} 可用`;
  if (okN === results.length) toast('全部供应商连接正常', 'ok');
  else toast(results.filter((r) => !r.ok).map((r) => r.id).join('、') + ' 连接异常', 'err');
};

/* ------------------------------------------------------------------ */
/* 模型级真实测活                                                       */
/* ------------------------------------------------------------------ */
const KIND_TEXT = {
  ok: '可用', rate: '限流·未验证', auth: '无权限', missing: '模型不存在',
  reject: '参数被拒', upstream: '上游故障', net: '网络/超时', err: '失败'
};

function paintState(el, res) {
  if (!el) return;
  const k = res.kind || 'err';
  el.className = 'mstate ' + (k === 'ok' ? 'ok' : k === 'rate' ? 'rate' : k === 'load' ? 'load' : 'bad');
  if (k === 'load') { el.textContent = '…'; el.title = '测活中'; return; }
  const ms = res.ms != null ? res.ms + 'ms' : '';
  el.textContent = (res.ok ? '✓ ' : k === 'rate' ? '⧗ ' : '✗ ') + (res.ok ? ms : KIND_TEXT[k] || '失败');
  el.title = [
    res.ok ? '可用' : KIND_TEXT[k] || '失败',
    res.status ? 'HTTP ' + res.status : '',
    ms,
    res.upstream && res.upstream !== res.model ? '实际请求 ' + res.upstream : '',
    res.message && !res.ok ? res.message : ''
  ].filter(Boolean).join(' · ');
}

/** 按已保存的结果刷新当前编辑器的模型行（切换供应商后能回看上次测活结果） */
function paintRowsFromStatus() {
  const store = modelStatus[selId] || {};
  $$('#modelRows .mrow').forEach((r) => {
    const id = r.querySelector('.mid').value.trim();
    const el = r.querySelector('.mstate');
    if (!el) return;
    if (store[id]) paintState(el, store[id]);
    else { el.className = 'mstate'; el.textContent = ''; el.title = '尚未测活'; }
  });
}

/** 串行批量测活：一次请求让服务端按顺序跑，结果写回对应模型行 */
async function runModelTests(providerId, modelIds, rows, hintEl) {
  if (!modelIds.length) return { ok: 0, total: 0 };
  const cleanIds = modelIds.filter(Boolean);
  if (!cleanIds.length) { toast('没有可测的模型', 'err'); return { ok: 0, total: 0 }; }
  const pairs = cleanIds.map((id, i) => ({ id, row: rows ? rows[i] : null }));
  pairs.forEach((x) => {
    if (!x.row) return;
    x.row.classList.add('testing');
    paintState(x.row.querySelector('.mstate'), { kind: 'load' });
  });
  if (hintEl) hintEl.textContent = `测活中 0/${cleanIds.length}…`;
  try {
    const r = await api('/api/test/models', {
      method: 'POST',
      body: JSON.stringify({ items: cleanIds.map((m) => ({ provider: providerId, model: m })) })
    });
    const map = new Map((r.items || []).map((x) => [x.model, x]));
    // 结果存下来，左侧列表的模型 chip 会据此着色
    const store = modelStatus[providerId] || (modelStatus[providerId] = {});
    (r.items || []).forEach((x) => { store[x.model] = x; });
    pairs.forEach((x) => {
      if (!x.row) return;
      x.row.classList.remove('testing');
      paintState(x.row.querySelector('.mstate'), map.get(x.id) || { kind: 'err', message: '无结果' });
    });
    if (selId === providerId) paintRowsFromStatus();
    renderList();
    const okN = (r.items || []).filter((x) => x.ok).length;
    if (hintEl) hintEl.textContent = `${okN}/${cleanIds.length} 可用`;
    return { ok: okN, total: cleanIds.length, items: r.items || [] };
  } catch (e) {
    pairs.forEach((x) => {
      if (!x.row) return;
      x.row.classList.remove('testing');
      paintState(x.row.querySelector('.mstate'), { kind: 'err', message: e.message });
    });
    if (hintEl) hintEl.textContent = '测活失败';
    throw e;
  }
}

/** 当前编辑供应商：测活它下面的全部模型行 */
$('#btnTestModels').onclick = async () => {
  if (isNew || !selId) return toast('先保存供应商再测活', 'err');
  const rows = $$('#modelRows .mrow').filter((r) => r.querySelector('.mid').value.trim());
  if (!rows.length) return toast('没有模型可测', 'err');
  const btn = $('#btnTestModels');
  btn.disabled = true;
  try {
    const r = await runModelTests(selId, rows.map((x) => x.querySelector('.mid').value.trim()), rows, $('#testModelsHint'));
    toast(`测活完成：${r.ok}/${r.total} 可用`, r.ok ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

/** 全局：按供应商分组，串行测活所有模型（只影响列表里的状态点） */
$('#btnTestAllModels').onclick = async () => {
  if (!state.providers.length) return;
  const all = state.providers.filter((p) => (p.models || []).length);
  const total = all.reduce((a, p) => a + p.models.length, 0);
  if (!total) return toast('还没有任何模型', 'err');
  const ok = await confirmBox(
    `测活全部 ${total} 个模型？`,
    '会对每个模型真实调用一次（max_tokens=1），串行执行以避免触发上游限速。遇到限流会标记为「限流·未验证」而不是失败。',
    '开始测活'
  );
  if (!ok) return;
  const btn = $('#btnTestAllModels');
  btn.disabled = true;
  let okN = 0;
  try {
    for (const p of all) {
      $('#testAllHint').textContent = `测活 ${p.id}…`;
      let rows = null;
      if (selId === p.id) {
        const byId = new Map($$('#modelRows .mrow').map((r) => [r.querySelector('.mid').value.trim(), r]));
        rows = p.models.map((m) => byId.get(m.id) || null);
      }
      const r = await runModelTests(p.id, p.models.map((m) => m.id), rows, null);
      okN += r.ok;
      const bad = (r.items || []).filter((x) => !x.ok);
      if (bad.length) {
        console.warn('[测活失败]', p.id, bad);
        toast(`${p.id}：${bad.map((x) => x.model + '(' + (KIND_TEXT[x.kind] || '失败') + ')').join('、')}`, 'err');
      }
    }
    $('#testAllHint').textContent = `模型 ${okN}/${total} 可用`;
    toast(`全部模型测活完成：${okN}/${total} 可用`, okN ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

/** 拉取持久化的测活结果，回填 modelStatus（重启后 chip 仍有着色） */
async function loadTestStatus() {
  try {
    const r = await api('/api/test/status');
    Object.keys(r.providers || {}).forEach((pid) => {
      modelStatus[pid] = Object.assign(modelStatus[pid] || {}, r.providers[pid]);
    });
    $('#autoTest').checked = !!(r.autoTest && r.autoTest.enabled);
    renderList();
    paintRowsFromStatus();
  } catch (_) { /* 静默 */ }
}

$('#autoTest').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    await api('/api/test/auto', { method: 'POST', body: JSON.stringify({ enabled: on }) });
    toast(on ? '已开启定时测活：每 24h 在上游空闲时自动测全部模型' : '已关闭定时测活', 'ok');
  } catch (err) {
    toast(err.message, 'err');
    e.target.checked = !on;
  }
});

$('#btnDel').onclick = async () => {
  if (!selId) return;
  const ok = await confirmBox('删除供应商「' + selId + '」？', '配置会从 data/config.json 中移除，无法撤销。若它是当前供应商，会自动切到第一个。', '删除');
  if (!ok) return;
  try {
    await api('/api/providers/' + encodeURIComponent(selId), { method: 'DELETE' });
    selId = null;
    setDirty(false);
    await load();
    toast('已删除', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
};

/* 日志 */
$('#btnLogs').onclick = () => { loadLogs(); loadLogMeta(); };
$('#logFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  logFilter = b.dataset.f;
  $$('#logFilter button').forEach((x) => x.classList.toggle('on', x === b));
  renderLogs();
});
$('#autoRefresh').addEventListener('change', (e) => {
  localStorage.setItem(LS_AUTO, e.target.checked ? '1' : '0');
  startAuto(e.target.checked);
});
function startAuto(on) {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (on) autoTimer = setInterval(() => { if (!document.hidden) { loadLogs(); loadLogMeta(); loadUsage(); } }, 4000);
}

$('#btnLogPolicy').onclick = () => {
  const p = $('#logPolicy');
  p.hidden = !p.hidden;
  if (!p.hidden) loadLogMeta();
};

async function saveLogConf(patch) {
  try {
    const r = await api('/api/logs/config', { method: 'POST', body: JSON.stringify(patch) });
    toast('日志策略已保存', 'ok');
    await loadLogMeta();
    return r;
  } catch (e) {
    toast(e.message, 'err');
  }
}
$('#cfgMaxSize').onchange = (e) => saveLogConf({ maxSizeKB: Number(e.target.value) });
$('#cfgKeep').onchange = (e) => saveLogConf({ keep: Number(e.target.value) });
$('#cfgEnabled').onchange = (e) => saveLogConf({ enabled: e.target.checked });

$('#btnLogClear').onclick = async () => {
  const ok = await confirmBox('清空请求日志？', '活动日志文件会立即清空，内存里最近 300 条记录也会一并清掉（归档文件保留）。', '清空');
  if (!ok) return;
  try {
    await api('/api/logs/clear', { method: 'POST', body: JSON.stringify({ archives: false }) });
    toast('日志已清空', 'ok');
    await loadLogs();
    await loadLogMeta();
  } catch (e) {
    toast(e.message, 'err');
  }
};

/* 其它 */
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  snipKey = b.dataset.k;
  $$('#tabs .tab').forEach((x) => x.classList.toggle('on', x === b));
  updateSnippets();
});
$('#btnCopySnip').onclick = () => copyText($('#snip').textContent);

$('#btnTheme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(LS_THEME, next);
};

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */
(function init() {
  const qTheme = new URLSearchParams(location.search).get('theme');
  const t = qTheme || localStorage.getItem(LS_THEME);
  if (t) document.documentElement.dataset.theme = t;

  const auto = localStorage.getItem(LS_AUTO) !== '0';
  $('#autoRefresh').checked = auto;
  applyCollapse();

  const savedPage = location.hash.slice(1) || localStorage.getItem(LS_PAGE);
  if (savedPage && document.getElementById('page-' + savedPage)) showPage(savedPage);

  load().catch(() => {
    $('#dot').className = 'dot off';
    $('#statusText').textContent = '网关未连接';
    $('#list').innerHTML = '<li class="empty">连接不到网关<br />确认服务已启动（node server.js）</li>';
    toast('无法连接网关，请检查服务是否运行', 'err');
  });
  loadLogs();
  loadLogMeta();
  loadUsage();
  loadTestStatus();
  startAuto(auto);
  setInterval(() => {
    if (!document.hidden) load().catch(() => {});
  }, 30000);
})();
