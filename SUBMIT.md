# 上架资料（awesome-dsh-plugin）

## 已经做完的

- 仓库：https://github.com/dyrcjqlgcj/dsh-hindsight-local （18 个文件，topic `dsh-plugin`）
- Fork：`dyrcjqlgcj/awesome-dsh-plugin`
- 分支 `add-dsh-hindsight-local` 上已加好条目文件
  `data/plugins/dyrcjqlgcj__dsh-hindsight-local.yml`（commit `e64cba5`）

## 还差一步：开 PR

CI 有一条硬规则——**仓库创建满 1 天**才受理（仓库创建于 2026-10-28T10:30Z）。
时间到了用这条命令开 PR：

```bash
gh api repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls --method POST \
  -f title="feat: 收录 dsh-hindsight-local（本地 Hindsight 记忆插件）" \
  -f head="dyrcjqlgcj:add-dsh-hindsight-local" \
  -f base=main \
  -f body="把 Hindsight 长期记忆放到本机跑：插件自己管理本地记忆服务，注册 10 个 hindsight_local_* 工具，会话开始注入知识页索引、结束回写，抽取用用户自己的 LLM key。category=memory。"
```

## 条目内容（已提交到 fork）

```yaml
url: https://github.com/dyrcjqlgcj/dsh-hindsight-local
name: dyrcjqlgcj/dsh-hindsight-local
category: memory
description:
  en: Runs Hindsight long-term memory on your own machine — the plugin manages the local memory
      server itself (health probe, start, stop, logs), registers ten hindsight_local_* tools for
      status, page search, page read, recall, remember and reflect, injects a knowledge-page index
      at the start of each turn and writes the finished turn back into the bank, and extracts
      facts with your own LLM key.
  zh: 把 Hindsight 长期记忆放到自己的机器上跑：插件自己管理本地记忆服务（探活、启动、停止、看日志），
      注册 10 个 hindsight_local_* 工具（状态、页面检索、读页、召回、写入、反思），每轮开始时注入
      知识页索引、轮次结束把对话片段写回记忆库，抽取用你自己的 LLM key。
```

## 收录规则里要留意的几条

- 条目就是**一个 YAML 文件**：`data/plugins/<owner>__<repo>.yml`，两个 README 由脚本生成，不要手改。
- 分类取 `memory`；描述里不要带 `: `（冒号加空格），YAML 会当成嵌套键。
- `icon` 只接受 GitHub 托管的光栅图，本仓库只有 `icon.svg`，所以条目里没写 icon（会回退到作者头像）。
- 描述会被维护者拿去和代码核对，所以「10 个工具」这类数字必须与实际一致。
