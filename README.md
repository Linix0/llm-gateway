# LLM Gateway · 本地大模型统一代理

一个跑在本机的小服务，把 Codex / Cursor / Claude Code / 任意 OpenAI 兼容客户端统一指向
`http://127.0.0.1:8787`，上游用哪家大模型、用哪把 key，全部在这个网关上切换，客户端完全不用改。

> 要改代码/接手维护，请先读 **[KNOWLEDGE.md](./KNOWLEDGE.md)**（架构、模块索引、设计决策与坑、变更历史）。
> 本文件只讲怎么用。

- 零依赖：只用 Node 内置模块，不需要 `npm install`
- 多 provider：想加几家加几家，界面上一键切换「当前」
- 双协议：OpenAI（`/v1/chat/completions`、`/v1/responses`）与 Anthropic（`/v1/messages`）原样透传
- **协议适配**：上游只支持 `chat/completions` 时，把 Codex 的 Responses 请求（含流式事件、工具调用）
  实时翻译成 chat 协议，再把结果翻回 Responses 格式 —— 这是 Codex 0.16x 唯一能接第三方上游的方式
- 流式直通：SSE 边收边转，不缓冲、不改写响应
- 后台常驻 + 开机自启，无窗口运行
- **模型由网关决定**：客户端写什么模型名都不影响，实际调用哪个模型在网关界面上选
- 请求日志按大小自动轮转，不会无限增长
- **模型级真实测活**：界面上对单个/全部模型发极小请求（`max_tokens=1`）验证真实可用性，
  串行节流避免触发上游限速，429 单独标记为「限流·未验证」而不是误报失败
- **用量统计**：按 provider/model 累计请求数、失败率、token（输入/输出）与耗时，界面一目了然

```
Codex / Cursor / SDK
        │  只认 http://127.0.0.1:8787/v1
        ▼
   ┌──────────────┐   模型级路由 + key 注入
   │  LLM Gateway │ ──────────────►  NextApi      (active)
   │   :8787      │ ──────────────►  AgentRouter
   └──────────────┘ ──────────────►  任意其他 provider
```

## 快速开始

```bash
# 1) 生成配置文件（仓库里只放脱敏样例，真实 key 不入库）
cp data/config.example.json data/config.json
# 编辑 data/config.json，填入你的 baseUrl 与 key

# 2) 设置密钥环境变量（推荐，避免明文落盘）
setx MY_API_KEY "sk-你的密钥"

# 3) 前台运行（调试用，能看到日志）
node server.js

# 或者
npm start
```

打开 <http://127.0.0.1:8787/> 就是管理界面。

管理界面能力：

- **Provider 管理**：新增 / 编辑 / 删除，模型列表用行编辑器维护（模型 ID、显示名、上下文窗口），改动有「未保存」标记，切换前会提醒
- **一键测活**：单个测试或「全部测活」，每个 provider 显示最近连通状态点
- **客户端接入**：Codex / Cursor / cURL / Claude Code 四种接入片段，一键复制，地址与模型名随当前配置自动生成
- **请求日志**：4 秒自动刷新（可关）、全部 / 仅失败筛选、耗时条形图、状态胶囊
- **深浅主题**：右上角 ◐ 切换，记忆在浏览器本地；也可用 `?theme=light` 指定
- **快捷键**：`Ctrl + S` 保存

## 开机自启（后台无窗口运行）

```powershell
# 安装：注册登录时自启的计划任务，并立即启动
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action install

# 查看状态
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action status

# 停止 / 启动 / 重启
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action stop
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action start
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action restart

# 卸载（移除任务并结束进程）
powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action uninstall
```

任务名 `LlmGateway`，登录当前用户后自动拉起，通过 `start-hidden.vbs` 以无窗口方式运行；
设置里带了「失败后 1 分钟重试 3 次」和「不因电池模式停止」。

## 接入客户端

### Codex（`~/.codex/config.toml`）

当前机器上的配置已经是这样，可直接用：

```toml
model = "deepseek-v4.1-flash"
model_provider = "localgateway"
model_reasoning_effort = "high"
model_catalog_json = "C:/Users/Administrator/.codex/local-gateway-catalog.json"

[model_providers.localgateway]
name = "Local LLM Gateway"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "local-gateway"   # 随便填，真实 key 由网关注入
request_max_retries = 1
stream_idle_timeout_ms = 300000
```

切换模型只改 `model` 一行：`deepseek-v4.1-flash` / `deepseek-v4-pro` / `kimi-k3` / `glm-5.3` /
`glm-5.3-flash` / `deepseek-v4-flash` / `gpt-5.6-sol`，也可以写 `agentrouter/gpt-5.6-sol` 精确指定供应商。

> **为什么必须有 `wire_api = "responses"`**：Codex 0.16x 已移除 chat 协议支持，写 `wire_api = "chat"`
> 会直接报 `` `wire_api = "chat"` is no longer supported ``。而 DeepSeek / GLM / Kimi 这些上游只提供
> `/v1/chat/completions`，所以中间的翻译工作由网关的 `lib/responses-adapter.js` 承担。

