# LLM Gateway

本机大模型统一代理网关：把 Codex / Cursor / Claude Code / 任意 OpenAI 兼容客户端统一指向
`http://127.0.0.1:8787`，上游服务、API Key、调用模型全部在网关上切换，客户端配置一次就不用再改。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)
![依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-brightgreen)
![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-lightgrey)

```
Codex / Cursor / Claude Code / SDK
        │  只认 http://127.0.0.1:8787
        ▼
   ┌──────────────┐   模型级路由 + key 注入 + 协议适配
   │  LLM Gateway │ ──────────────►  Provider A（OpenAI 兼容）
   │    :8787     │ ──────────────►  Provider B（Anthropic）
   └──────────────┘ ──────────────►  Provider C（任意其他上游）
```

## 功能特性

- **零依赖**：只用 Node 内置模块，clone 下来 `node server.js` 即可运行，无需 `npm install`
- **多上游**：任意多个 provider（OpenAI 兼容 / Anthropic），界面一键切换当前上游
- **模型路由**：支持「网关固定」（客户端模型名一律忽略，换模型只点界面）与「跟随客户端」两种策略；
  模型名写成 `providerId/modelId` 可精确指定，不受策略影响
- **协议适配**：上游只支持 `chat/completions` 时，自动把 Codex 的 Responses 请求（流式事件、
  工具调用、usage）双向翻译——这是 Codex 0.16x 接入第三方上游的可行方式
- **流式直通**：SSE 边收边转，不缓冲、不改写响应
- **并发队列**：同一上游的请求自动排队串行执行，并发=1 的免费档上游不再互撞 429；
  可选开启退避重试（默认关，避免重复计费）
- **失败降级**：主供应商出现限流/上游故障/网络错误时自动切换到备用供应商重试，
  按优先级链选择，熔断中的供应商自动跳过（可在「策略」页配置，默认关）
- **模型别名**：给模型起短名字（如 `fast`/`smart`），客户端只写别名，
  真实模型在网关上随时改，别名优先于「网关固定」策略
- **每日预算**：按天累计请求数与 token，到达上限后可仅告警或直接拒绝（429），
  每天本地时区设定时刻自动重置
- **熔断保护**：某供应商连续失败到阈值后短路一段时间，不再让每个请求白等超时，
  冷却结束自动恢复
- **模型级测活**：对单个/全部模型发极小请求（`max_tokens=1`）验证真实可用性，串行节流避免触发
  上游限速，429 单独标记为「限流·未验证」；结果落盘持久化，支持定时自动巡检
- **用量统计**：按 provider/model 累计请求数、失败数、输入/输出 token 与耗时
- **请求日志**：本机时区时间戳、按大小自动轮转，磁盘占用有上限
- **管理界面**：侧边导航（总览 / 供应商 / 策略 / 客户端接入 / 请求日志）、亮暗双主题、
  每个功能区带「?」帮助释意、响应式适配窄屏
- **后台常驻**：Windows 计划任务开机自启、无窗口运行（macOS/Linux 可用 systemd/launchd 自行托管）

## 快速开始

```bash
git clone https://github.com/Linix0/llm-gateway.git
cd llm-gateway

# 1) 生成配置（仓库里只放脱敏样例，真实 key 不入库）
cp data/config.example.json data/config.json
# 编辑 data/config.json，填入上游 baseUrl 与 key

# 2) 启动
node server.js
```

打开 <http://127.0.0.1:8787/> 进入管理界面。后续配置（供应商、模型、key）都可以在界面上完成，
不用手改 JSON。

## 接入客户端

管理界面「客户端接入」页会按当前配置自动生成以下片段，直接复制即可（片段中的 key 统一填
`local` 占位，真实 key 由网关在转发时注入）。

### Codex（`~/.codex/config.toml`）

```toml
model = "任意模型名"          # 网关固定模式下会被网关忽略
model_provider = "localgateway"

[model_providers.localgateway]
name = "localgateway"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
experimental_bearer_token = "local"
requires_openai_auth = false
```

> **为什么必须 `wire_api = "responses"`**：Codex 0.16x 已移除 chat 协议支持；而多数第三方上游
> 只提供 `/v1/chat/completions`，中间的翻译由网关的 `lib/responses-adapter.js` 完成。

### Cursor / 任意 OpenAI 兼容客户端

| 字段 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | 任意值（如 `local`） |
| Model | `/v1/models` 列出的任一模型名 |

### Claude Code / Anthropic 协议

