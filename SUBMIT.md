# 上架资料（awesome-dsh-plugin）

## 已经做完的

- 仓库：https://github.com/dyrcjqlgcj/dsh-hindsight-local （20 个文件，topic `dsh-plugin` / `hindsight` / `memory`，当前版本 0.3.0（21 个文件，含 scripts/relocate.mjs））
- Fork：`dyrcjqlgcj/awesome-dsh-plugin`
- 分支 `add-dsh-hindsight-local` 上的条目
  `data/plugins/dyrcjqlgcj__dsh-hindsight-local.yml` 已按 0.3.0 的能力更新（含数据目录可配置、搬盘脚本、模型离线加载）

## 还差一步：开 PR

CI 有一条硬规则——**仓库创建满 1 天**才受理（仓库创建于 2026-10-28T10:30Z）。
时间到了用这条命令开 PR：

```bash
gh api repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls --method POST \
  -f title="feat: 收录 dsh-hindsight-local（本地 Hindsight 记忆插件）" \
  -f head="dyrcjqlgcj:add-dsh-hindsight-local" \
  -f base=main \
  -f body="把 Hindsight 长期记忆放到本机跑：插件自己管理本地记忆服务，注册 10 个 hindsight_local_* 工具；会话开始注入知识页索引，结束写收尾快照（本次诉求 / 最后结论 / 停在哪一步）供下一场会话接续，抽取用用户自己的 LLM key。category=memory。"
```

## 条目内容（已提交到 fork）

```yaml
url: https://github.com/dyrcjqlgcj/dsh-hindsight-local
name: dyrcjqlgcj/dsh-hindsight-local
category: memory
description:
  en: Runs Hindsight long-term memory on your own machine — the plugin manages the local memory server itself (health probe, start, stop, logs), registers ten hindsight_local_* tools for status, page search, page read, recall, remember and reflect, injects a knowledge-page index once per session, writes each finished turn back into the bank, and extracts facts with your own LLM key. At session end it writes a handoff snapshot (requests, last conclusion, where it stopped) that the next session injects as previous progress, so continuing work does not require pasting an exported transcript.
  zh: 把 Hindsight 长期记忆放到自己的机器上跑：插件自己管理本地记忆服务（探活、启动、停止、看日志），注册 10 个 hindsight_local_* 工具（状态、页面检索、读页、召回、写入、反思），每场会话开始时注入一次知识页索引、轮次结束把对话片段写回记忆库，抽取用你自己的 LLM key。会话结束时写一份收尾快照（本次诉求、最后结论、停在哪一步），下一场会话把它注入成「上次进度」，继续干活不必再粘贴导出的聊天记录。
```

## 收录规则里要留意的几条

- 条目就是**一个 YAML 文件**：`data/plugins/<owner>__<repo>.yml`，两个 README 由脚本生成，不要手改。
- 分类取 `memory`；描述里不要带 `: `（冒号加空格），YAML 会当成嵌套键。
- `icon` 只接受 GitHub 托管的光栅图，本仓库只有 `icon.svg`，所以条目里没写 icon（会回退到作者头像）。
- 描述会被维护者拿去和代码核对，所以「10 个工具」这类数字必须与实际一致。
- 纯聚合包不收；有 `dsh.bundle.patch` + `cordis.patch.yml`、有真实代码，才符合形态要求。
