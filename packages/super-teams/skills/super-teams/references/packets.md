# 最小任务包与结构化结果

派发、恢复、变更或提交结构化结果时读取；参数以当前工具 schema 为准。概览与变更影响回执需要已加载 0.3 工具，结构化结果需要 0.2 以上。数据库只保存引用与声明，不自动读取外部文件、创建代理、判断质量或测量模型用量。

## 母体派发

用 create/edit 的可选 `context` 保存：

```json
{"inputs":[{"ref":"work/input.md","version":"sha-or-version"}],"constraints":["保留现有数据"],"skills":["superagent-workflow"]}
```

缺省为空 context，旧任务仍可读。inputs 最多 12 项，constraints/skills 各最多 16 项；ref 及约束/技能字符串最多 2000 字符，version 最多 200。引用必须可定位并说明版本，不把全段历史、完整日志或全部技能正文放进包里。

0.7 新建需要多项验收的任务时，将可观察条件写入 create/edit 的 `criteria:[{id,description}]`，与自由文本 `acceptance` 配合使用。最多12项，id唯一且最多200字符，description最多2000字符；保持ID稳定以便定位漏项。packet与claim回包保留这些条件。旧任务缺省 `criteria=[]`，仍沿用旧验收方式；不要为迁移而重做已完成任务。

`teams_task_packet(workspace, team_id, task_id)` 是只读接口，返回当前职责、写入范围、context、验收、状态、`task_version`、依赖的简要成果及回包要求，也包含本任务已有 checkpoint/result 短摘要和 `runtime_observation`。恢复时保留已做工作、待验产物和下一步，再按需打开证据；任务包不是空白重做指令，也不证明代理仍在运行。主线补足本轮最新授权、纠正、项目外文件责任和回报对象；依赖未满足时先处理阻塞，不重复派发。

0.6 的 `teams_task_update action=claim` 首次成功回执直接包含 `packet`，内容等价同一状态下的完整 `teams_task_packet`；复用该包，不再额外读取。`replayed=true` 时 packet 保留原请求的历史快照，必须刷新当前包；旧版回执缺 packet 时也用 `teams_task_packet` 回退读取。其他 mutation 继续返回紧凑回执，不据此假设都带包。

宿主支持且允许时，以原生 `subagent` 显式发送这份最小输入；保存真实代理 ID，认领后核对当前 packet。任务按独立交付或完整能力闭环分配，决定路线的能力验证先于依赖它的实现；独立任务可并行推进。子任务按 SuperAgent 方法执行、自检，仅按需读相关技能和引用文件。用户要求母体只验收时，包内明确执行者承担调查、修复和验证，需母体决策或宿主专属动作时才请求具体协助，不逐命令转交。无法直接调用任务板工具时由母体中转 packet 与结果；不能把数据库记录当成代理启动回执。

## 子任务回包

`teams_submit_result` 使用以下字段：

| 字段 | 要求 |
| --- | --- |
| workspace / team_id / task_id | 真实项目绝对路径与板内 ID |
| expected_revision / request_id | 当前团队 revision、该逻辑写入的唯一请求 ID |
| task_version | 执行所依据的当前任务版本，旧数据默认 1 |
| outcome | `ready`、`blocked` 或 `failed` |
| summary | 最多 1200 字符，保留决定性结果与缺口 |
| artifacts | `[{ref,version}]`，可定位的产物及版本 |
| checks | `[{name,status,evidence,criterion_ids?,artifacts?}]`；status 为 `passed/failed/not_run`，evidence 指向实际证据并简述观察；0.7映射见下文 |
| review | `self` 或 `independent`；独立审阅不等于独立运行测试 |
| risks | 显式数组，无已知风险时为空数组，不省略已知局限 |
| next / error | 非 ready 必须有可执行 next；failed 另须最小错误 error |
| usage（可选） | 有真实数据才提交，见下文 |

artifacts/checks/risks 各最多 12 项；name/version 最多 200 字符，ref/evidence/单条风险/next/error 最多 2000。所有所列 checks 都按必需检查处理，不能另加 schema 未提供的 required 字段。

`ready` 至少有一个产物、一个检查，且所列检查全部通过；未执行的必需验收不能声明就绪。服务端只校验结构与声明，母体仍须核验原证据。同一里程碑直接提交结构化结果，无须先重复 checkpoint；成功保存为当前 result，并映射到 ready 或 blocked 检查点，不自动 `complete`；failed 保留失败 outcome。

有 `criteria` 的任务还须逐项覆盖：每个ID至少出现在一条 `passed` 检查的 `criterion_ids` 中，该检查的 `artifacts:[{ref,version}]` 至少关联一个本次 `result.artifacts` 中完全相同的产物引用与版本。一条检查可覆盖多个条件，一个条件也可有多条检查；写真实对应关系，不把全部ID随意挂到任意通过项。未知或重复ID、错误产物引用/版本始终拒绝；blocked/failed可以缺覆盖，但须保留next。结果的 `coverage:{required,passed,missing,missing_ids}` 报告缺项，摘要同样可见。旧任务可省略映射，显式提供时仍校验引用。

