'use strict';
/** 请求日志：内存最近记录 + JSONL 落盘 + 按大小轮转。 */

const fs = require('fs');
const path = require('path');
const { cfg, DATA_DIR, LOG_PATH, LOG_DEFAULTS } = require('./config');
const { localIso } = require('./util');

const recent = [];
const MAX_RECENT = 300;

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

/** logBytes 需要被轮转与统计读写，用 getter 暴露当前值 */
module.exports = {
  recent, MAX_RECENT, logRequest, logFiles, rotateLogs,
  get logBytes() { return logBytes; },
  resetLogBytes() { logBytes = 0; }
};
