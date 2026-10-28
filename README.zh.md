# dsh-hindsight-local

把 [Hindsight](https://github.com/vectorize-io/hindsight) 记忆服务搬到**你自己的机器**上，作为 DeepSeek Harness 的插件加载。记忆、抽取、检索、知识页全部在本地 daemon 里跑，LLM 用你自己的 key（DeepSeek / OpenAI / Anthropic / Ollama…），不经过任何托管服务。

官方的 `@vectorize-io/hindsight-coding-agents` 默认连云端、按 token 计费；这个插件是它的本地替身：同样的「一个仓库一个 bank + 知识页 + 会话注入」模型，但是自托管、可离线、成本只有你自己的模型调用费。

## 它做什么

- **拉起服务**：从 `uv` 缓存里找已装好的 `hindsight-api`，`/health` 探活，没起来就 detached 启动并轮询到就绪（默认最多等 240 秒）
- **注入上下文**：会话第一步注入「本仓库有哪些知识页」+ 与你问题相关的几条历史事实（一次会话只注入一次，有字符上限）
- **回写记忆**：一轮对话结束后，把最近几条 user/assistant 消息写进 bank，由服务端 LLM 抽成结构化事实
- **给模型工具**：10 个 `hindsight_local_*` 工具，可查知识页、读全文、检索事实、写入、推理、看状态/日志、启停服务

## 安装

```bash
# 从 GitHub 直接装（推荐）
dsh plugin --profile desktop add github:dyrcjqlgcj/dsh-hindsight-local

# 本地源码目录
dsh plugin --profile desktop add /path/to/dsh-hindsight-local
```

装完重启 DSH（插件在进程启动时读取配置）。

### 前置：一次性的服务端准备

插件不自带 Python 环境，也不在会话里帮你 `uvx` 装包（那是几分钟的重操作）。准备一次即可：

```bash
# 需要 uv：https://docs.astral.sh/uv/
uvx --from hindsight-embed@latest hindsight-embed profile create coding-agent \
  --port 9077 \
  --env HINDSIGHT_API_LLM_PROVIDER=deepseek \
  --env HINDSIGHT_API_LLM_MODEL=deepseek-chat \
  --env HINDSIGHT_API_LLM_BASE_URL=https://api.deepseek.com
```

然后把 key 写进 `~/.hindsight/profiles/coding-agent.env`：

```
HINDSIGHT_API_LLM_API_KEY=sk-...
HINDSIGHT_API_EMBEDDINGS_PROVIDER=local
HINDSIGHT_API_PORT=9077
```

（key 也可以放在插件配置的 `apiKey` 或环境变量 `HINDSIGHT_API_LLM_API_KEY`，优先级见下。）

## 配置

配置文件里的每一项都有默认值，只有想改的才写：

```yaml
# 你的 profile patch 层里
- id: hindsight-local
  config:
    apiUrl: http://127.0.0.1:9077
    autoStart: true
    profile: coding-agent
    apiKey: ''            # 留空则读 HINDSIGHT_API_LLM_API_KEY / profile env / DEEPSEEK_API_KEY
    llmProvider: ''       # 留空按 key 前缀与 baseUrl 推断
    llmModel: ''          # 留空用 provider 默认（deepseek → deepseek-chat）
    llmBaseUrl: ''
    bankTemplate: 'coding-agent::{project}'   # {project} = 工作目录名
    injectPages: true
    recallLimit: 5
    injectMaxChars: 4000
    retainOnIdle: true
    readyTimeoutMs: 240000
    requestTimeoutMs: 20000
```

取值顺序：**插件配置 → 进程环境变量 → profile env 文件 → 内置默认值**。

## 工具

| 工具 | 用途 |
| --- | --- |
| `hindsight_local_status` | 服务/端口/bank/key/知识页数/统计，排障先看这个 |
| `hindsight_local_start` / `_stop` / `_logs` | 启停服务、看日志尾部 |
| `hindsight_local_search` | 搜知识页（架构、约定、关键决策） |
| `hindsight_local_read` | 读知识页全文 |
| `hindsight_local_recall` | 检索原始记忆事实 |
| `hindsight_local_remember` | 写入一条事实 |
| `hindsight_local_reflect` | 对记忆做多步推理 |
| `hindsight_local_pages` | 列出全部知识页 |

## 为什么不用 `hindsight-embed daemon start`

那层包装的「就绪窗口」固定 180 秒，而首次启动要装 ~450 MB 依赖、下载嵌入/重排模型（bge-small + cross-encoder），实测 3–5 分钟，于是命令误报 `Daemon Failed (Timeout)`，进程其实还在初始化。本插件直接拉起 `hindsight-api` 可执行文件并自己轮询 `/health`，慢就等，不等就给日志。

## Windows 上的两个坑（插件已内置处理）

1. **控制台编码**：启动横幅里的方块字符在 GBK 控制台会 `UnicodeEncodeError` → 注入 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`。
2. **证书链**：`huggingface_hub` 走 httpx，不认 Windows 证书存储，首次下模型会 `CERTIFICATE_VERIFY_FAILED` → 如果你把 Windows 根证书导出成 PEM 放在 `~/.hindsight/winroot.pem`，插件会自动把它用作 `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE`。

导出命令（PowerShell，一次就够）：

```powershell
$out = "$env:USERPROFILE\.hindsight\winroot.pem"
Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root | ForEach-Object {
  "-----BEGIN CERTIFICATE-----"
  [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
  "-----END CERTIFICATE-----"
} | Set-Content -Encoding ascii $out
```

## 与官方插件的关系

- 默认值刻意对齐：bank 名同为 `coding-agent::{project}`，profile 同为 `coding-agent`。两个插件都装时它们看同一份记忆，但**注入会重复**，建议只留一个。
- 官方插件配置在 `~/.hindsight/coding-agent.json`（`serverMode` / `apiUrl` / `apiToken`）；本插件读 cordis 配置，不改那个文件。
- 官方插件在本机常被判成 `daemon_no_llm`：它的 LLM 探测最后一步是 `which claude`，Windows 没有 `which`，于是直接跳过 daemon 模式。本插件不依赖该探测。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-hindsight-local
```

记忆数据在 `~/.hindsight` 与 uv 缓存里，卸载插件不会删它们；要清干净就手动删这两个目录。

## 许可证

MIT