新建一个 `api: "anthropic"` 的 provider，然后：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=local
export ANTHROPIC_MODEL=你的模型名
```

## 配置

`data/config.json`（本地生成，已 gitignore）：

```json
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "active": "nextapi",
  "activeModel": "deepseek-v4.1-flash",
  "modelPolicy": "fixed",
  "logs": { "enabled": true, "maxSizeKB": 2048, "keep": 3 },
  "limits": {
    "queue": true,
    "queueTimeoutMs": 120000,
    "retry": { "enabled": false, "maxAttempts": 2, "backoffMs": 800 }
  },
  "autoTest": { "enabled": false, "intervalHours": 24 },
  "aliases": { "fast": "nextapi/deepseek-v4.1-flash" },
  "fallback": {
    "enabled": false,
    "order": ["backup-provider"],
    "maxHops": 1,
    "onKinds": ["rate", "upstream", "net"],
    "modelMap": { "backup-provider": "deepseek-v4.1-flash" }
  },
  "budget": {
    "enabled": false,
    "dailyRequests": 0,
    "dailyPromptTokens": 0,
    "dailyCompletionTokens": 0,
    "action": "warn",
    "resetHour": 4
  },
  "circuit": { "enabled": true, "threshold": 5, "cooldownMs": 60000 },
  "providers": [
    {
      "id": "nextapi",
      "name": "NextApi",
      "api": "openai",
      "baseUrl": "https://api.example.com/v1",
      "auth": { "type": "bearer", "value": "env:NEXTAPI_API_KEY" },
      "models": [
        { "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "contextWindow": 128000 }
      ]
    }
  ]
}
```

要点：

- `auth.value` 支持 `env:变量名`（推荐，从环境变量取）或明文两种写法
- 模型条目可用 `upstream` 字段把本地模型名重映射到上游真实模型名：
  `{ "id": "fast", "upstream": "deepseek-v4.1-flash", "name": "快速档" }`
- `aliases`：客户端可写短别名代替真实模型名，值写 `providerId/modelId` 精确路由，或只写模型名
- `fallback.order` 填备用 provider id；降级时模型名按「同名模型 → `modelMap` 指定 → 该 provider 第一个模型」决定；
  客户端显式写 `providerId/modelId` 时不会降级
- `budget` 三项限额填 0 表示不限；`action` 为 `warn`（只告警）或 `reject`（超限返回 429）
- 上游若原生支持 `/v1/responses`，在 provider 里加 `"upstreamResponses": true` 可跳过翻译
- 改完配置用界面「保存」或 `POST /api/reload` 热加载；改端口需重启进程

### 日志与轮转（`logs` 段）

| 字段 | 含义 | 取值 |
|---|---|---|
| `enabled` | 是否落盘（关闭后只在内存保留最近 300 条） | `true` / `false` |
| `maxSizeKB` | 单文件上限，超过即轮转 | 64 – 524288（默认 2048） |
| `keep` | 保留归档份数 | 1 – 20（默认 3） |

轮转规则：`requests.log` → `.1` → `.2` … 依次后移，超出 `keep` 的最老一份删除。
磁盘占用上限约 `maxSizeKB × (keep + 1)`。

### 并发与重试（`limits` 段）

| 字段 | 含义 |
|---|---|
| `queue` | 同一 provider 的请求串行排队（默认开） |
| `queueTimeoutMs` | 排队上限，超出返回 503（默认 120s） |
| `retry.enabled` | 429/5xx/网络错误时整请求重放（默认关，重放可能重复计费） |
| `retry.maxAttempts` | 最多尝试次数，含首次（1–5） |
| `retry.backoffMs` | 退避基数，第 n 次重试等 `backoffMs × n` |

重试安全边界：只在尚未向客户端输出任何字节时重放；流式一旦开始绝不重试；
排队或重试等待期间客户端断开立即取消。

## 开机自启（Windows）

```powershell
# 安装：注册登录时自启的计划任务，并立即启动
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action install

