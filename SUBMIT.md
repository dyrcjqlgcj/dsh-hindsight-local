# 上架资料（awesome-dsh-plugin）

市场应用 `dshmarket` 只读 `https://awesome-dsh-plugin.com/plugins.json`，而那份清单由
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库的 CI 生成。
所以「上架」= 去那个仓库提一个 PR，在列表里加一条。

## 一条目的字段（与 plugins.json 对应）

| 字段 | 值 |
| --- | --- |
| name | `dsh-hindsight-local` |
| owner | `<你的 GitHub 用户名>` |
| url | `https://github.com/<你>/dsh-hindsight-local` |
| category | `memory`（记忆） |
| install | `dsh plugin --profile web add github:<你>/dsh-hindsight-local` |
| npm / tarball | 留空（本插件走 GitHub 源码安装） |
| capabilities | `fs-write`、`fs-read`、`shell`、`network`、`env`、`llm` |
| icon | `https://raw.githubusercontent.com/<你>/dsh-hindsight-local/main/icon.svg` |

## 中英简介

**zh**

> 把 Hindsight 长期记忆搬到本机：插件自己管理本地记忆服务（探活、按需拉起、停止、看日志），
> 提供 10 个 `hindsight_local_*` 工具（状态/搜索/读页/召回/写入/反思/页面清单），
> 并在每轮对话开始注入本仓库的知识页索引、轮次结束时把对话片段写回记忆库。
> LLM 用你自己的 key（DeepSeek/OpenAI/Anthropic/本地 Ollama 均可，也可直接读
> `~/.hindsight/profiles/*.env`），数据不出本机，没有云端订阅费。

**en**

> Brings Hindsight long-term memory onto your own machine: the plugin manages the local memory
> service itself (health probe, on-demand start, stop, logs), registers ten `hindsight_local_*`
> tools (status / search pages / read page / recall / remember / reflect / list pages), injects a
> knowledge-page index at the start of every turn and writes the finished turn back into the bank.
> Extraction runs on your own LLM key (DeepSeek, OpenAI, Anthropic or local Ollama, or whatever
> `~/.hindsight/profiles/*.env` already holds). Nothing leaves the machine and there is no cloud
> subscription.

## 提 PR 前要做的两件事

1. `gh auth login -h github.com`（当前 token 已失效）
2. 建仓并推送：

   ```bash
   gh repo create dsh-hindsight-local --public --source . --push
   ```
