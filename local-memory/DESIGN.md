# local-memory 设计取舍与 mem0 边界

**这份文档只回答"为什么是这么设计的"**，安装、配置、日常命令都在 [README.md](README.md)。

下面每一节都是当时量过、有证据的结论，写在这里是为了别再翻案；而每个实现细节的"这行为什么这么写"只在代码注释里写一遍——`src/config.mjs` 是配置项的唯一权威说明，`src/memory.mjs` 是判重与写入边界，`src/llm.mjs` 是模型桥，`src/injection.mjs` 是注入文本，`src/wording.mjs` 与 `src/tools.mjs` 是 AI 可见的提示词，`src/watchdog.mjs` 是巡检。

## 为什么是这套组合

| 决策 | 原因 |
| --- | --- |
| 用 npm 上的 `mem0ai` 包，而不是引用本仓库源码 | 运行时与仓库解耦：仓库怎么升级、甚至整个删掉重下，都不影响这套记忆系统 |
| 不用 `server/` 的 Docker 自托管栈 | 这台机器没有 Docker/Python；且那个栈的 LLM/嵌入只内置 openai/anthropic/gemini，要接本地模型必须改 `server/main.py`——那是上游文件，会被升级冲掉 |
| 总结模型只在后台捕获时调用，MCP 写入默认不调 | 抽取一次约 15 秒。后台进程里没人等它，这笔时间是免费的；而 AI 调 `memory_add` 时交上来的已经是一句干净事实，再过一遍模型只会让工具调用卡住 15 秒 |
| hooks 负责"一定会记"，MCP 负责"记得好" | hooks 是确定性的，不依赖模型是否想起来调工具；MCP 让 AI 主动写入提炼后的高质量记忆（分工见[两路写入](#两路写入hook-与-mcp)） |
| hook 捕获的单位是一轮对话，不是一条 prompt | 结论通常在回答里而不是问题里；而 mem0 的 `add()` 本来就收 `Message[]`，所以配对是零额外配额的——每轮仍然只有一次抽取 |
| 会话注入同时走 hook 和 MCP 握手两条通道 | hooks 只有 Cursor 自己执行，ACP 宿主（JetBrains 等）一条都不跑；MCP 的 `instructions` 两边都到得了 |
| 巡检靠**主动起一次服务**，不靠心跳超时 | 心跳只在你开新会话时才跳，"一下午没聊天"和"服务已经死了"长得一模一样。主动探活跟你活不活跃无关，也就没有误报 |
| 巡检跑在 IDE 之外的独立 node 上 | IDE 自带的运行时正是被监控对象之一；跟着被监控对象一起死的看门狗不算看门狗 |
| 数据放 `~/.mem0-local` 而非仓库内 | 仓库可以随时替换/重下，记忆不受影响 |

## 记忆语言：英文（实测决定）

**记忆一律以英文存储，检索也用英文查询**，靠 mem0 公开的 `customInstructions` 要求抽取时翻译。这不是审美偏好，是在本项目自己的语料上量出来的——`scripts/bench-embedding.mjs`，12 条真实记忆 + 12 个自然提问：

| 方案 | 维度 | top1 | MRR | margin |
| --- | --- | --- | --- | --- |
| **英文存储 + 英文查询 + `bge-small-en-v1.5`** | 384 | **92%** | **0.938** | **+0.062** |
| 英文存储 + 英文查询 + `multilingual-e5-large` | 1024 | 83% | 0.917 | +0.018 |
| 中文存储 + 中文查询 + `bge-small-zh-v1.5` | 512 | 75% | 0.836 | +0.038 |
| 中文存储 + `multilingual-e5-large` | 1024 | 75% | 0.850 | +0.009 |
| 中文存储 + bge 中文查询指令前缀 | 512 | 75% | 0.836 | +0.035 |
| 中英双语存储 + 中文查询 | 512 | 75% | 0.831 | +0.034 |
| 中文存储 + 翻译成英文的查询 | 1024 | 67% | 0.801 | +0.003 |
| 英文存储但没换模型（中文模型读英文） | 512 | 42% | 0.618 | −0.005 |

`margin` 是"正确记忆的分数 − 最强错误记忆的分数"，它才是决定排序的量：绝对相似度全挤在 0.5 也不影响排序，只要 margin 稳定为正。四个结论：

- **换更大的多语言模型没用**，甚至更糟：e5-large 在中文上 top1 同样 75%，但 margin 从 +0.038 掉到 +0.009——它把所有相似度压到 0.8 以上，区分度更差，还 2GB、慢得多。
- **bge 的查询指令前缀无效**（v1.5 官方也说可省），**中英双语存储无效**（中文模型看英文那半段等于噪声）。
- **只翻译查询是最差的方案**。小模型的跨语言对齐很弱，别指望"中文存、英文查"。
- **两边都换成英文才有效**：75% → 92%，模型反而更小更快。

代价与前提：写路径本来就要调模型做抽取，把 `customInstructions` 改成"写成英文"是零成本；**短 prompt 也必须走模型**（`capture.inferMinChars` 因此降到 25 = `minChars`），否则中文原样进库、英文模型基本检索不到；**你自己用 CLI 搜的时候得用英文**，这是这条路线唯一真实的日常摩擦。BM25 那一路对中文是彻底失效而非打折（见[上游已知问题](#上游-mem0-的已知问题)），所以这个决定比"嵌入模型偏好英文"更硬。

`test-llm.mjs` 用真实 hook 送一条中文 prompt，断言落库文本无中日韩字符且标识符原样保留。要退回中文路线：`embedder.model` 改回 `fast-bge-small-zh-v1.5`、`customInstructions` 改回要求保持原语言、`inferMinChars` 调回 80，然后按 [README 的「换嵌入模型」](README.md#配置)重建向量库。

## 总结模型：走 Cursor CLI

记忆的"提炼"由 mem0 自己的事实抽取流程完成，模型是 Cursor 的 `claude-sonnet-5-low`。同一句输入的效果差别：

```
输入：帮我看下这个崩溃，另外提醒你一下，我们这个项目里 Lua 业务代码里禁止用 pcall，
      之前出过事故；还有以后你给我写的提交信息统一用中文，不要英文。构建的话走
      10.BuildPC.bat 那个脚本，别自己敲 UBT 命令。

关掉模型（原文存储）：整段照抄成一条记忆，"帮我看下这个崩溃"这种一次性噪音也留下了

开着模型：拆成 3 条，噪音被丢掉
  · 用户所在项目规定 Lua 业务代码中禁止使用 pcall，此前曾因此出过事故
  · 用户要求以后提交信息（commit message）统一用中文书写，不要用英文
  · 用户要求构建项目时统一走 10.BuildPC.bat 脚本，不要自己手动敲 UBT 命令
```

**为什么是 CLI 而不是填一个 baseURL：Cursor 没有任何 OpenAI 兼容的推理端点。** `api.cursor.com` 上公开的是 Admin / Analytics / Cloud Agents 三类 API，文档明确写着 "They are not a standalone model-inference or chat-completions API"；`crsr_` 前缀对应的是 Admin API 的 key（要求 `admin:*` scope），不是推理凭据；Cloud Agents API 虽然收 prompt，但异步、要起虚拟机、按 agent run 计费。唯一 documented 的同步"给 prompt 拿文本"通路是 CLI 的 print 模式：

```
mem0 的事实抽取
  → llm.provider = "langchain"（mem0 官方的自定义模型注入点）
  → src/llm.mjs 的桥接对象（只暴露 invoke，返回 { content }）
  → cursor-agent --print --output-format json --model claude-sonnet-5-low --mode ask
```

三个实测踩出来的实现细节（原因见 `src/llm.mjs` 注释）：prompt 走 **stdin** 而不传位置参数；绕开 `cursor-agent.cmd` 直接调它自带的 `node.exe index.js`；`--mode ask` + 空白工作区，让总结模型碰不到任何仓库。

其中 stdin 那条值得单独记住，因为它的替代方案**失败得很安静**：把长 prompt 写成文件让 agent 去读，会被当成注入攻击拒绝执行（"that file isn't a legitimate task specification"），而每次拒绝都静默回落成原文存储——你不会收到任何报错，只会觉得记忆越来越搜不出来。改走 stdin 后顺带还快了：

| | 文件传输 | stdin |
| --- | --- | --- |
| 单次抽取 API 耗时 | 7~16 秒 | 4.5~5 秒 |
| 每次调用 cache read | ~52.8k tokens | ~26.3k tokens |
| `test-llm.mjs` 全套 4 次调用 | 70 秒 | 47 秒 |
| 抽取被拒绝 | 偶发，静默回落原文 | 未再出现 |

**模型名必须是 `cursor-agent models` 列出的 slug**，裸的 `claude-sonnet-5` 不是合法值，带 effort 后缀的才是（各档的取舍见 `llm.model` 的注释）。

**凭据**默认是 `"apiKey": "env:CURSOR_API_KEY"`，读不到就退回 CLI 当前登录的账号。`crsr_` 是文档里 Admin API key 的前缀，CLI 认不认它无法在没有完整 token 的情况下验证——所以配置留成了"读不到就用 CLI 登录态"，两条路任何一条通系统就能跑。

**成本**：每次抽取约 12 秒（其中 7~8 秒是 CLI 自身启动），mem0 的 prompt 约 9.7k tokens，另有 CLI 自己的系统 prompt 约 26k（命中缓存时按 cache read 计费），都算在你的 Cursor 账号上。三层保护：只在后台调用（你感觉不到那 15 秒）；`llm.maxCallsPerDay` 默认 200，超了自动退回原文存储；抽取失败（超时、没登录、超配额、CLI 找不到）一律回落原文存储并在日志留一行 `infer failed, storing verbatim: <原因>`，有回归测试覆盖。**模型挂了不会丢记忆。**

**防递归**：总结模型自己就是一个 Cursor agent，会继承用户级 `~/.cursor` 配置——也就是我们这套 hooks 和 MCP。放任不管就是抽取调用触发 `beforeSubmitPrompt`、把 34k 的抽取 prompt 记成一条 prompt、又触发一次抽取，无限循环烧配额。所以每个入口都先判断自己是不是嵌套调用，靠两个独立信号（环境变量 + 工作区路径，因为实测 Cursor 启动 MCP 子进程时不传我们的环境变量）；命中就不记录、不注入、MCP server 直接退出。`test-hooks.mjs` 有回归测试。

## 会话注入的两条通道

每个新会话开始时，本仓库最近的记忆连同一段使用协议一起交给 AI。这件事由两条通道各做一遍，默认都开（`src/injection.mjs` 是它们共用的唯一文本来源）：

| 通道 | 机制 | 覆盖范围 |
| --- | --- | --- |
| `sessionStart` hook | 返回 `additional_context` | 只有 Cursor 自己 |
| MCP `instructions` | 握手 `initialize` 返回的 `instructions` 字段，agent 把它当作这个 server 的使用说明转交模型 | 任何跑 cursor-agent 的宿主，含 ACP |

**为什么需要第二条：ACP 宿主根本不执行 Cursor 的 hooks。** 在 CLion 2026.2 里用 `cursor-agent acp` 手工建会话、发 prompt，日志里既没有 `[session-start]` 也没有 `[capture]`——hook 引擎明明打包在 CLI 里、`~/.cursor/hooks.json` 也有效，就是不被调用；而 `~/.cursor/mcp.json` 里的 MCP server 每个会话照常启动。第二条通道是拿一个临时 MCP server 在 `instructions` 里埋魔术串、让模型原样报出来验证的（`test-mcp.mjs` 里有一条用例守着：先写一条记忆，再开一个连接，断言它出现在新连接的 `instructions` 里）。

两个代价：**在 Cursor 里同一份记忆会进两次上下文**（各不超过 `inject.maxChars`），确定主力宿主后关掉一条即可；**自动捕获只有 hook 一条路**，ACP 宿主下只能靠 AI 自己调 `memory_add`（见[宿主差异](#宿主差异cursor-与-acp-宿主)）。

**选哪几条：按时间取 `recent` 条，装不下的跳过。** 排序只有"新"这一个标准，所以一条纲领性约定会被当天的零碎发现挤下去——它天生是旧的。**注入不是全部记忆，AI 开工前仍要 `memory_search`**，协议文本里就是这么要求的；实测一条排在第 15 位、根本没进注入的原则，用四种自然问法搜都稳定排第 1。`inject.maxChars` 必须装得下 `recent` 条，否则小的那个上限说话、另一个是谎话（实测一条注入行 400–800 字符、均值约 530）。`scripts/test-injection.mjs` 守着这件事：预算跳过超长记忆、两个上限不打架、老 `config.json` 的迁移，不碰记忆库、毫秒级。

## 两路写入：Hook 与 MCP

记忆有两个来源，它们不是冗余，而是各自补另一条的结构性缺陷：**hook 不会忘记，但不知道什么重要；MCP 知道什么重要，但可能想不起来写。** 只留 hook，库里全是原始对话；只留 MCP，一个不调工具的会话就等于什么都没发生，而且这种失效是安静的。两路的具体分工、字段、失败表现列在 [README](README.md#两条写入通道的分工)，这里只说为什么这么划。

**hook 这一路捕获的单位是一轮对话，而不是一条 prompt。** 之前只记 prompt，等于把每轮里信息量更大的那一半直接丢掉——你问"这次构建为什么失败"，结论（"shader 缓存过期，构建前得先跑 clear-shader-cache-3311.bat"）在回答里，问题里一个字都没有。而这半边一直是免费的：mem0 的 `add()` 本来就收 `Message[]`，把两条消息交上去仍然只是**一次**抽取调用，配额零增长，只是那一次的 prompt 长了一点。`test-llm.mjs` 用桩模型断言了这件事——mem0 拼出来的抽取 prompt 里两侧都在。

代价与边界：

- **写入时机从"发出"推到"这一轮结束"。** 回答只有到 `stop` 才完整，所以记忆也只能那时才落库。换来的是完整的一轮，付出的是几分钟延迟和一条兜底路径。
- **三个 hook 是三个进程，没有共享内存。** 一轮对话的两半因此得落到磁盘上（`~/.mem0-local/turns/<会话>.ndjson`），而且必须是**追加写**：一轮里可以有多条 assistant 消息，各自在自己的进程里，读-改-写会让后落地的那次覆盖掉前一次。
- **没等到 `stop` 的那一轮必须有人认领。** 关窗口、切走、hook 被卸载，`stop` 就永远不来。三个地方兜：同一会话的下一条 prompt（发现还有暂存的就先写掉）、下一个 `sessionStart`、以及任何宿主里下一次启动 MCP server（后两者扫的是超过 `capture.turnTimeoutMinutes` 的，理由见[宿主差异](#宿主差异cursor-与-acp-宿主)）。都写成"只有 prompt 的一轮"，因为那半确实存在。`doctor` 的 `turns awaiting end` 报的就是这批——它是"记忆静默少了一条"的唯一可见处。
- **回答只留尾部。** agent 的回答开头是"我先看一下日志"，结尾才是结论，所以截断从头上切、留 `capture.maxResponseChars`（默认 2000）。这个数直接乘在每次抽取的 token 上，mem0 自己的 prompt 已经约 9.7k。
- **输入哈希按整轮算（prompt + 留下的回答），不只按 prompt。** 判重那道门在 mem0 之前，所以它按什么算，就决定了哪些轮次 mem0 有机会去挖。只按 prompt 算的话，同一个问题第二次问、这次得到的回答好得多，会在 mem0 看到新的那半之前就被静默拒掉——而 mem0 本来会挖出来：它的抽取会拿到已有记忆并只报新事实。原封不动的重放哈希不变，依然免费；代价是"同一问题、换个措辞的回答"要多花一次抽取（15 秒、一次配额），由 mem0 自己判断有没有新东西。
- **该不该调模型按整轮的长度算**（`capture.inferMinChars`）。只量 prompt 会让"为什么？"配三段结论走原文路径，落库的是那句光秃秃的提问、回答整段丢掉。默认下 `minChars` 与 `inferMinChars` 都是 25，所以这条平时不触发，但一旦有人把 `inferMinChars` 调高，量错的那个版本就开始悄悄丢回答。
- **回落原文时丢掉回答。** 抽取失败（超时、没登录、超配额）时 mem0 的原文路径是**一条消息存一条记忆**，把整段 agent 回答直接存成一条记忆只会污染库，所以回落只存 prompt 那一半。
- **只接 `afterAgentResponse`，不接 `afterAgentThought`。** 思考块是过程，而且量大、措辞不定；抽取模型看它只会把"我先看一下日志"这类东西当成候选事实。
- **`run_id` 仍然没用上。** 它才是 mem0 给"会话"留的键，能让 `## Last k Messages` 只回放本会话。但它同时进 payload，会改变判重与检索的过滤条件，收益（更干净的抽取上下文）远小于风险，所以留在原地。

## 宿主差异：Cursor 与 ACP 宿主

上一节分的是"记忆从哪来"，这一节分的是"你在哪用"。同一套安装（`~/.cursor/mcp.json` + `~/.cursor/hooks.json`）在不同宿主下能力并不相同，逐项对照在 [README](README.md#两类宿主分别能拿到什么)，这里说清楚它为什么这样、以及为此做了什么。

**hook 引擎打包在 CLI 里，但 ACP 模式不调它。** 这不是"CLI 版本太老"或"配置写错了"，而是同一个二进制的两种模式行为不同：**本层的防递归就是 print 模式确实跑 hooks 的证据**——总结模型是拿 `cursor-agent --print` 起的，而正是它会触发 `beforeSubmitPrompt`、把抽取 prompt 记成一条记忆，所以才必须挡（见[总结模型：走 Cursor CLI](#总结模型走-cursor-cli)）。而 `cursor-agent acp` 实测一个都不跑：在 CLion 2026.2 里手工建会话、发 prompt，日志里既没有 `[session-start]` 也没有 `[capture]`，同一个会话里 MCP server 却照常启动。于是三类宿主：

| 宿主 | hooks | MCP | 结果 |
| --- | --- | --- | --- |
| Cursor 桌面版、`cursor-agent`（含 `--print`） | 全跑 | 有 | 完整：自动记录 + 注入 + 工具 |
| ACP 宿主（JetBrains 里的 `cursor-agent acp`） | **一个都不跑** | 有 | 缺自动记录，其余齐全 |
| Cloud Agents | 只认仓库里的 `.cursor/hooks.json`，用户级的不加载；`sessionStart` 本身也不支持 | 有 | 记忆库在本机，本就不适用 |

**这个缺口只丢"一定会记"，不丢"记得好"。** ACP 宿主下 AI 依然拿得到会话注入和 6 个工具，所以它主动写下的高质量记忆一条不少；缺的是那条不依赖模型自觉的确定性通路。这也是为什么两路写入必须都存在：如果自动记录是唯一来源，换一个宿主就等于整套系统静默失效。

**认领没结束的轮次因此做成了宿主无关的。** 按轮捕获把 prompt 暂存在 `~/.mem0-local/turns/` 里，而认领它的两个 hook（下一条 prompt、下一个 `sessionStart`）都只在 Cursor 跑。所以 MCP server 启动时也认领一次：每类宿主都会起它，于是"在 Cursor 里丢下半轮、然后一整天待在 CLion"这条路径不再是记忆静默少一条。probe 运行（`MEM0_LOCAL_PROBE=1`，巡检和测试走的那条）跳过这一步——让被测试驱动的路径去写真实记忆库，和让它去删一样不合适。

**要补齐自动记录，只能在 IDE 和 agent 之间插一个 ACP stdio 代理**：JetBrains 允许在 `~/.jetbrains/acp.json` 里把 agent 命令换成自己的程序，由它转发 ACP 的 JSON-RPC 并顺手抄一份 prompt 与回复。尚未实现——它要跟一个没有稳定契约的协议双向对齐，而当前收益（一个宿主的自动记录）撑不起这份维护成本。

不受宿主影响的部分：记忆库、仓库归属与隔离、判重、重排、抽取模型，以及**失效告警和每月清理**——那两个跑在 Windows 计划任务里、在 IDE 之外，本来就与你用哪个宿主无关。唯一没被监控的失效也在这条边界上：cursor-agent 是否继续转发 MCP 的 `instructions` 是实测行为而非契约（见[失效告警](#失效告警)末尾）。

## `kind`：一份自己的类别词表

**mem0 的 OSS 版没有类别字段**（categories 是 Platform 专有功能，而它那份内置词表是消费级的——`personal_details`、`family`、`sports`、`food`……照搬过来这个库里的记忆会整桶落进 `technology`）。mem0 自己的文档也明说：标签是写入时就已知的固定值时用 `metadata`，不必让分类器去猜。所以 `kind` 放在 metadata 里、由调用方填，是 mem0 推荐的那条路。

唯一的差异是**谁定标签**：Platform 用异步分类器推断，我们让 AI 自己填。既然如此判据就必须写给 AI 看，否则这根轴只是六个没定义的词。词表和判据在 `src/memory.mjs` 的 `KIND_GUIDE` 里定义一次，`KINDS` 由它的键派生，MCP 工具描述由它生成——加一个类别却忘了写判据在结构上做不到。

| kind | 判据 |
| --- | --- |
| `preference` | 人的口味，与仓库无关：用什么语言回答、用什么工具、提交信息怎么写。**主语是人** |
| `convention` | 这个仓库要求你怎么做。能自然读成一句祈使句——要这样、别那样 |
| `decision` | 已经定下的选择**加上理由**。说得出它击败了哪个选项 |
| `gotcha` | 会**静默**咬人的行为：不知道它就会写出看着对其实错的代码，而且没有任何报错。要说出症状 |
| `fact` | 量出来的数，或核实过的、你控制不了的外部状态。没有要遵守的，也没有要避开的症状 |
| `note` | 以上都不是，但下次会话仍值得知道。兜底项，很少是正确答案 |

两条真会判错的边界（同样写进了工具描述）：像 fact 又像 gotcha 时，**第一次就大声失败的约束是 `fact`**；像 convention 又像 decision 时，**下次动手要照着做的是 `convention`**，解释"为什么现在长这样"的是 `decision`。另有一条不是分类而是准入：**不要存进度**（"X 现在已经完成了"很快就不再成立，却永远读起来像新闻），存它留下的那个成立的事实；还没做成的东西（想清楚的设计、约定好的下一步）要带 `expiresAt`，因为这个库里除了到期之外没有任何东西会删它。

词表之外还有第七个值 `prompt`：只有自动记录的 hook 会写，不进注入白名单，用 `prune --kind prompt` 清理。它故意不出现在工具 schema 的 enum 里，免得 AI 把一条正经记忆归到这类下面。

## 判重的两道

**mem0 自己的判重只存在于抽取路径**——`addToVectorStore` 既拿已有记忆的 `hash` 挡掉完全相同的内容，又把邻近记忆塞进 prompt 让模型只报"新的部分"。而原文写入的 `createMemory` 两样都不做，给什么存什么。缺了这一层，AI 把同一句事实换个说法调两次 `memory_add` 就会存成两条。所以本层补两道，各自对应 mem0 缺的那一半：

| 这一道 | 怎么问 | 命中时 |
| --- | --- | --- |
| 同一份输入又来了 | 把输入哈希下推给 mem0 的过滤器（`getAll({ filters: { …, source_hash } })`，存储层就筛掉了，不需要嵌入） | **静默**返回 0 条。这只说明这份输入已经处理过——重放的捕获、重复的命令——没有需要人判断的东西 |
| 说的是同一件事 | 用 mem0 的 `search()` 取回 10 条，挑其中 `score_details.semanticScore` 最高的那条（≥ `dedupe.similarity`，默认 0.92） | **报错**并点名撞上的那条。只有调用方能决定是改那条还是坚持这是两件事——`force` / `--force` 是后者的出口 |

`source_hash` 哈希的是**输入原文**而不是存下来的文本：开模型后存的文本已经和你打的字不一样，靠比对文本认不出"同一条 prompt 又发了一次"，那会白花 15 秒和一次配额。第二道只在原文路径上跑，抽取路径上 mem0 自己做得更好（它比的是事实不是措辞）。阈值和用 `semanticScore` 而非融合分的理由都在 `src/config.mjs` 与 `src/memory.mjs` 注释里。

**第二道不能只看第一名。** mem0 返回的顺序是融合分排的，BM25 和实体加权都会挪动它，所以余弦最高的那条不一定排在最前——只问第一名等于问了另一个问题，真正的近似重复排第二就漏掉了。取 10 条再自己挑余弦最大的那条，而 mem0 无论要几条都至少扫 60 行（`internalLimit = max(topK * 4, 60)`），所以这 10 条不多花任何检索成本。

## 记忆的更新与淘汰

**mem0 v3 从不淘汰记忆。** 新算法是 ADD-only（抽取 prompt 第一句就是 "Your sole operation is ADD"），`decay` 与 `timestamp`/`referenceDate` 在 OSS 版直接抛错（平台版专属），`scoreAndRank` 也没有时间衰减项——旧记忆不会因为旧而降权。后果是：当项目实情和已有记忆冲突时，两条并列存在，谁排前面取决于措辞而不是新旧。所以"让记忆保持正确"必须显式做，本层接了两个 mem0 已有但默认没暴露的能力：

| 手段 | 用什么 | 效果 |
| --- | --- | --- |
| 就地改正 | `memory_update`；`cli update <id> "新正文"` | 保留 id、`createdAt` 和它在注入列表里的位置，只刷新 `updatedAt`。删了重写这两样都会丢 |
| 设到期日 | `memory_update` 的 `expiresAt`；`cli add/update --expires` | 过期后 mem0 自己把它从 `search` 和 `getAll` 里滤掉，于是也不再进下一个会话的注入。这是本地唯一真正意义上的自动淘汰 |

**就地改正唯一销毁的东西是旧正文，所以要有地方能看回去。** mem0 每次 ADD / UPDATE / DELETE 都往历史库写一行、并且带着被替换掉的那段文本，但它自己从不读回来。`cli history <id>` 就是这个读口，给的是"怀疑上次 `memory_update` 把正文改坏了"这一种场合。三个决定：

- **只加 CLI，不加 MCP 工具。** MCP 工具的 schema 每个会话都要进上下文，而这是个排查动作、不是 AI 平时该做的事，为它常驻一份描述不划算。
- **id 照写入那套归属校验解析**，尽管这只是读。历史行只带 memory id、不带 `agent_id`，所以拿一个跨仓库搜到的 uuid 直接问 mem0，它会老实把别人家的变更行给你。
- **排序按 mem0 返回的行序（`ORDER BY id DESC`，新的在前），不按行里的日期。** 那两个日期不是"这行是什么时候写的"：`created_at` 是记忆自己的创建时间、每行都一样，`updated_at` 只有 UPDATE 行才有，DELETE 行两个都空。

一处盲区：换 `agent_id` 之前每个仓库一个历史库文件，那批记忆的变更行留在 `~/.mem0-local/history/` 里，当前的 `history.db` 里没有。命令会在查不到时说清行在哪儿，但不去读——那个布局已经废弃，而记忆 id 到旧文件名的对应关系恰恰会被一次 re-key 打断。删掉的记忆同理查不到：id 是按现存记忆解析的。

已知保质期的事实（量出来的耗时、依赖版本、等 bug 修好就没用的绕法）写入时就该带上到期日。**过期是可逆的**：`resolveMemoryId` 用 mem0 的 `showExpired` 把过期记录一并纳入，CLI 有 `list --expired`、MCP 有 `includeExpired`，`--clear-expiry` 清掉到期日。

**过期只是隐藏，所以还需要一次真删。** mem0 的到期只让记忆从 `search`/`getAll` 里消失，行还在文件里，而**过期的行不是惰性的**：`keywordSearch` 和实体检索都不看到期日，于是一条过期记忆命中 BM25 或实体就会抬高归一化分母，压低可见结果的分数（见[上游已知问题](#上游-mem0-的已知问题)）。所以有 `prune --expired`，和一个每月 1 号跑它的计划任务（`npm run install-sweeper`）。三个决定：

- **留 30 天反悔窗口**（`prune.expiredGraceDays`）。到期当天就删会把上面那句"过期是可逆的"悄悄作废——`list --expired` 还在，但已经没有东西可看了。删的是"过期已满 30 天"的，不是"已过期"的。
- **不挂在 watchdog 那次巡检上**。它每 2 小时跑一次，看着顺手，但 `test-health.mjs` 会真跑那条路的探活——让一个被测试驱动的路径带上删除权限，等于让一次跑测试就能动到真实记忆库。
- **反悔天数在清理时才读**，不写进任务参数（任务跑的是 `prune --expired --yes`，不带 `--days`），所以改配置不用重新注册任务。

清理跑在隐藏窗口里、一个月一次，所以它必须留痕：`last-sweep.json` 记下时间和删除条数，`doctor` 才分得清"扫过了，没有到期的"和"装上之后从没扫过"。同理 `doctor` 的 `expired memories` 那行会先说有几条被隐藏、其中几条已过反悔期——判断"过期"这件事是问 mem0 要的（普通列表丢掉、`showExpired` 又捞回来的那批就是），不是本层自己比日期。`test-cli.mjs` 守着反悔期的边界：昨天到期的不该被删、`--days 0` 才该被删、不加 `--yes` 一条都不动；而真删那一步只在"待删的正好只有测试自己那条"时才执行，否则宁可跳过——不然跑一次测试就可能带走你真正到期的记忆。

**短 id 就够用**：注入和 CLI 列表里每条只印 8 位（`(id: 1223f031)`），这是 AI 平时唯一能拿到的形式，所以 `memory_update` / `memory_delete` 接受任意长度前缀，撞车会报错并列出候选。

**写入一律限定在本仓库，完整 uuid 也不例外。** 读可以跨仓库（`scope: "all"`），而这恰恰是一个仓库拿到另一个仓库完整 uuid 的地方，所以 uuid 不被当作可信凭据，和短前缀走同一套归属校验，点到别人家的记忆会报出属主。否则跨仓库的读权限就等于对整个库的写权限。`test-retrieval.mjs` 有专门用例守着。

**一条记忆归哪个仓库，是写入时定的、之后改不了**：归属现在就是 mem0 的 `agent_id`，而 mem0 的 `update()` 会先 `stripIdentityKeys` 再合并，所以公开 API 根本改不动它（见[仓库标识就是 mem0 的 agent_id](#仓库标识就是-mem0-的-agent_id)）。换 remote 之后的重新归属因此是一次维护操作，不是一条 `update`。

## 第四路：重排

三路融合出来的分数有个结构性毛病：**它把相关和不相关挤在很窄的一段里**。实测本项目 60 多条记忆，融合分从 0.23 到 0.68，而 bge-small 对完全无关的英文句子就能给到 0.4–0.6，于是真正回答问题的那条会被两条只共用词汇的记忆压在后面。mem0 自带的第四步正是为此：`reranker` 是**交叉编码器**，把 query 和记忆正文拼在一起送进模型算相关性分，而不是比两个各自算好的向量。打分和排序全在 mem0 里，本层只负责选 provider、加宽候选集、把 `rerankScore` 透传出来。

同一个查询 `how does getAll ordering break pagination`：

| | 第 1 名 | 第 2 名 | 第 3 名 |
| --- | --- | --- | --- |
| 只融合三路 | 短 id 的约定（0.373） | 抽取 prompt 长度（0.342） | **getAll 截断的那条（0.325）** |
| 加上重排 | **getAll 截断的那条（0.146）** | 过期淘汰（2.8e-5） | Adapter 原则（1.6e-5） |

正确答案从第 3 名回到第 1 名，分差从"三条挤在 0.32–0.37"变成四个数量级。回归测试用一对故意对立的 fixture 守着：一条真答了"编译要用哪个脚本"，另一条只是反复出现 `build`——交叉编码器给前者 0.974、给后者 1.4e-5。

两个实现要点：**候选集要加宽**（mem0 只把它自己要返回的那批交给重排，所以按 `topK` 去要等于只在"本来就要返回的 6 条"里换顺序，最该救回来的那条已经被截掉了；本层要 `max(topK * 4, reranker.candidates)` 条，重排完再切。倍数是抄 mem0 自己的——它给融合打分的候选池就是 `max(topK * 4, 60)`——因为写成常数 25 的话，`topK` 一旦追上它，加宽就连同重排的意义一起悄悄消失了）；**失败是软的**（模型没下载、离线、库没装，mem0 内部 catch 掉并原样返回融合顺序，唯一能看出没生效的地方是 `doctor` 的 `reranker` 那行和结果里没有 `rerank=`）。

**候选集要多宽，量过一次。** `scripts/bench-candidates.mjs` 拿 12 个自然提问打真实记忆库（67 条），对每个提问比较候选池 6 / 25 / 60 / 全部时重排选出的第一名：

| 候选池 | 12 个提问里第一名不同的 | 每次搜索均值 |
| --- | --- | --- |
| 6（等于 `topK`） | 1 条被截在池外 | — |
| 25（当前默认） | 0 | 1448ms |
| 60 | 0 | 1735ms |
| 全部 67 | 0 | 1797ms |

那唯一一条的融合分排名是 **15/67**——池子 6 时它根本进不了重排，池子 25 就够了，再宽没有任何变化。同时这也回答了另一个担心：**原文写入的记忆没有实体行**（mem0 只在抽取路径上链接实体），第三路加权因此对它们不生效，但 12 个提问里有 9 个的第一名本来就是原文写入的 `memory_add` 记忆、融合分排名第 1——缺的那点加权并没有把它们埋掉，所以不必去给原文路径补实体链接。

这个结论跟库的规模有关：那条排在 22% 分位上，库大了同一分位就会掉到 25 名之后。所以记忆量明显增长后重跑一次这个脚本，"第一名不同的"回到非 0 就把 `reranker.candidates` 调宽——从 25 到 67 只多 350ms，不贵。

代价：`Xenova/ms-marco-MiniLM-L-6-v2` 约 87MB，首次搜索时下到 `~/.mem0-local/models/transformers`，之后每次搜索约 600ms（上表是同一进程里连续搜索、含嵌入与三路融合的端到端耗时，不可与这个数直接比）。不想要就 `reranker.enabled: false`。mem0 另外三个 provider 都不能用（`cohere`/`zero_entropy` 是 HTTP API，会把记忆正文发出本机；`llm_reranker` 每条记忆一次模型调用，本层的桥是 CLI，一次搜索要几十秒），填了它们会**降级成不重排**并在 `doctor` 里写明原因，而不是让一整层记忆失效。

⚠️ **两个原生 ONNX 运行时不能共存。** fastembed 钉 `onnxruntime-node@1.21.0`，`@huggingface/transformers` 钉 `1.24.3`，装成两份之后同一进程里先加载 fastembed 再加载重排模型会**直接把进程打死**——0xC0000005 访问违例，没有任何 JavaScript 异常，只有一个非零退出码。`package.json` 的 `overrides: { "onnxruntime-node": "1.24.3" }` 把两者压到同一份运行时上（已验证 fastembed 在 1.24.3 上照常工作，向量维度和分数不变）。升级这两个包中任何一个之后，务必重新确认这个 override 仍然成立。

## 失效告警

**这套系统坏掉的时候是不出声的。** MCP server 起不来，模型不会说"我没有记忆工具"，它只会像一个没有记忆的模型那样正常回答——这和"搜了但没搜到"在你眼里完全一样。等你发现，可能已经丢了两周本该被记住的东西。所以有两层主动告警，装一次之后不用管：

| 层 | 在哪儿跑 | 抓什么 | 你会看到 |
| --- | --- | --- | --- |
| 启动自检 | 每个会话的 MCP server 自己 | 服务起来了，但读不到记忆库 | 模型在第一句话里就告诉你"mem0-local 挂了"及原因 |
| 定时巡检 | Windows 计划任务，每 2 小时 + 每次登录后 2 分钟 | 服务**根本起不来** | 系统通知弹窗 + `doctor` 里的结论 |

**巡检不看心跳，而是按 IDE 的方式真起一次 MCP server**、完成一次真实握手、看工具和记忆注入在不在（约 300ms，理由在 `src/watchdog.mjs` 开头）。用哪个 node 去起是关键：要抓的失效恰恰是"IDE 或 agent 升级把运行时换掉了"，所以它会扫出所有 JetBrains 自带的 agent 运行时逐个探活。顺带的好处是**IDE 一发新版 agent，下一次巡检就替你试过了**：

```
probe CLion2026.2 / cursor 2026.07.23: ok in 291ms
probe Rider2026.2 / cursor 2026.07.23: ok in 295ms
probe system node: ok in 345ms
```

**这里到底怕什么。** `~/.cursor/mcp.json` 里写的是裸命令 `node`，谁在 PATH 前面就用谁；而 `better_sqlite3.node` 是按 V8 ABI 编译的原生模块（不是 N-API），运行时的 ABI 号是硬约束：

| 运行时 | 版本 | ABI |
| --- | --- | --- |
| CLion 自带（当前解析到的） | v24.5.0 | 137 |
| 系统安装的 | v24.12.0 | 137 |

现在两边同一个 ABI 所以没事。哪天 agent 带上 node 26，MCP server 会在 import 阶段直接崩，一行工具错误都产生不了——这正是 `heartbeat.json` 里记 `abi` 的原因。

**重启之后不需要做任何事**，两层都是自启的：MCP server 不是常驻服务，IDE 每开一个会话就按 `mcp.json` 起一个进程，用完就退；定时巡检由 Windows 拉起，登录后 2 分钟先查一次。任务用 `wscript` 启动，不会每隔两小时闪一个黑窗口（那是监控被卸载的最快方式），跑在 IDE 之外的独立 node 上，找不到时安装脚本会明确警告。它是**用 XML 注册**而不是 `schtasks` 的命令行开关，因为后者有三个对监控来说是错的默认值（电池、错过的那次直接丢、没有登录触发器——而开机后恰恰是升级刚落地的时刻），细节在 `scripts/install-watchdog.mjs`。同一个问题在 `watchdog.repeatHours`（默认 12 小时）内只弹一次，因为**第二次为同一个已知问题弹窗，正是训练你忽略第一次的东西**。`doctor` 里对应这几行：

```
last session        3m ago  local-memory-65aa6c28  store ok
  ran on            v24.5.0 (ABI 137) via CLion2026.2 / cursor 2026.07.23
watchdog            all 3 runtime(s) ok 0m ago; scheduled task registered
```

`scripts/test-health.mjs` 有 23 条断言（指纹、ABI 变更识别、心跳往返、抑制窗口、真实探活、探一个起不了服务的可执行文件）。端到端则是真把 `src/mcp-server.mjs` 改名之后跑巡检：两个运行时同时报失败、错误信息准确指到 `Cannot find module`、系统通知实际弹出、第二次运行被抑制、文件还原后恢复。加 `--notify` 可以让测试真弹一条通知。

**还没覆盖的一种失效**：cursor-agent 哪天不再把 MCP 的 `instructions` 转发给模型。那时工具还在、巡检全绿、`doctor` 全绿，只有注入悄悄没了——因为这是实测出来的行为而非有契约的 API，纯本地探活看不见。要抓它得起一个真实 ACP 会话、埋一个随机串让模型复述，尚未固化成命令。

## 与 mem0 的边界

本目录是**纯接入层**：不修改上游任何文件，不 monkeypatch，不访问 mem0 的私有字段，只通过公开 API 和官方扩展点接入。**唯一的例外是 `src/payload-store.mjs`**，它直接改 mem0 存下来的 payload，只为了重写归属键——原因和边界见[仓库标识就是 mem0 的 agent_id](#仓库标识就是-mem0-的-agent_id)。

**只调用这些公开 API**：`new Memory(config)`、`memory.add()`、`memory.search()`、`memory.getAll()`、`memory.get()`、`memory.update()`、`memory.delete()`、`memory.history()`。所有配置项（`embedder` / `vectorStore` / `historyStore` / `infer` / `filters` / `metadata` / `showExpired` / `expirationDate`）都是 `MemoryConfig`、`AddMemoryOptions` 与 `UpdateMemoryOptions` 里公开声明的字段。

**通过官方扩展点接入**，而不是改代码：

| 接入点 | 用法 |
| --- | --- |
| `embedder.provider = "langchain"` | mem0 只要求传入对象有 `embedQuery` / `embedDocuments`，于是本地 fastembed 包装成这个形状。逻辑与 mem0 内置的 `FastEmbedEmbedder` 等价，唯一区别是显式指定了模型缓存目录（内置实现会下载到当前工作目录） |
| `llm.provider = "langchain"` | mem0 为"自定义模型"留的注入点：只要求有 `invoke()` 且返回值带字符串 `content`。本层的 CLI 桥就是这个形状，并**故意不实现** `withStructuredOutput` / `bindTools`——那样 mem0 会走它自己的纯文本分支，用自带的 `extractJson` 解析 |
| `vectorStore.provider = "memory"` | 这就是 mem0 自带的 SQLite 向量库实现，没有替换 |
| `historyStore.provider = "sqlite"` | mem0 自带的历史库，只改了文件路径（`~/.mem0-local/history.db`）。一个文件够了：它同时存变更日志和 mem0 回放的 `## Last k Messages`，而后者的 key 里就带着 `agent_id`，仓库之间从构造上互不可见 |
| `customInstructions` | `MemoryConfig` 的公开字段，mem0 会作为 `## Custom Instructions` 拼进抽取 prompt 并声明为最高优先级。本层只用它要求"写成英文、话题前置、标识符原样保留" |

**抽取与写入完全走 mem0 自己的流程**：prompt 模板、few-shot、与已有记忆的去重判断、条目 id、内容 hash、`createdAt`、BM25 用的 `textLemmatized`、历史记录，全部由 mem0 生成。本层只做两件事：把 messages 拼成 CLI 能接受的单段 prompt，把回来的**原始文本**交还给 mem0 解析——不做任何裁剪，因为 mem0 的 `extractJson` 是个能识别字符串转义的括号匹配器，比"截取第一个 `{` 到最后一个 `}`"稳。本层只判断一件事：回复里**根本没有** JSON 时视为失败，从而触发原文回落，而不是让这条记忆无声无息地不见。

**输出契约完整生效**：mem0 用严格 schema 校验模型回复（每条要求字符串 `id` 和 `text`，可选 `attributed_to` / `linked_memory_ids`），失败才退到宽松解析。实测真实模型经过本层的 prompt 拼装后走的是严格分支，`attributedTo` 也已透传到 CLI 与 MCP 的返回里。

**本层只额外附加 4 个 metadata 键**（`project_name` / `kind` / `source` / `source_hash`），均不与 mem0 的保留键（`data`/`hash`/`createdAt`/`updatedAt`/`textLemmatized`/`user_id`/`agent_id`/`run_id`/`expiration_date`）重名。已确认 `infer: true` 路径下这些键同样完整落库，所以开模型不会破坏项目隔离。`project_name` 只用于显示——每个 clone 的目录名都一样，它不是能用来分仓库的东西。

### 仓库标识就是 mem0 的 agent_id

**仓库归属不是本层自己的字段，就是 mem0 的 `agent_id`。**（写入时由 `filters` 带进去，mem0 自己抄到 payload 上；读取时 `scopeFilters` 只传 `{ user_id, agent_id }`。）早先它是本层自己加的一个 `project` metadata 键，能用，但**只在向量过滤这一处能用**——mem0 有三处按作用域工作的机制，都只认它自己的身份键：

| mem0 的机制 | 作用域取自 | 用 metadata 键时只能这样绕 |
| --- | --- | --- |
| `vectorStore` 过滤（`search` / `getAll`） | 任意 payload 键 | 本来就能用 |
| 实体索引（第三路加权的来源） | `user_id` / `agent_id` / `run_id` | 绕不过去，只能靠"候选集已被过滤"让加分落不到实处 |
| `## Last k Messages` 的 `sessionScope` | 同上，`buildSessionScope` 只读这三个 | 每个仓库一个历史库文件 |

换成 `agent_id` 之后这三处一起对齐：实体索引按仓库分行、消息回放按仓库分 key，于是**每仓库一个 mem0 实例、每仓库一个历史库文件都不再需要**，`openMemory()` 收成一个实例，历史库回到一个 `history.db`。

代价是明确的，也是接受了的：

- **没有"全局记忆"了。** `agent_id` 是身份键，一次查询只接受一个值（`validateAndTrimEntityId` 不收数组），所以"本仓库 + 全局"这种一次读两个作用域的写法没法表达。硬要做只能一次搜索发两次、再把两批结果拼起来——而融合分不可跨查询比较，拼出来的顺序是假的。`--global` / `--scope global` 因此一并删掉。
- **归属写入即固定。** mem0 的 `update()` 对传入 metadata 先跑 `stripIdentityKeys`，身份键根本进不去。所以换 remote 之后的重新归属没有公开 API 可用，`delete` + 重新 `add` 又会丢 id 和 `createdAt`（注入列表和短 id 都是按它们寻址的）。
- **于是有了一个例外文件。** `src/payload-store.mjs` 是全项目唯一直接读写 mem0 那两个 SQLite 文件的地方，规则收得很窄：只重写归属键，从不新建记忆、不碰向量、不在正常运行时执行——只由两个维护脚本按需调用，且先自动备份（备份前先 `wal_checkpoint`，否则复制出来的快照会缺掉还在 `-wal` 里的行）。
- **实体行要跟着搬。** 一行实体记的是"这个实体关联了哪些 memory id"，按仓库分行之后，一行只能属于一个仓库；如果它关联的记忆分属多个仓库，就得按仓库**拆成多行**（复用已存的向量，所以不需要嵌入模型，结果和 mem0 自己写出来的一样）。漏掉这步的后果是安静的：实体行留在原处，第三路加权要么消失、要么加到别的仓库的搜索上。

两个脚本共用这一个入口：`migrate-to-agent-scope.mjs` 把老的 `project` 键搬进 `agent_id`（幂等，默认只报告），`rekey-project.mjs` 处理换 remote 之后的改标识。`resolveProject` 也随之把标识里的空白折成 `-`：`agent_id` 不许带空格，而目录名带空格是完全可能的。

### 和 mem0 默认值不一样的三处

逻辑一律照 mem0 的走，但有三个**默认值**是本层自己定的。列在这里，因为它们决定了你实际看到多少记忆，而每一处都有一行配置可以调回 mem0 的原值：

| 这一处 | mem0 的默认 | 本层的默认 | 为什么 |
| --- | --- | --- | --- |
| 一次搜索返回几条（`search.topK`） | 20 | 6 | mem0 的 20 是给"只有融合分、分不开相关与否"的默认配置定的；本层每次搜索都跑交叉编码器，而它的判决极陡（0.15 对 1e-5），第一名之后基本是让 AI 白读的填充。想要 mem0 的行为就把它设成 20 |
| 手动写入是否走抽取（`infer`） | `add()` 默认 `true` | `memory_add` / `cli add` 默认原文直存 | AI 写下的本来就是一条干净事实，再过一遍模型只多花 15 秒和一次配额，还可能被改写。需要时按次开：`distil: true` / `--infer`。自动捕获的 prompt 相反，默认全走抽取 |
| 列表类读取要几条 | `getAll` 默认 20 | 整个集合，排序和截断自己做 | 不是偏好，是绕开上游的 bug：`vectorStore.list` 没有 `ORDER BY`，任何小于集合规模的 `topK` 截到的都是最旧那批（见[上游已知问题](#上游-mem0-的已知问题)） |

`search.threshold` 不在表里：本层默认不传，用的就是 mem0 自己的 0.1。

**`topK` 是上限，不是配额。** mem0 按融合分排序后 `slice(0, topK)`，所以真正返回的是"过了阈值的条数"与 `topK` 里的较小值；命中少的查询就返回得少。想要更宽的召回只该调 `topK`，不该调 `threshold`——那道门槛只卡原始语义分且不可跨查询比较（同上表）。

### 提示词：只补 mem0 没说的

本层一共 4 处提示词文本，读者不是同一个：`llm.customInstructions`（`src/config.mjs`，抽取模型读）、`MEMORY_PROTOCOL`（`src/injection.mjs`，和你对话的 AI 读）、6 个工具及参数的 `description`（`src/tools.mjs`，同上）、`# Response rules`（`src/llm.mjs` 的 `buildPrompt`，抽取模型读）。

**共用的句子只写一遍，放 `src/wording.mjs`。** 给 AI 的那两处要重述 mem0 的同一份约定，重述两遍就会各自漂移——实际发生过：两处只引了 `15-80 words` 而丢了优先级规则，`memory_update` 还比 mem0 少允许两句。所以长度规则、拆分出路、英文与标识符这四条句子是常量，由协议文本和工具 schema 组合，`memory_update` 则只**指向** `memory_add`（指向是唯一不可能漂移的形式）。给抽取模型的那两处**刻意不引用**这些常量：它们是追加在 mem0 提示词后面的，mem0 已经说过的话在那里只该出现一次——在 mem0 自己那份里。

**工具 schema 从 `mcp-server.mjs` 拆到了 `src/tools.mjs`。** 它们是提示词而不是代码：ACP 通道里 AI 看到的一半就是这些 description，而 `mcp-server.mjs` 顶层有 `await server.connect()`，导入即起服务，测试没法读。拆开之后服务器只剩管线，文本可以无副作用导入。

### 提示词漂移只能被检测，不能被消除

**mem0 不导出它的提示词。** `mem0ai/oss` 的公开导出里没有任何 prompt 常量（`ADDITIVE_EXTRACTION_PROMPT` 只在包内部用），所以"运行时直接引用上游原文"这条路是关着的。就算开着也不该走：mem0 那段文字的读者是**抽取器**，示例是 `Bad: "User has a dog"` 这种以 User 为主语的对话挖掘场景，直接贴进工具描述会把不相干的语境一起带进来；而整段 prompt 约 34000 字符，注入进每个会话的 instructions 里也是不可接受的开销。

能做的是**检测**：提示词文本确实随包发布（`dist/oss/index.mjs`，590KB），`scripts/test-prompts.mjs` 用 `import.meta.resolve` 找到这个文件读原文，断言两类事情——

| 断言 | 失效时会怎样 |
| --- | --- |
| 本层重述的 8 条上游说法逐字还在（`15-80 words`、`up to 100 for detail-rich content`、`completeness beats brevity`、`up to 3 for content with multiple proper nouns`、`split into multiple focused memories`、`### Self-Contained`、`Your sole operation is ADD`、`## Custom Instructions`） | mem0 改了约定而本层还在照旧宣讲，AI 按一份过期契约写记忆 |
| mem0 仍然**不**规定语言（`SAME LANGUAGE` / `detect the language` / `Language Requirement` / `in the same language` 都不出现） | 英文策略从"唯一的语言指令"变成"和系统提示对着干"，需要重新评估而不是继续加大声量 |
| 四处 AI 可见文本确实由 `wording.mjs` 的常量组合而成，且 `customInstructions` 没把长度规则抄回给 mem0 | 本层内部又漂移了 |

读一个依赖的构建产物是刻意的，且只出现在这一个文件里：如果哪天读不到或提示词换了位置，这个测试会大声失败——那正是想要的结果。运行时没有任何地方这么做。免费、确定、毫秒级：`npm run test:prompts`。

**给抽取模型的那两处，只写 mem0 自己没写的。** mem0 的抽取 prompt 已经要求"self-contained factual statement（15–80 词）"、已经在 `## Existing Memories` 里管好了去重与关联、也已经要求只输出 JSON，所以 `customInstructions` 只补两件上游确实没提的：写成英文、话题前置。另外两处重复是必要的，不是遗漏：

- **标识符原样保留**——mem0 的 `### Preserve Specific Details` 讲的就是这件事，但那一段的前提是记忆保持输入语言，所以它没有、也不需要把标识符从"翻译"里豁免出去；一旦强制翻译，这个豁免就得自己写。
- **`# Response rules` 那一行**——mem0 靠 `response_format: json_object` 保证纯 JSON，而 Cursor CLI 不认这个参数。

**写英文是刻意反着来的，而且它没被上游压住只是因为一处移植缺口。** mem0 的 Python 提示词一律要求"record the facts in the same language"，`use_input_language` 段更把翻译成英文标为 `CRITICAL` 要避免。本层反过来（理由是 92% 对 75% 的命中率，见 `embedder.model`），能成立是因为 **mem0 的 TS 移植没有 `useInputLanguage` 这个入参**（`generateAdditiveExtractionPrompt` 只收 5 个字段），抽取提示词本体也不含任何语言规则——于是模型看到的唯一语言指令就是本层的，且落在 mem0 自己标为最高优先级的 `## Custom Instructions` 槽里。抽取路径若改走 Python SDK，或上游把这一段补回 TS，两者就会正面冲突。

**给 AI 的那两处相反，必须把 mem0 的质量约定重讲一遍，而且要讲完整。** 默认写入路径是原文直存（`distil: false`），**根本不经过 mem0 的抽取 prompt**，AI 写下的那句话就是最终入库的记忆。所以长度约定得由工具描述和协议文本来承担——**连同它的优先级**：mem0 的原文是"15–80 词，detail-rich 可到 100"、"1–2 句，标识符/数量多时可到 3 句"、"completeness beats brevity，绝不为凑字数丢掉专名、日期或具体数字"、以及"一个话题装不下就拆成多条记忆"。早先这里只引了括号里的词数，把目标写成了硬上限，而本 store 里质量最高的几条（如 63 词 3 句、带 5 个数字的实测记录）本来就在被丢掉的那部分里。拆分这条出路还必须落成"再调一次 `memory_add`"，因为一次调用只存一条记忆，别处没有任何地方说过这件事。store 挂掉时不发协议，换成一句"修好之前不要调这些工具"。

### 抽取上下文的作用域

mem0 判断"哪些是新事实"的依据不只是你这次的输入，还有它自己捞出来的两份上下文，都拼进抽取 prompt，而它们默认**都不按仓库隔离**：

| mem0 的来源 | 默认作用域 | 不处理会怎样 | 本层怎么做 |
| --- | --- | --- | --- |
| `## Existing Memories` | 只按 `user_id` | 另一个仓库有条等价记忆，模型就判"已经记过了"，本仓库这条事实**永远不会写入** | 写入时也把仓库过滤传给 mem0 的 `filters`，和检索用的是同一套 |
| `## Last k Messages` | `sessionScope`，由 `user_id`/`agent_id`/`run_id` 拼成 | 别的仓库的 prompt 会作为"最近对话"进入本仓库的抽取上下文 | 仓库标识就是 `agent_id`，于是它自动进了这个 key——同一个历史库文件里，两个仓库的消息互相看不见 |

mem0 的抽取 prompt 一共声明了 5 份上下文，剩下两份在 TS 移植里**恒为空**：`## Summary` 写死 `""`，`## Recently Extracted Memories` 写死 `[]`（`prompts/index.ts:837,844`，`generateAdditiveExtractionPrompt` 根本不收这两个入参）。而提示词把后者称作 "your primary deduplication reference"。**于是 `distil` 路径的去重全压在 `## Existing Memories` 一路上**——以整个 turn 为查询、融合分前 10、作用域已由本层收窄。本层自己的近重复检查（0.92 余弦）在这条路上是故意不跑的（`addMemory` 里 `dedupe && !wantInfer`），因为比事实比措辞准。代价是：一个多话题的 turn 里，某条事实的邻居可能挤不进那 10 行，于是跨 session 写出第二份。症状可辨认——`memory_list` 里两条近乎同义、`source_hash` 不同的记录。没有绕法，mem0 的 TS `Memory` 不接受这两份上下文；补一道事后去重要先写入再删除，不值得。

**`AGENT_CONTEXT_SUFFIX` 永远不触发，靠的是 `user_id` 无条件传。** mem0 的判定是 `agent_id` 有而 `user_id` 无（`memory/index.ts:897`），命中就把 `## Entity Context` 追加到系统提示，让每条事实改写成"Agent was informed that ..."。仓库标识走的正是 `agent_id`，所以"既然仓库已经能隔离，`user_id` 是不是多余的"这个看起来无害的简化，会静默改掉整个 store 的人称，还会在每条记忆前加一段恒定前缀、把本层要求的话题前置顶掉。`test-llm.mjs` 对此有一条断言。

前两条都有确定性回归测试：`scripts/test-llm.mjs` 用桩模型录下 mem0 真正构造的 prompt，断言另一个仓库的记忆和消息都不在里面。**两个仓库共用同一个 `Memory` 实例**跑这两个断言，这样测的就是 `agent_id` 本身在隔离，而不是"两个实例各写各的文件"。不花钱、不依赖模型发挥。

v3.1.6 的 `escapeScopeValue`（上游 #6892）把 `sessionScope` 里的 `%&=` 转义掉，避免不同的身份键拼出同一个 key；仓库标识走 `agent_id` 之后，本层正好落在它保护的范围内（`/` 不需要转义，空白由 `resolveProject` 提前折掉）。

仓库过滤一律**下推给 mem0 的 `filters`**，在存储层生效而不是取回后再筛——否则 top-k 截断会让其他仓库的记忆挤掉本仓库的命中。

### 检索的三路信号

mem0 v3 的检索是三路并行打分后融合的，本层没有替换其中任何一路。实测（`test-retrieval.mjs` 打印的 `score_details`，中文记忆里带一个 `10.BuildPC.bat` 这样的标识符）：

| 查询 | semantic | bm25 | entity | 归一化分母 |
| --- | --- | --- | --- | --- |
| `10.BuildPC.bat 怎么用` | 0.859 | 0.238 | 0.451 | 2.5 |
| `构建这个项目有什么规定`（纯中文） | 0.620 | 0 | 0 | 1.0 |

两点是 mem0 自身的设计，不是本层的缺陷，但用中文时值得知道：**BM25 与实体抽取都是 ASCII 驱动的**（`lemmatizeForBm25` 只取 `[a-z0-9]+`，实体抽取认引号内容、大写专名和代码标识符），这也是选英文存储的附带理由；**缺信号不会压低分数，但分数也因此不能跨查询比**（归一化分母按"这次实际有哪几路"动态计算，上表 2.5 与 1.0；同一次查询内部除的是同一个数，排序仍然对）。

**实体链接只发生在抽取路径**（以及改正文的时候）：

| 写入方式 | 可用信号 |
| --- | --- |
| 后台自动捕获的 prompt（默认全部走抽取） | 语义 + BM25 + 实体 |
| AI 调 `memory_add`、CLI `add`（默认原文存储） | 语义 + BM25 |
| 上面两种再加 `distil: true` / `--infer` | 语义 + BM25 + 实体 |

还有一条不太直觉的：**改过正文的记忆会凭空多出实体信号**。mem0 的 `updateMemory` 在文本变化时会调 `_linkEntitiesForMemory`，而 `createMemory` 不会。实测同一条记忆原文写入后实体表 0 行，`update` 改完正文变 4 行，删除后回到 0 行——于是两条正文完全相同的记忆，改过的那条有实体加权。没去追平它：mem0 没提供"给已有记忆补建实体"的公开入口，而且抽出来的实体质量本就有限（那次抽到的是 `verifyProbeHelper.mjs`、`helper lives in`、`mjs and is called`、`every night`，只有第一个是真实体）。

**实体索引按仓库分行**：mem0 的实体查找也按 `user_id`/`agent_id` 过滤，而仓库标识就是 `agent_id`，所以同一个标识符出现在两个仓库里会各有一行实体，去重也只在仓库内部发生。两层保险：加分只落在候选集里的 memory id 上，而候选集本身已被同一个过滤器限定。测试里有专门用例守着（两个仓库写同一个 `10.BuildPC.bat`，断言彼此看不见、且各自的实体加权照常生效）。

**关掉模型时**（`llm.enabled: false` 或 `MEM0_LOCAL_NO_LLM=1`）整条链路无需任何模型服务即可离线运行，代价是不启用事实抽取、实体库也不会被写入。这是配置选择，不是功能被破坏。

### 上游 mem0 的已知问题

通读 mem0 v3.1.6 OSS 的增删改查全链路后记下来的。这些都在上游，本层没有绕过；列在这里是为了别把它们当成本层的 bug，也为了将来升级时知道该回头看什么。

| 问题 | 影响 |
| --- | --- |
| 抽取是纯 ADD，没有更新与淘汰 | 冲突事实并存，靠 `memory_update` 人工纠正 |
| decay / 时间衰减是平台版专属，OSS 显式抛错 | 排序里没有任何时间项，旧记忆不会自然沉底 |
| 原文写入不建实体索引，改正文却会建 | 实体加权对大多数记忆是死的，且编辑过的记忆行为不同 |
| 最终分数不能跨查询比较 | 归一化分母随本次候选集里出现了哪几路信号而变 |
| 模型产出的 `linked_memory_ids` 被丢弃 | 抽取 schema 里声明了这个字段，OSS 实现不落库，记忆之间的关联拿不到 |
| 隐身的记忆能改变可见记忆的分数 | `keywordSearch` 与实体检索都不看到期日（前者连身份键之外的过滤都不做减法：它照 `filters` 过滤，但过期与否不在其中）。于是一条已过期的记忆命中 BM25 或实体，就会把分母抬高，哪怕没有任何可见结果真的拿到那份加分。不泄露内容，只污染分值 |
| 默认 `threshold: 0.1` 基本不起作用 | 它只作用于原始语义分，而 bge-small 对完全无关的英文句子普遍给到 0.4–0.6，所以 `memory_search` 几乎总是返回满 topK。调高它并不能解决（分母不可比），真正把相关的顶上来的是重排 |
| BM25 对中文完全失效 | `lemmatizeForBm25` 遇到不含 ASCII 的文本会直接返回整串原文，而分词按空白切，中文没有空格，整句变成一个 token，永不命中 |
| 每次读都是全表扫描 | `search` / `list` / `keywordSearch` 都是 `SELECT * FROM vectors` 再逐行 JSON.parse。万级以内无感 |
| `vectorStore.list` 没有 `ORDER BY`，而 `getAll` 用 `slice(0, topK)` 截断 | 全表扫描按插入顺序返回，所以任何小于集合规模的 `topK` 截到的都是**最旧**的那批。本层所有读取因此一律向 mem0 要整个集合，排序和截断自己做——否则注入会停在旧记忆上、判重看不见新记忆、短 id 也解析不到新记忆，而且全程不报错 |

**本层对 mem0 运行时的 4 处外部影响**（均不改变其逻辑）：

1. `console.log/info/debug` 在本层进程内重定向到 stderr —— MCP 用 stdout 传 JSON-RPC。日志不丢，去 stderr（Cursor 的 MCP 输出面板可见）
2. 对 mem0 的 SQLite 文件设置 `journal_mode = WAL` —— 正常运行时唯一**不经 mem0 的 API 直接碰它的文件**的地方：`setWal()` 自己开一个 `better-sqlite3` 句柄，只为发一条 pragma，且必须发生在 mem0 打开该文件之前（换 journal mode 需要排他锁）。mem0 没有公开设置 journal mode 的入口，而 pragma 存在文件里、与表结构无关，所以这条越界的代价是"升级后要确认文件路径没变"，不是"升级后行为会变"。整个函数 best-effort，失败只写日志。（另一处是 `src/payload-store.mjs`，只在维护脚本里跑，见[上文](#仓库标识就是-mem0-的-agent_id)）
3. `MEM0_TELEMETRY=false` —— mem0 的遥测与 notice 机制在此开关下直接返回，不产生任何外发请求
4. 把 `@huggingface/transformers` 的 `env.cacheDir` 指到 `~/.mem0-local/models/transformers` —— 这是那个库自己的配置方式（mem0 只是 `await import()` 它，拿到同一个模块实例）。默认目录在它自己的包目录里，会被下一次 `npm install` 抹掉