### Cursor / 任意 OpenAI 兼容客户端

- Base URL：`http://127.0.0.1:8787/v1`
- API Key：随便填（如 `local`）
- Model：用 `/v1/models` 里列出的任一模型名

### Claude Code / Anthropic 协议

在界面里新建一个 `protocol = anthropic` 的 provider，客户端把 Base URL 指向
`http://127.0.0.1:8787`（网关会把 `/v1/messages` 路由到 anthropic 类型的上游，并注入 `x-api-key`）。

## 路由规则

**两种策略**（管理界面顶部「当前调用模型」卡片里切换）：

- **网关固定**（默认，推荐）：客户端传什么模型名都会被替换成界面里选定的「当前调用模型」。
  换模型只去界面点一下，Codex / Cursor / 任何客户端都不用改配置。
- **跟随客户端**：按客户端传来的模型名匹配 provider（唯一声明者优先），匹配不到时回落到当前设置。

无论哪种策略，写成 `providerId/modelId` 都会精确指定、不受策略影响：

| 客户端传的 model | 实际走的 provider |
|---|---|
| `providerId/modelId`（如 `agentrouter/gpt-5.6-sol`） | 精确指定该 provider，并去掉前缀 |
| 网关固定模式下的其他任何模型名 | 当前调用模型（界面里选的那个） |
| 跟随客户端模式下只被某 provider 声明的模型名 | 自动路由到那个 provider |
| 跟随客户端模式下未知的模型名 | 当前 provider + 当前模型 |

对应管理 API：`POST /api/model {"model":"glm-5.3"}`、`POST /api/policy {"policy":"fixed"|"auto"}`，
配置落在 `data/config.json` 的 `activeModel` / `modelPolicy` 字段。

上游真实模型名可在 provider 的模型条目里用 `upstream` 字段重映射：

```json
{ "id": "fast", "upstream": "deepseek-v4.1-flash", "name": "快速档" }
```

## 目录与配置

```
llm-gateway/
├── server.js                 服务主体（零依赖）
├── lib/responses-adapter.js  Responses ⇄ chat/completions 协议翻译
├── public/index.html         管理界面
├── KNOWLEDGE.md              知识图谱 / 维护手册（改代码前必读）
├── data/config.json          provider 配置（本地生成，已 gitignore）
├── data/config.json.bak      上一次保存的备份（原子写产生，已 gitignore）
├── data/config.example.json  脱敏样例，复制成 config.json 使用
├── data/requests.log         请求日志（JSONL，已 gitignore）
├── data/requests.log.1~.N    轮转归档（默认保留 3 份，已 gitignore）
├── autostart.ps1             开机自启管理
├── start-hidden.vbs          由 autostart.ps1 生成的无窗口启动器（已 gitignore）
└── package.json
```

> `data/config.json`、`data/requests.log`、`start-hidden.vbs` 都在 `.gitignore` 里——
> 它们含明文密钥、请求记录或本机绝对路径，不要提交。

`data/config.json` 结构：

```json
{
  "server": { "host": "127.0.0.1", "port": 8787 },
  "active": "nextapi",
  "providers": [
    {
      "id": "nextapi",
      "name": "NextApi",
      "api": "openai",                       // openai | anthropic
      "baseUrl": "https://api.nextapi.store/v1",
      "auth": { "type": "bearer", "value": "env:NEXTAPI_API_KEY" },
      "models": [{ "id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "contextWindow": 128000 }]
    }
  ]
}
```

`auth.value` 支持两种写法：

- `env:变量名` —— 从环境变量取（推荐）
- `sk-xxxx` —— 明文写死

改完 `config.json` 可在界面点「保存」或用 `POST /api/reload` 热加载；改端口需要重启进程。

### 日志与轮转

请求日志按 JSONL 写入 `data/requests.log`，每行一条，**时间统一用本机时区**（形如 `2026-10-22T16:39:01.089+08:00`，带偏移量，跨时区也能还原），
另存毫秒时间戳 `at` 供界面直接渲染本地时间。

在 `config.json` 里用 `logs` 段控制增长（界面「日志管理」面板也能改，改完立即生效）：

```json
{
  "logs": { "enabled": true, "maxSizeKB": 2048, "keep": 3 }
}
```

| 字段 | 含义 | 取值 |
|---|---|---|
| `enabled` | 是否落盘（关掉后只在内存里保留最近 300 条） | `true` / `false` |
| `maxSizeKB` | 单个日志文件上限，超过就轮转 | 64 – 524288（默认 2048，即 2 MB） |
| `keep` | 保留几份归档 | 1 – 20（默认 3） |

轮转规则：`requests.log` → `.1` → `.2` … 依次后移，超出 `keep` 的最老一份直接删除。
因此磁盘占用上限约为 `maxSizeKB × (keep + 1)`（默认约 8 MB）。
界面可一键清空活动日志、下载日志或归档文件。

## 管理界面

浏览器打开 <http://127.0.0.1:8787/>：

