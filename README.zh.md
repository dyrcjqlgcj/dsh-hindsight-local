# dsh-hindsight-local

把 [Hindsight](https://github.com/vectorize-io/hindsight) 记忆服务搬到**你自己的机器**上，作为 DeepSeek Harness 的插件加载。记忆、抽取、检索、知识页全部在本地 daemon 里跑，LLM 用你自己的 key（DeepSeek / OpenAI / Anthropic / Ollama…），不经过任何托管服务。

官方的 `@vectorize-io/hindsight-coding-agents` 默认连云端、按 token 计费；这个插件是它的本地替身：同样的「一个仓库一个 bank + 知识页 + 会话注入」模型，但是自托管、可离线、成本只有你自己的模型调用费。

## 它做什么

- **拉起服务**：从 `uv` 缓存里找已装好的 `hindsight-api`，`/health` 探活，没起来就 detached 启动并轮询到就绪（默认最多等 240 秒）
- **注入上下文**：会话第一步注入「本仓库有哪些知识页」+ 与你问题相关的几条历史事实（一次会话只注入一次，有字符上限）
- **回写记忆**：一轮对话结束后，把最近几条 user/assistant 消息写进 bank，由服务端 LLM 抽成结构化事实
- **给模型工具**：10 个 `hindsight_local_*` 工具，可查知识页、读全文、检索事实、写入、推理、看状态/日志、启停服务
- **顶替交接文档**：会话结束时写一条**收尾快照**（本次的诉求 + 最后的结论 + 停在哪儿），下一场会话开头注入成「上次进度」——不用再把整份聊天记录导出成 Markdown 粘来粘去（详见 [交接：会话收尾快照](#交接会话收尾快照)）

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
    handoffSnapshot: true     # 会话结束写收尾快照
    snapshotMaxChars: 1500    # 快照正文上限
    dataDir: ''               # 数据目录，留空用系统默认；见「把数据放到别的盘」
    offlineModels: true       # 模型已缓存就不再联网校验
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

## 交接：会话收尾快照

DSH 左上角「上下文 → 交接文档」那一页，内容其实是整场会话的逐条导出（`bili export`，含思维链、工具参数、工具原始输出）。换会话时把它整个粘过去，又长又贵：本仓库实测一次导出里 assistant 块占 63.7%，其中思维链 47.6%，而真正需要的只是「上次做到哪、下一步是什么」。

这个插件改成写快照：

- **会话结束**（`disposed`）写一条「收尾快照」，内容是项目路径、会话 id、本次所有用户诉求（每条截 400 字符）、最后一条 assistant 结论（截 800），总长不超过 `snapshotMaxChars`（默认 1500）。
- **归组**：一场会话的所有写入都用同一个 `document_id = dsh-session:<会话id>`，服务端按文档归组；快照本身的 tags 是 `dsh-session` + `dsh-session-handoff`，轮次片段是 `dsh-session` + `dsh-session-turn`。
- **下一场会话**：注入内容里多出「上次停下的地方」小节——最多 3 条、每条截 220 字符，来自 `recall`，不是全文。
- **核对**：随时 `hindsight_local_recall("上次会话做到哪一步，下一步要做什么")`，或 `hindsight_local_recall("<会话关键词> 收尾快照")`。
- **关掉**：`handoffSnapshot: false`。

快照是「背景」而不是「指令」：注入时明确写成「先当背景，需要时再核对」，避免上一场会话的结论覆盖当前用户的明确要求。

## 把数据放到别的盘

服务默认把三样东西放在 C: 的用户目录下：

| 内容 | 默认位置 | 搬法 |
| --- | --- | --- |
| 嵌入式 PostgreSQL（安装 + 数据库） | `~/.pg0` | 只能目录联接（`pg0.exe` 位置写死，服务也不转发 `data-dir`） |
| 嵌入/重排模型缓存 | `~/.cache/huggingface` | 环境变量 `HF_HOME`，或联接 |
| uv 缓存（server 可执行文件在这里） | `%LOCALAPPDATA%/uv/cache` | 环境变量 `UV_CACHE_DIR`，或联接 |

一条命令搬完（会先停服务与数据库、搬移、在原路径建联接、再起服务并确认 `/health`）：

```bash
node scripts/relocate.mjs --to D:/hindsight-data
node scripts/relocate.mjs --to D:/hindsight-data --dry-run    # 只看会做什么
```

搬完把 `dataDir` 填成同一个目录：

```yaml
- id: hindsight-local
  config:
    dataDir: D:/hindsight-data
```

`dataDir` 会让插件在拉起服务时设 `UV_CACHE_DIR`、`HF_HOME`、`SENTENCE_TRANSFORMERS_HOME`，因此**新装**也可以直接用配置指定位置，不必先联接到默认路径；只有已经存在的 `~/.pg0` 必须靠 `relocate.mjs` 搬（它替你做联接）。

三个默认位置都能用环境变量改：`HINDSIGHT_PG0_DIR`、`HINDSIGHT_HF_DIR`、`HINDSIGHT_UV_DIR`。

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
