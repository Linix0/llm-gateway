# LLM Gateway · 本地大模型统一代理

一个跑在本机的小服务，把 Codex / Cursor / Claude Code / 任意 OpenAI 兼容客户端统一指向
`http://127.0.0.1:8787`，上游用哪家大模型、用哪把 key，全部在这个网关上切换，客户端完全不用改。

- 零依赖：只用 Node 内置模块，不需要 `npm install`
- 多 provider：想加几家加几家，界面上一键切换「当前」
- 双协议：OpenAI（`/v1/chat/completions`、`/v1/responses`）与 Anthropic（`/v1/messages`）原样透传
- **协议适配**：上游只支持 `chat/completions` 时，把 Codex 的 Responses 请求（含流式事件、工具调用）
  实时翻译成 chat 协议，再把结果翻回 Responses 格式 —— 这是 Codex 0.16x 唯一能接第三方上游的方式
- 流式直通：SSE 边收边转，不缓冲、不改写响应
- 后台常驻 + 开机自启，无窗口运行

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

| 客户端传的 model | 实际走的 provider |
|---|---|
| `providerId/modelId`（如 `agentrouter/gpt-5.6-sol`） | 精确指定该 provider，并去掉前缀 |
| 只被某一个 provider 声明过的模型名 | 自动路由到那个 provider |
| 其他任何模型名 | 「当前」provider（界面上一键切换） |

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
├── data/config.json          provider 配置（本地生成，已 gitignore）
├── data/config.example.json  脱敏样例，复制成 config.json 使用
├── data/requests.log         请求日志（JSONL，已 gitignore）
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

## 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查（含 active、uptime） |
| GET | `/api/state` | 当前配置（key 已脱敏） |
| POST | `/api/providers` | 新增/更新 provider |
| DELETE | `/api/providers/{id}` | 删除 provider |
| POST | `/api/active` | 切换当前 provider，body `{"id":"..."}` |
| POST | `/api/test` | 探活，body `{"id":"..."}` |
| GET | `/api/logs?limit=50` | 最近请求日志 |
| POST | `/api/reload` | 重新读取 config.json |

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
