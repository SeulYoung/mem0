# local-memory — 给 Cursor 的全本地记忆层

在**所有**代码工程里为 AI 提供持久记忆：始终自动记录、会话开始自动注入、数据 100% 留在本机。

- **不改动本仓库任何上游文件**，全部实现都在这一个目录内（见 [升级指南](#升级指南)）
- **无 Docker、无 Python、无 Ollama**：只要 Node ≥ 20
- **记忆数据永不出本机**：本地 ONNX 嵌入模型 + 本地 SQLite 向量库
- **总结模型走 Cursor CLI**（默认 `claude-sonnet-5-low`），把啰嗦的 prompt 提炼成干净事实；关一个开关就回到全离线的原文存储
- **记忆按仓库隔离**，用的是 mem0 自己的 `agent_id`，所以向量过滤、实体索引、消息回放三处一起隔离（见 [DESIGN.md](DESIGN.md#仓库标识就是-mem0-的-agent_id)）

**这份文档只讲"怎么装、怎么用、怎么配"。** 每个决定背后的取舍和证据（为什么记忆存英文、为什么总结走 CLI 而不是 baseURL、为什么巡检要主动起服务、`kind` 各类别的判据、与 mem0 的边界和上游已知问题）都在 **[DESIGN.md](DESIGN.md)**；每个实现细节的"这行为什么这么写"只在代码注释里——`src/config.mjs` 是配置项的唯一权威说明。

## 架构

```
Cursor / JetBrains 等 ACP 宿主（任意工程）
├── hooks（~/.cursor/hooks.json）           确定性；但只有 Cursor 自己执行
│   ├── sessionStart        → 读取本仓库记忆，注入到会话初始上下文
│   ├── beforeSubmitPrompt  → 暂存你这条 prompt，立刻放行
│   ├── afterAgentResponse  → 把 AI 的回答追加到同一轮
│   └── stop                → 一轮结束，prompt + 回答一起交给后台进程写入
│
└── MCP server（~/.cursor/mcp.json）        供 AI 主动读写，并在握手时注入记忆
    ├── instructions        → 同一份记忆 + 协议，宿主无关
    └── memory_search / memory_add / memory_list / memory_update / memory_delete / memory_stats
                    │
                    ▼
        mem0ai（npm 包）本地 OSS 模式
        ├── 嵌入：fastembed 本地 ONNX（默认 bge-small-en-v1.5，384 维）
        ├── 存储：SQLite 向量库（语义 + BM25 关键词 + 实体加权三路融合）
        ├── 重排：mem0 的交叉编码器（本地 ONNX，第四路）
        └── 总结：mem0 的事实抽取 → 本层的 LLM 桥 → cursor-agent CLI（唯一出网的环节）
                    │
                    ▼
        ~/.mem0-local/          ← 数据目录，独立于本仓库
        ├── config.json         配置
        ├── vectors.db          记忆本体（vectors_entities.db 是实体索引）
        ├── history.db          变更历史 + mem0 回放的最近消息
        ├── models/             嵌入模型（约 50MB）+ transformers/ 重排模型（约 87MB）
        ├── queue/              等待后台写入的轮次（失败的留成 *.failed）
        ├── turns/              正在进行中的那一轮（每个会话一个文件，写完即删）
        ├── llm-workspace/      总结模型的空白工作区（只读、与任何仓库隔离）
        ├── llm-usage.json      今日模型调用计数（配额保护）
        ├── heartbeat.json      上一次真实会话的环境指纹
        ├── watchdog.json       上一次巡检的结论
        └── logs/               运行日志

Windows 计划任务（每 2 小时 + 每次登录后，独立于 IDE 之外）
└── cli.mjs watch  → 用能找到的每个 IDE 自带 node 真起一次 MCP server，起不来就弹系统通知
```

每一层为什么是这个选择，见 [DESIGN.md 的「为什么是这套组合」](DESIGN.md#为什么是这套组合)。

## 安装

```powershell
cd E:\GitHub\mem0\local-memory
npm install
node scripts/install-cursor.mjs   # 幂等合并写入 ~/.cursor/mcp.json 与 ~/.cursor/hooks.json
node scripts/install-watchdog.mjs # 注册定时巡检，失效时弹系统通知
node scripts/install-sweeper.mjs  # 注册每月清理，删掉过期满 30 天的记忆
node src/cli.mjs doctor           # 自检
```

然后**重启 Cursor**（或 Reload Window）。安装脚本只新增自己的条目，已有的 MCP server 和 hooks 都保留，且每次写入前自动备份为 `*.bak-<时间戳>`。

验证：Cursor Settings → MCP 里能看到 `mem0-local` 的 6 个工具；Customize → Hooks 里能看到四个 hook（`sessionStart` 注入，`beforeSubmitPrompt` / `afterAgentResponse` / `stop` 合起来记录一轮对话）。想用总结模型还需要 Cursor CLI 处于登录状态（`cursor-agent status`）；不想用就把 `llm.enabled` 设成 `false`。

用环境变量存 Cursor 凭据的话（`llm.apiKey` 默认就是 `env:CURSOR_API_KEY`），要设成用户级永久变量，重启 Cursor 后 hook 子进程才继承得到：

```powershell
[Environment]::SetEnvironmentVariable('CURSOR_API_KEY', 'crsr_你的完整token', 'User')
```

取不到就自动退回 CLI 当前登录的账号，两条路任何一条通系统就能跑。填完跑 `doctor`，看 `model live probe` 那行。

### 给某个具体工程接入

**不需要为每个仓库单独配置。** MCP 和 hooks 装在用户级 `~/.cursor/` 下，对所有在 Cursor 里打开的工程自动生效，记忆按仓库自动隔离。想确认某个仓库确实通了，用真实 hook 载荷打一遍：

```powershell
node scripts/test-hooks.mjs D:\UGit\HappyArenaTMR\HappyArena
```

输出里 `project under test` 就是这个仓库的记忆归属。三点需要留意：

- **项目 id 来自 git remote，不是文件夹名。** 例如上例的 remote 是 `.../fortunegame/FTBattle.git`，所以 id 是 `fortunegame/ftbattle`，显示名才是 `HappyArena`。用 remote 是有意的：换盘符、改文件夹名、重新 clone，记忆都还在。没有 remote 的目录退回"文件夹名 + 路径哈希"。
- **嵌套仓库要注意打开哪一层。** 上例里 `HappyArenaTMR` 和它下面的 `HappyArena` 各自都是 git 仓库，在 Cursor 里打开哪个目录作为工作区就落到哪个仓库的记忆里，两者不互通。
- 工程自己的 `.cursor/hooks.json` 不会和这套冲突（Cursor 会合并各来源的 hooks）。但**不要**再往工程里装一份本方案的 hook：那样每个事件都触发两次，两个进程互相把对方刚暂存的那一轮冲掉，先落库的很可能是只剩 prompt 的半轮。

## 日常怎么用

**你不需要做任何事**，正常和 AI 对话即可：

- **每一轮对话**（你的 prompt ≥25 字符、非 `/` 开头）会被自动记录：prompt 在你按下回车时暂存，AI 的回答在这一轮结束时并进来，两半一起交给总结模型提炼成干净的**英文**事实（后台进行，你感觉不到）。同一条 prompt 重发不会再记一遍，也不会再花一次模型调用。**这一条只在 Cursor 里成立**，ACP 宿主下没有自动捕获
- 每个新会话开始时，本仓库的既有记忆会被自动注入（两条通道，宿主无关）
- AI 学到值得长期记住的东西（偏好、约定、决策理由、坑）时会调 `memory_add`；同一句事实写第二次会被挡掉，换个说法写也会被挡掉并告诉它撞上了哪一条
- AI 需要回忆过去时会调 `memory_search`（自动记录的对话也在检索范围内）。**查询也得是英文**：不含任何 ASCII 字母或数字的查询只有语义一路能跑，检索出来的其实是"哪条记忆的中文最多"，所以这种查询会带回一条 `warning`，说明这次排序是任意的（理由见 [DESIGN.md](DESIGN.md#检索的三路信号)）

### 两条写入通道的分工

记忆有两个来源，故意不一样：**hook 保证"一定会记"，MCP 保证"记得好"**（为什么要两条，见 [DESIGN.md](DESIGN.md#两路写入hook-与-mcp)）。

| | Hook：自动捕获一轮对话 | MCP：AI 主动写 |
| --- | --- | --- |
| 谁触发 | Cursor 的三个事件，与 AI 想不想记无关 | AI 判断"这条值得长期记住" |
| 记的是什么 | 一轮对话的两半：你的 prompt + AI 的回答（回答按 `capture.maxResponseChars` 截尾部） | AI 交上来的一句干净事实 |
| 过不过总结模型 | 过。每轮一次调用，约 15 秒，跑在后台，受 `llm.maxCallsPerDay` 限制 | 默认不过（`distil: true` 才过），所以工具调用不会卡 15 秒 |
| 什么时候落库 | 这一轮结束之后（`stop`）；写入在独立进程里 | 工具调用当场返回结果 |
| 落成什么 `kind` | 一律 `prompt`，**不进会话注入**，用 `prune --kind prompt` 清理 | 七个类别之一，由 AI 按判据填，进注入白名单 |
| 判重 | 输入哈希按整轮算（原封重放免费；同一问题换个回答会重新交给模型判断），加上 mem0 抽取路径自己的"有没有新事实" | 输入哈希 + 语义判重（0.92 报错并点名撞上的那条） |
| 失败会怎样 | 静默且可查：日志一行、`queue/*.failed`、`doctor` 报数；抽取失败回落原文存储 | 直接把错误返回给 AI，它自己决定改哪条或 `force` |
| 哪些宿主有 | 只有 Cursor（ACP 宿主一个 hook 都不跑） | 任何跑 cursor-agent 的宿主，含 JetBrains 等 ACP 宿主 |

一轮对话跨三个 hook，所以中途放弃也有兜底：`beforeSubmitPrompt` 暂存到 `~/.mem0-local/turns/`，`afterAgentResponse` 往里追加回答，`stop` 把它交给后台进程。这一轮没等到 `stop`（关窗口、切走），下一条 prompt、下一个会话、或任何宿主里下一次启动 MCP server 都会把它按"只有 prompt"写掉，超时时间是 `capture.turnTimeoutMinutes`；`doctor` 的 `turns awaiting end` 那行就是这些还没落库的轮次。只想要原来那种"发出即记录"的行为：`capture.includeResponse: false`。

### 两类宿主分别能拿到什么

上面那张表是"记忆从哪来"，这张表是"你在哪用"。**Cursor 跑 hooks，ACP 宿主（CLion / Rider 等 JetBrains IDE 里的 `cursor-agent acp`）一个 hook 都不跑**——这是实测出来的，不是配置问题（证据和后果见 [DESIGN.md](DESIGN.md#宿主差异cursor-与-acp-宿主)）：

| 能力 | Cursor（桌面版 / CLI） | ACP 宿主（JetBrains 等） |
| --- | --- | --- |
| 会话开始注入本仓库记忆 | 两遍：`sessionStart` hook + MCP `instructions`（各不超过 `inject.maxChars`，确定主力宿主后可关掉一条） | 一遍：只有 MCP `instructions` |
| 自动记录一轮对话 | **有**，三个 hook 合起来 | **没有**。这是唯一真正缺的能力，只能靠 AI 主动调 `memory_add` |
| 6 个 `memory_*` 工具 | 有 | 有，完全一样 |
| 认领没结束的轮次 | `sessionStart` + 下一条 prompt + MCP server 启动 | MCP server 启动（所以在这边泡一整天，Cursor 里丢下的那一轮也会被补写） |
| 抽取模型、判重、重排、仓库隔离 | 同一套代码，宿主无关 | 同 |
| 失效告警与每月清理 | Windows 计划任务，跑在 IDE 之外 | 同 |

还有第三类宿主：**Cloud Agents**。用户级 `~/.cursor/hooks.json` 在那边不加载、`sessionStart` 也不支持，所以本方案在云端等于只剩 MCP 那一半；记忆库本来也在本机，不适用。

**两边混用是安全的**：记忆库、仓库归属、判重都不分宿主，同一个仓库在 Cursor 里记下的东西在 CLion 里搜得到，反之亦然。差别只在"有没有人替你记"。

写记忆时该用哪个 `kind`、注入为什么只有最近几条，见 [DESIGN.md](DESIGN.md#kind一份自己的类别词表)。想手动管理时用 CLI：

```powershell
node src/cli.mjs doctor                              # 健康检查（存储 / 嵌入 / 总结模型 / Cursor 接线）
node src/cli.mjs add "以后提交信息统一用中文" --kind preference
node src/cli.mjs add "一大段啰嗦的话..." --infer      # 交给总结模型拆成若干条事实
node src/cli.mjs add "这条只在 5.4 期间成立" --expires 2026-12-31   # 到期自动淘汰
node src/cli.mjs add "本次需求的背景与范围..." --kind context --expires 2026-09-30   # context 不给 --expires 会被拒
node src/cli.mjs add "和已有记忆很像但确实是两回事" --force        # 硬写，跳过语义判重
node src/cli.mjs search "how to write a commit message" --top 5   # 不给 --top 就用 search.topK；加 --all 搜索所有仓库
node src/cli.mjs search "10.BuildPC.bat" --explain   # 打印三路信号各贡献了多少
node src/cli.mjs search "build script" --no-rerank   # 只看三路融合排序，对比重排效果
node src/cli.mjs search "构建脚本"                   # 查询也要用英文：纯中文只有语义一路能跑，会在 stderr 上警告
node src/cli.mjs list --limit 20                     # 加 --expired 连过期的一起列
node src/cli.mjs stats
node src/cli.mjs update 1223f031 "改正后的正文"       # 8 位短 id 就够；保留 id 与 createdAt
node src/cli.mjs update 1223f031 --expires 2026-12-31
node src/cli.mjs update 1223f031 --clear-expiry
node src/cli.mjs history 1223f031                    # 这条记忆被改过几次、改之前写的是什么
node src/cli.mjs delete <id>                         # 只能删本仓库的记忆
node src/cli.mjs prune --kind prompt --days 30 --yes  # 清理 30 天前自动记录的 prompt
node src/cli.mjs prune --expired                     # 看每月清理这次会删哪些（不加 --yes 只列出）
node src/cli.mjs prune --expired --yes                # 立刻清理过期满 30 天的记忆
node src/cli.mjs watch                               # 立刻巡检一次（加 --no-notify 不弹窗）
```

**记忆一律用英文写、也用英文搜**（这是量出来的：英文 top-1 命中 92%，中文 75%，理由和完整对照见 [DESIGN.md](DESIGN.md#记忆语言英文实测决定)）。自动捕获的 prompt 由总结模型翻译，你手动搜的时候得自己用英文。

## 配置

配置文件 `~/.mem0-local/config.json`。hook 每次触发都是新进程，改完下一条 prompt 就生效；**MCP server 在会话开始时读一次**，改动要等下一个会话（重开窗口 / Reload Window）。

**每个字段的含义、取值范围和选它的理由都写在 `src/config.mjs` 的注释里**，那份是唯一权威，这里只列有哪些块：

| 块 | 管什么 |
| --- | --- |
| `userId` | 记忆归属者，所有记录挂在它下面。默认取本机账号名 |
| `embedder.*` | 嵌入模型（本地 fastembed 或任何 OpenAI 兼容端点）与维度缓存 |
| `llm.*` | 总结模型：开关、provider、模型 slug、CLI 路径、凭据、每日调用上限、追加给 mem0 的 `customInstructions` |
| `reranker.*` | 第四路重排：开关、provider、模型、候选集宽度 |
| `search.topK` | 一次搜索最多返回几条，默认 6（mem0 自己的默认是 20，差异的理由见 [DESIGN.md](DESIGN.md#和-mem0-默认值不一样的三处)）。是上限而非配额，命中少就返回得少；`memory_search` 的 `topK` 参数和 CLI 的 `--top` 可以按次覆盖 |
| `search.threshold` | mem0 的相关性下限（`null` = 用它自己的 0.1）。**不建议调高**，融合分不可跨查询比较；想试的话 CLI 有 `search --threshold` 可以临时覆盖 |
| `dedupe.similarity` | 判为"说的是同一件事"的余弦阈值，默认 0.92 |
| `prune.*` | 每月清理：`expiredGraceDays`（过期后再留多久才真删，默认 30）、`dayOfMonth`。前者在清理时才读，改了不用重新注册任务 |
| `capture.*` | 自动记录的开关与过滤：长度上下限、跳过前缀、`kind`、是否提炼；以及按轮捕获的三个字段 `includeResponse` / `maxResponseChars` / `turnTimeoutMinutes` |
| `inject.*` | 会话注入：总开关、两条通道各自的开关、`recent` 条数、`maxChars` 字符上限、`kinds` 白名单、`includeProtocol` |
| `watchdog.*` | 失效告警：开关、巡检间隔、重复弹窗间隔、探活超时、是否弹窗 |
| `telemetry` | 默认 `false`，已关闭 mem0 的匿名遥测 |

环境变量（临时覆盖，不改文件）：`MEM0_LOCAL_NO_LLM=1` 关掉总结模型，`MEM0_LOCAL_NO_RERANK=1` 关掉重排，`MEM0_LOCAL_USER_ID` 换归属者，`MEM0_LOCAL_HOME` 换数据目录。

**改默认值不会自动生效——除了登记过的那几个。** 首次运行会把整份默认配置快照写进 `config.json`，此后源码里改默认值只对新机器有效。`src/config.mjs` 的 `SUPERSEDED_DEFAULTS` 表专门解决这个：登记"哪个字段的旧默认值已作废"，只在磁盘上的值仍等于那个旧默认值时丢弃并重写文件，自己动手调过的数字不受影响。目前表里只有 `inject.maxChars`（2500 → 5000）。

**接本地 Ollama 或公司内网网关**（都属于 OpenAI 兼容端点，这条路不经过 Cursor）：

```json
{
  "embedder": { "provider": "openai", "baseURL": "http://localhost:11434/v1", "model": "bge-m3", "apiKey": "ollama", "dimension": null },
  "llm": { "enabled": true, "provider": "openai", "baseURL": "http://localhost:11434/v1", "apiKey": "ollama", "model": "qwen2.5:7b" }
}
```

> **换嵌入模型 = 换向量空间。** 维度缓存会自动作废，但旧的 `vectors.db`/`vectors_entities.db` 必须归档或删除——不同维度的向量没法一起检索。老记忆要保留就先 `node src/cli.mjs list --all` 导出，重建后再写回。历史库（`history.db`）不受影响。

## 维护

- **备份**：整个 `~/.mem0-local` 目录复制走即可（`models/` 可以不备份，会自动重新下载）
- **日志**：`~/.mem0-local/logs/mem0-local.log`，包含每次注入/记录/模型调用（含 token 用量）/失败原因；Cursor 侧的 hook 报错看 Customize → Hooks 的输出面板
- **失败的记录**：后台写入失败会留下 `~/.mem0-local/queue/*.json.failed`，`doctor` 会报数量
- **没落库的轮次**：`~/.mem0-local/turns/` 里每个文件是一轮还没结束的对话，正常只有零到一个。堆了一批说明 `stop` hook 没在跑（`doctor` 的 `turns awaiting end` 会报出其中过了超时的），每个文件都是一条还没记下的记忆。过了 `capture.turnTimeoutMinutes` 的会在下一个会话被补写，认领它的有三处：下一条 prompt、`sessionStart`、以及任何宿主里启动 MCP server（所以在 JetBrains 里干活也算）
- **模型用量**：`llm-usage.json` 是当天计数；日志里 `[llm]` 行有每次调用的 `duration_ms` 和 token 明细
- **失效告警**：`watchdog.json` 是上次巡检结论，`heartbeat.json` 是上次真实会话的环境指纹。计划任务叫 `mem0-local watchdog`（`schtasks /Query /TN "mem0-local watchdog"` 查，`install-watchdog.mjs --uninstall` 摘）。它为什么要主动起一次服务、以及它到底在防什么，见 [DESIGN.md 的「失效告警」](DESIGN.md#失效告警)
- **过期清理**：`last-sweep.json` 是上次清理的时间与删除条数，`doctor` 里对应 `expired memories` 和 `monthly sweep` 两行。计划任务叫 `mem0-local sweep`，每月 1 号 03:30 跑 `prune --expired --yes`（`install-sweeper.mjs --uninstall` 摘掉，摘掉只是不再清理，不删任何东西）。为什么要清、为什么留 30 天反悔窗口，见 [DESIGN.md 的「记忆的更新与淘汰」](DESIGN.md#记忆的更新与淘汰)
- **历史库文件**：`history.db`，只增不减（删记忆不会删历史）。`cli history <id>` 是它唯一的读法——`update` 改掉的旧正文只存在这里。要清理直接删文件，下次用到会重建；`vectors.db` 才是记忆本体。旧版本留下的 `history/` 目录（每个仓库一个文件）已经没人读了，可以整个删掉；代价是换 `agent_id` 之前写的那批记忆，`history` 命令查不到它们的变更行（会明确告诉你行在哪个目录里）
- **迁移备份**：`migrate-to-agent-scope.mjs` / `rekey-project.mjs` 动手前会把 `vectors.db` 和 `vectors_entities.db` 复制成 `*.bak-<时间戳>`。确认结果没问题后自行删除，它们就是唯一的撤回手段

自检脚本（前八个不调用模型，快且不花钱）：

```powershell
node scripts/smoke-test.mjs       # 配置→嵌入→写入→检索→统计 全链路
node scripts/test-mcp.mjs         # 真实 MCP 握手驱动全部工具；判重、短 id 改正、仓库归属、过期与恢复、认领未结束的轮次
node scripts/test-hooks.mjs       # 真实 hook 载荷驱动四个 hook：按轮配对、未结束的轮次兜底、BOM 载荷、防递归
node scripts/test-hooks.mjs D:\path\to\other\repo   # 指定仓库，验证某个工程的接线
node scripts/test-retrieval.mjs   # 三路信号、重排、判重两道、到期日、实体链接、跨仓库读写边界
node scripts/test-cli.mjs         # 真起 CLI 进程：参数解析、--explain、短 id 改正、变更历史、到期日与清理
node scripts/test-injection.mjs   # 注入实际发出多少条：预算、两个上限、老 config.json 迁移
node scripts/test-health.mjs      # 失效告警：环境指纹、心跳、抑制窗口、真实探活（--notify 真弹一条）

node scripts/test-llm.mjs         # 抽取路径：作用域用桩模型验（免费），再真调 4 次模型（约 50 秒）
$env:MEM0_LOCAL_NO_LLM=1; node scripts/test-llm.mjs   # 只跑免费那一半
node src/cli.mjs doctor           # 会真调一次模型（live probe）
node scripts/probe-prompt-size.mjs   # 打印 mem0 实际发给模型的 prompt 有多大、结构如何
node scripts/bench-embedding.mjs     # 嵌入模型/语言方案的召回对比（不花钱；不给参数会跑全部 10 种，含 2GB 的 e5）
node scripts/bench-embedding.mjs en-bge-en   # 只跑当前在用的那种，几秒钟
node scripts/bench-candidates.mjs    # 重排候选集要多宽才够；末尾直接给结论和余量，余量不足会出声
node scripts/bench-retrieval.mjs     # 中文标识符 + 英文注解那条规则端到端还成不成立（会断言，退化非零退出）；附重排分数曲线
$env:MEM0_LOCAL_BENCH_ROOT="D:\path\to\repo"; node scripts/bench-retrieval.mjs   # 分数曲线换一个仓库的库来看
```

## 升级指南

这是本方案的核心设计目标之一。

**升级本仓库（mem0）时**：本目录没有修改上游任何一个文件（可以对比确认：新增的只有 `local-memory/` 这一个顶层目录）。所以：

1. 用新版本覆盖/重新下载仓库时，只需保留（或复制回）`local-memory/` 这一个目录
2. 目录路径不变的话什么都不用做——Cursor 里的绝对路径依然有效
3. `node_modules` 丢了就 `npm install`
4. 把仓库或本目录**移动、改名**了：重新执行 `node scripts/install-cursor.mjs`（会更新 `~/.cursor` 里的绝对路径，旧条目自动替换而不是重复添加）

> 想彻底不受仓库影响：把整个 `local-memory/` 移到仓库外（例如 `E:\tools\local-memory`），再跑一次 `install-cursor.mjs`。它不依赖仓库里的任何文件。

**给仓库加了、换了或删了 git remote 之后**：仓库标识会跟着变（有 remote 用 `owner/repo`，没有则用目录名加路径哈希），已有记忆仍带着旧标识，在新标识下搜不到也不会注入。用一次性脚本把它们迁过去，默认只报告不改动：

```powershell
node scripts/rekey-project.mjs                                 # 列出库里所有仓库标识及条数
node scripts/rekey-project.mjs --from <旧标识>                  # 先看会动哪些
node scripts/rekey-project.mjs --from <旧标识> --yes            # 确认后执行
```

不带参数就是清单模式——`list` 和 `stats` 显示的都是仓库**名**（目录名，每个 clone 都一样），只有这里能看到真正的标识。它只改归属（`agent_id`，以及实体索引里跟着走的那些行），id、日期、kind、正文、过期时间都不动，所以把 `--from` 和 `--to` 对调就能撤回；`--to` 不给时取当前目录所属仓库，因此要在仓库根目录跑（在 `local-memory/` 里跑会被拦下来）。

**从 `metadata.project` 时代升上来**（仓库归属改成 mem0 的 `agent_id` 之前写的记忆）：那些记忆在任何按仓库的读取里都是隐身的，先跑一次一次性迁移，同样默认只报告：

```powershell
node scripts/migrate-to-agent-scope.mjs         # 报告：多少条记忆、多少行实体会动
node scripts/migrate-to-agent-scope.mjs --yes   # 执行（自动备份两个 .db）
node src/cli.mjs list --limit 5                 # 验证：能列出来就说明归属对了
```

幂等，跑两次无害。带 `--global` 写过的记忆没有去处（`agent_id` 一次只能是一个值，"全局"这个概念已经没有了），脚本会报出条数并跳过；想留就用 `--global-to <仓库标识>` 把它们塞进某个仓库。为什么要换、代价是什么，见 [DESIGN.md](DESIGN.md#仓库标识就是-mem0-的-agent_id)。

**升级 mem0 记忆引擎本身**（与本仓库无关，走 npm）：

```powershell
npm install mem0ai@latest      # 或指定版本
node scripts/smoke-test.mjs    # 验证；异常就 npm install mem0ai@3.1.6 回退
```

`package.json` 里锁的是 `mem0ai@^3.1.6`；跨大版本升级前先看上游 migration guide，尤其注意存储格式与 `search`/`getAll` 的参数约定，以及 [DESIGN.md 的「上游 mem0 的已知问题」](DESIGN.md#上游-mem0-的已知问题)那张表里还成不成立。

⚠️ **升级 `fastembed` 或 `@huggingface/transformers` 之后，先确认 `overrides` 里的 `onnxruntime-node` 仍然对两者都成立**（两个原生 ONNX 运行时共存会让进程直接崩掉，没有任何 JavaScript 异常，原因见 [DESIGN.md 的「第四路：重排」](DESIGN.md#第四路重排)末尾）：

```powershell
npm ls onnxruntime-node --all      # 期望只有一个版本
node scripts/test-retrieval.mjs    # 同一进程里先嵌入再重排；崩溃会体现为非零退出码
```

**卸载**：

```powershell
node scripts/install-cursor.mjs --uninstall   # 只摘掉 Cursor 接线，记忆数据保留
node scripts/install-watchdog.mjs --uninstall # 摘掉定时巡检的计划任务
node scripts/install-sweeper.mjs --uninstall  # 摘掉每月清理的计划任务
Remove-Item -Recurse $env:USERPROFILE\.mem0-local   # 如果连数据一起删
```

## 已知限制

- **没有跨仓库的「全局记忆」。** 归属用的是 mem0 的 `agent_id`，一次查询只接受一个值，所以"本仓库 + 全局"一次读不出来；一条记忆归哪个仓库也是写入时定的，改归属得跑 `rekey-project.mjs`。理由和代价见 [DESIGN.md](DESIGN.md#仓库标识就是-mem0-的-agent_id)。真需要一条到处可见的偏好，就在用得到的仓库里各写一条。
- **自动记录的记忆要等这一轮结束才出现。** 一轮对话是记忆的单位，而 AI 的回答只有到 `stop` 才完整；这一轮被中断（关窗口、切走）就只记下 prompt 那一半，且要等下一条 prompt 或下一个会话才补写。想回到"发出即记录"就把 `capture.includeResponse` 关掉。
- **AI 的回答只留尾部 `capture.maxResponseChars` 个字符**（默认 2000）。一轮的结论通常在最后，但一个把关键事实说在开头、之后又跑了几十次工具调用的回答，会只剩下后面那些无关的部分。
- Cursor 的 `beforeSubmitPrompt` hook 官方**不支持注入上下文**，所以"每轮对话按当前问题自动检索"做不到确定性实现。检索发生在两处：会话开始时注入 + AI 需要时主动搜索。注入的协议文本会明确提醒 AI 去搜。
- **ACP 宿主（JetBrains IDE 等）不执行 Cursor 的任何 hook**，Cloud Agents 也不加载用户级 `~/.cursor/hooks.json`。两边的会话注入都由 MCP `instructions` 覆盖，缺的是自动记录一轮对话，只能靠 AI 主动调 `memory_add`（逐项对照见[上面那张表](#两类宿主分别能拿到什么)）。
- **注入通道被上游砍掉是唯一没被监控的失效**：cursor-agent 转发 MCP `instructions` 是实测行为、不是有契约的 API，真没了的话工具还在、巡检全绿，只有注入静默消失。
- 首次运行下载嵌入模型（约 50MB），首次搜索再下载重排模型（约 87MB）。之后嵌入、检索、重排全部离线；开着总结模型时抽取那一步会出网到 Cursor。
- **开着模型时，一条 prompt 可能一条记忆都不存**。mem0 会把已有记忆一起交给模型判断，认定"没有新事实"就返回空——这是去重生效，不是丢数据，日志里能看到 `stored=0`。模型跑偏（回复里没有 JSON）会被判为失败并回落原文存储，所以这两种情况不会混在一起。
- **连着快发好几条长 prompt，可能出现近似重复的记忆**。每条 prompt 的抽取跑在各自的后台进程里、各约 15 秒；A 还没写完 B 已经在读"已有记忆"了。三道兜底（输入哈希、mem0 的内容哈希、语义判重）全都是"先查再写"，查的时候对方还没落库。删掉多余那条即可。
- **判重是尽力而为，不是保证。** 除了上面的并发窗口，过期记忆也不参与判重（过期就该当它不存在），于是理论上可以写出一条和某条已过期记忆同哈希的新记忆，之后清掉那条的到期日就会看见两条一样的。
- **语义判重会不会拒掉本该存下的记忆？** 阈值 0.92 留了余量，但没有阈值能保证。它被设计成**报错而不是静默丢弃**就是为了这一刻：消息里带着撞上那条的 id 和正文，要么 `memory_update` 改那条，要么 `force` 硬写。真的经常误判就调 `dedupe.similarity`。
- **开着模型时抽取失败会回落原文存储**，如果 mem0 是在写入部分记录之后才抛错，回落这一次就会重复写。它的实体链接和消息落库都各自 `try/catch` 了，所以这个窗口很窄，但不是零。
- 本机的 `cursor-agent` 来自 CLion 捆绑目录（路径带版本号）。CLion 升级后如果 PATH 变了，`doctor` 会在 `model live probe` 那行报失败，此时装一个独立的 Cursor CLI 或把 `llm.command` 填成绝对路径即可；期间记忆照常按原文存储，不会丢。
- 向量检索是全表余弦扫描，个人规模（万级记忆）足够快；量级远超预期时可以把 `vectorStore.provider` 换成需要服务端的实现。