# 常用操作
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action status    # 查看状态
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action restart   # 重启
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action uninstall # 卸载（移除任务并结束进程）
```

任务名 `LlmGateway`，登录后通过 `start-hidden.vbs` 无窗口拉起；带「失败后 1 分钟重试 3 次」
和「不因电池模式停止」设置。

## 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查（含 active、uptime、inFlight） |
| GET | `/api/state` | 当前配置（key 已脱敏）+ 运行时信息 |
| POST | `/api/providers` | 新增/更新 provider |
| DELETE | `/api/providers/{id}` | 删除 provider |
| POST | `/api/active` | 切换当前 provider，body `{"id":"..."}` |
| POST | `/api/test` | 连通性测试（只查 `/models`），body `{"id":"..."}` |
| POST | `/api/test/model` | 单模型真实测活，body `{"provider":"...","model":"..."}` |
| POST | `/api/test/models` | 批量测活（串行+节流），body `{"items":[...],"delayMs":1200}` |
| GET | `/api/test/status` | 持久化的测活结果 + 定时测活配置 |
| POST | `/api/test/auto` | 开关定时测活，body `{"enabled":true,"intervalHours":24}`（1–168h） |
| POST | `/api/model` | 设置当前调用模型，body `{"model":"glm-5.3"}` |
| POST | `/api/policy` | 设置路由策略，body `{"policy":"fixed"\|"auto"}` |
| GET | `/api/logs?limit=50` | 最近请求日志 |
| GET | `/api/logs/meta` | 日志容量、轮转配置与文件清单 |
| POST | `/api/logs/config` | 调整轮转策略，body `{"maxSizeKB":4096,"keep":5}` |
| POST | `/api/logs/clear` | 清空活动日志，`{"archives":true}` 连归档一起删 |
| GET | `/api/logs/download?name=requests.log` | 下载日志或归档 |
| GET | `/api/usage` | 用量统计（总额 + 按 provider/model 明细） |
| POST | `/api/usage/clear` | 用量清零 |
| POST | `/api/aliases` | 保存模型别名，body `{"aliases":{"fast":"nextapi/deepseek-v4.1-flash"}}` |
| POST | `/api/fallback` | 配置降级链，body 见配置段 `fallback` |
| POST | `/api/budget` | 配置每日预算，`{"resetToday":true}` 清零今日计数 |
| POST | `/api/circuit` | 配置熔断，`{"reset":"all"}` 或 `{"reset":"providerId"}` 手动复位 |
| POST | `/api/reload` | 重新读取 config.json |

测活返回的 `kind` 分类：`ok`（可用）/ `rate`（429 限流，不代表不可用）/ `auth` / `missing` /
`reject` / `upstream` / `net`。批量测活默认间隔 1.2s（`delayMs` 0–10000 可调）。

## 项目结构

```
llm-gateway/
├── server.js                 主入口：组装模块、HTTP 主流程、优雅退出（零依赖）
├── lib/
│   ├── config.js             配置单例、归一化、原子写、密钥解析
│   ├── util.js               HTTP 工具（readBody/sendJson/头转发/静态资源）
│   ├── logger.js             请求日志：内存记录 + JSONL 落盘 + 按大小轮转
│   ├── usage.js              用量统计 + 每日预算
│   ├── queue.js              每 provider 串行车道 + 熔断
│   ├── routing.js            协议判断、别名、降级链、provider/模型解析
│   ├── proxy.js              代理核心：透传 + Responses 协议翻译代理
│   ├── tester.js             连通性/模型级测活、结果持久化、定时巡检
│   ├── admin-api.js          管理 API（/api/*）
│   └── responses-adapter.js  Codex Responses ⇄ chat/completions 协议翻译
├── public/
│   ├── index.html            管理界面结构（侧边导航，无构建）
│   ├── styles.css            样式（令牌驱动全局布局、扁平面板取代卡片、双主题、响应式）
│   └── app.js                界面交互
├── KNOWLEDGE.md              知识图谱 / 维护手册
├── autostart.ps1             Windows 开机自启管理
├── data/config.example.json  配置样例（脱敏）
└── package.json
```

`data/config.json`（含 key）、`data/requests.log`、`data/usage.json`、`data/model-status.json`、
`start-hidden.vbs` 等运行期文件均已 gitignore，不会入库。

## 维护文档

改代码或接手维护请先读 [KNOWLEDGE.md](./KNOWLEDGE.md)：架构图、模块与函数索引、
请求生命周期、配置/API 契约、设计决策与已知坑、常见维护任务、验证清单、变更历史。

## 已知限制

- `/v1/responses` 默认走翻译层：message、function call、custom tool（apply_patch）、流式增量、
  usage 已覆盖；`reasoning_content` 不转发（客户端看不到思维链）
- Anthropic 请求只发往 anthropic 类上游；把 Claude Code 接到 OpenAI 类上游需另加协议转换
- 默认监听 `127.0.0.1`，管理 API 无鉴权；如需对外提供请自行加反代与鉴权
- 不代理 WebSocket

## License

[MIT](./LICENSE)