例如条件 `{"id":"recovery","description":"超时后核对已有产物，不重复副作用"}`，对应检查可为 `{"name":"timeout recovery","status":"passed","evidence":"work/recovery.log: runs=1","criterion_ids":["recovery"],"artifacts":[{"ref":"recover.mjs","version":"sha256:..."}]}`，外层artifacts须含同一引用和版本。这里的哈希及证据仍是调用者声明，服务端不会自动打开文件验证。

原始日志与媒体完整保存在任务目录；summary、checks 和 error 只放必要事实、证据引用与最小错误片段，不回传完整日志，不截断或覆盖原证据来满足摘要长度。证据、风险与 error 不自动去除首尾空白；选取的最小错误片段按原文保留。超过长度时重写摘要，保留风险和失败信息。

## 版本、冲突与兼容

编辑任务、release 或 reopen 会清空旧结果并递增 `task_version`，须读取新包并重新验收；无关任务造成的团队 revision 变化不会改变本任务版本。上游 task_update/submit 改变状态或成果时，pending 后代（直接及传递依赖）的版本也会递增并清除旧结果，须读取新包，避免沿用旧依赖成果。过期任务包的结果不能覆盖新要求或新负责人结果。

`STALE_REVISION` 后重新读板，只修订本次逻辑写入并换新 request ID。断流时完全相同参数使用原 request ID 重试；重放回执可能保留旧 revision，后续操作先读当前板。不重复执行已完成的文件或外部动作。

任务变更回执的 `affected_tasks` 列出受影响任务的当前版本、owner、原因和下一步。母体据此用原生消息工具向实际负责人发出纠正，传递新要求并要求重取 packet；`notification_required` 是待通知标记，工具本身不发送消息。没有实际发送就保留待通知，不声称已同步。上游有 active/completed 后代时仍遵守服务端保护，先协调停写或显式重开，不为修改上游绕过保护。

`teams_task_update action=checkpoint` 给定 `task_version` 时必须匹配当前版本；省略仅兼容仍为版本 1 的旧任务，版本大于 1 必须传入。旧包不能通过省略字段提交，complete 也核对检查点版本。新写检查点会清除旧结构化 result。缺少新增接口的旧会话只使用实际能力，不能冒称结构化提交或混用检查点绕过保护；必要时由主线当前可用的官方 SDK 入口验证，不另起模型调度器。

0.7有criteria的任务不能用旧式 `checkpoint outcome=ready`；须提交覆盖完整的结构化结果，complete再按当前条件、检查和产物重新计算覆盖，不信任保存的coverage计数。修改criteria和其他任务编辑一样使旧版本结果失效。progress/blocked检查点仍可用。工具schema没有criteria时，不往旧服务写新协议，也不删条件绕过；先使用已核验的新入口或明确保留未验状态。

## 母体先摘要、再按需详情

恢复或巡查先用 `teams_read view=overview`：全板 `counts`/`overview_counts` 不受当前页影响；任务行按关注优先分页，提供结论、next/error/risks、实际未完成依赖、证据与检查计数、观察时效及 `next_action`。计数可能交叠，不将各关注分类相加当成任务总数。有 `next_cursor` 时按需续页，不能把首屏当成全部任务。

`next_action` 是建议：显式暂停优先等待用户恢复；未知或过期观察先核实原生状态；fresh running 仅在复查期内支持等待，到期仍须排查；inactive 负责人先审查成果和停写情况，不能直接改派。`accept_result` 表示母体应验收，阻塞/失败按证据处理，依赖未完先等依赖，可派发任务才进入认领与原生派发流程。观察的新鲜度与最后真实进展的时间分别看；送达指令不证明已按新要求执行。具体原生接线见 [Harness 接线](deepseek-harness.md)。

先用 `teams_read view=results` 获取 summary、产物、评审、风险、next/error、检查计数、用量来源及可测结果体量；此视图的 result.checks 是计数，省略完整检查证据。只有旧式检查点的任务以 `legacy_checkpoint:{outcome,summary,next,evidence_available}` 保留旧阻塞摘要，`result=null` 明确表示没有结构化结果。需要核验时用默认 status 视图的 `teams_read task_id=...`，result.checks 才是检查数组，再打开相关产物和原证据。只在当前版本满足验收后执行 complete，不能把短摘要或 ready 当成最终验收。

## 用量与上下文边界

`usage={source,input_tokens,output_tokens,cached_input_tokens?}` 只提交来源明确的本任务真实用量，source 最多 1000 字符。计数为非负安全整数，cached 不超过 input；不重复累加累计快照，不当作全局账单。缺数据则省略 usage 并明确未知。output_sizes 是 result 业务 JSON 自身（排除 size 字段）的字符数和 UTF-8 字节数，不是传输总量或 Token；可单独比较，不换算实际 Token 或费用。

按需路由现有 `token-efficiency`、`filesystem-context`、`context-compression` 或 `token-optimization`，一次选择相关主流程，不递归全量加载。开发交接沿用 `development-handoff` 和唯一状态入口。技能缺失仍按上述核心流程完成；它只能减少可控制的派发、读取与回包，不能拦截宿主所有注入、改写隐藏历史或解除权限限制。