- **亮/暗双主题**：右上角切换，或用 `?theme=light` / `?theme=dark` 固定；选择记在 localStorage。
- **分区可折叠**：路由与模型、Provider 编辑、接入片段、请求日志四块各自可收起，右上角「全部折叠/展开」，状态记住。
- **模型行编辑器**：provider 的模型列表逐行增删改，支持 `upstream` 重映射，不用手写 JSON。
- **模型级测活**：每个模型行有「⚡」按钮（真实调用一次 `max_tokens=1`），结果标在行内；
  「测活全部模型」测当前 provider 的全部模型，「测所有模型」跨 provider 全量跑（串行 + 节流）。
  结果会同时着色左侧供应商列表里的模型 chip：绿=可用、黄=限流未验证、红=不可用（划线）。
- **接入片段**：按 provider 直接给出 Codex / Cursor / Anthropic 的配置片段，一键复制。
- **请求日志**：按状态筛选、耗时条形图、自动刷新（默认 4 秒，可在界面关掉），并带日志容量与轮转策略面板。
- **用量统计**：总额格子（请求/失败/输入输出 token/均耗时）+ 按 provider 与模型的明细表，随自动刷新更新。
- `Ctrl/Cmd + S` 保存；有未保存改动时离开页面会提醒。

## 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查（含 active、uptime） |
| GET | `/api/state` | 当前配置（key 已脱敏），含 `runtime` 运行信息 |
| POST | `/api/providers` | 新增/更新 provider |
| DELETE | `/api/providers/{id}` | 删除 provider |
| POST | `/api/active` | 切换当前 provider，body `{"id":"..."}` |
| POST | `/api/test` | 探活（只查 `/models` 列表，不调用模型），body `{"id":"..."}` |
| POST | `/api/test/model` | 单模型真实测活（极小请求），body `{"provider":"nextapi","model":"glm-5.3"}` |
| POST | `/api/test/models` | 批量模型测活（**串行+节流**），body `{"items":[{"provider":"...","model":"..."}],"delayMs":1200}` |
| POST | `/api/model` | 设置当前调用模型，body `{"model":"glm-5.3"}` |
| POST | `/api/policy` | 设置路由策略，body `{"policy":"fixed"\|"auto"}` |
| GET | `/api/logs?limit=50` | 最近请求日志 |
| GET | `/api/logs/meta` | 日志容量、轮转配置与文件清单 |
| POST | `/api/logs/config` | 调整轮转策略，body `{"maxSizeKB":4096,"keep":5,"enabled":true}` |
| POST | `/api/logs/clear` | 清空活动日志，body `{"archives":true}` 连归档一起删 |
| GET | `/api/logs/download?name=requests.log` | 下载日志或归档文件 |
| GET | `/api/usage` | 用量统计（总额 + 按 provider/model 明细） |
| POST | `/api/usage/clear` | 用量清零 |
| POST | `/api/reload` | 重新读取 config.json |

**测活结果分类**（`/api/test/model` 与 `/api/test/models` 返回的 `kind` 字段）：

| kind | 含义 | 界面显示 |
|---|---|---|
| `ok` | 2xx，真实可用 | 绿 ✓ + 耗时 |
| `rate` | 429，上游限流，**不代表模型不可用** | 黄 ⧗ 限流·未验证 |
| `auth` | 401/403，key 失效或等级不够 | 红 ✗ 无权限 |
| `missing` | 404，模型不存在/已下线 | 红 ✗ 模型不存在 |
| `reject` | 400，参数被上游拒绝 | 红 ✗ 参数被拒 |
| `upstream` | 5xx，上游服务故障 | 红 ✗ 上游故障 |
| `net` | 连接失败/超时 | 红 ✗ 网络/超时 |

批量测活默认每个请求间隔 1.2s（`delayMs`，0–10000 可调）。上游普遍有并发和每分钟调用数
限制，串行节流能保证结果可信；想更快可以把 `delayMs` 调小，但可能得到一批 `rate` 假失败。

## 安全说明

- 默认只监听 `127.0.0.1`，局域网内其他机器访问不到。要对外提供请自行加反代和鉴权。
- 明文 key 会落在 `data/config.json` 里。建议改成 `env:变量名`，变量用 `setx` 设成用户级环境变量。
- `data/requests.log` 只记录路径/模型/状态/耗时，不记录 prompt 内容和 key。

## 已知限制

- `/v1/responses` 默认走「Responses → chat」翻译：message、function call、custom tool（apply_patch）、
  流式增量、usage 都已覆盖；reasoning 内容（`reasoning_content`）不转发，客户端不会看到思维链。
- Anthropic 请求只发往 anthropic 类上游；如需把 Claude Code 接到 OpenAI 类上游，需要另加一层协议转换。
- 不做重试：上游返回 4xx/5xx 或 429 时原样透传给客户端，避免重复计费。
- 不代理 WebSocket；`/v1/responses` 的流式走 SSE，已验证可用。
- 若某个上游本身支持 `/v1/responses`，在该 provider 里加 `"upstreamResponses": true` 可跳过翻译直接透传。

## License

[MIT](./LICENSE)
