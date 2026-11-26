# 任务检查、版本验收与导出

团队概览可「导出已验收成果」到本地 ZIP，包含固定快照文件、冻结结果、`DELIVERY.md` 和逐文件哈希清单；对于 `git-worktree` 团队，导出包还同步包含经 SHA-256 校验的 `artifacts/<taskId>/changes.patch` 与面向人工/下轮交接的 `HANDOFF.md` 集成清单。报告保留未分配成员、未知与未完成任务、无检查及宿主失败例外验收事实。历史缺快照须先显式 freeze；导出不替代整项目集成验证、不改状态、不自动上传。上限 100 任务、2048 条目、128 MiB 未压缩内容，损坏或队内版本变化拒绝整包；浏览器核对响应及 ZIP 哈希后才保存。分享前仍需检查产物和验收理由中的敏感内容。

## 注册检查与调用方验收

所有文件类 check 的 `path` 都是任务产物目录内的相对文件路径，不能穿越目录或经符号链接读取。提交时冻结以下字段：

| type | 其他字段 | 判断与信任级别 |
| --- | --- | --- |
| `file_exists` | 无 | 目标是可读取的普通文件（静态浅检查，不可单独用于 `autoAccept`）。 |
| `file_contains` | `value` 字符串 | 文件包含指定文本（静态浅检查，不可单独用于 `autoAccept`）。 |
| `json_equals` | `pointer, expected` | 按 RFC6901 定位并比较 JSON 值；空 pointer 比较全文，`~1` 表示 `/`、`~0` 表示 `~`；expected 必须是真正的 JSON 值（静态浅检查，不可单独用于 `autoAccept`）。 |
| `node_test` | `testScript` 或 `sourceId, sha256`，可选 `timeoutMs?` | 运行预登记或内联物化在不可变 `ContextStore` 中的固定受信 CommonJS 脚本，退出码 0 才通过；超时或输出超限失败。**唯一允许驱动 `autoAccept: true` 的行为门禁**（开启 `autoAccept: true` 必须至少包含一条 `node_test`）。 |
| `command_test` | `runner`, `args?`, `cwd?`, `timeoutMs?`, `expectOutputContains?` | 多语言结构化行为测试门禁，支持 `node --test`、`pytest`、`python`/`python3 -m pytest\|unittest`、`cargo test`、`go test`、`dotnet test`、`npm test` / `npm run test[:*]`；禁止 `npx`、`-e/--eval/-p/-r/--require`、`python -c`、`go test -exec`、`cargo --config`、`npm --script-shell`、路径穿越与零用例假绿（`# tests 0` / `Ran 0 tests`）。**通过后停在 `checked` 状态，须由调用方显式 `accept` / `accept_checked` 复核放行，禁止用于 `autoAccept: true`**（防止仓库内测试脚手架被同次改动篡改绕过）。 |

`node_test` 支持两种登记方式：（1）在 `engine_team(prepare)` 或 `engine_submit` 的 check 中直接传入内联 `testScript`（引擎自动计算 SHA-256 并存入受信上下文库）；（2）先用同队 `engine_source` 登记受信脚本文本，再将返回的 `sourceId` 和 `sha256` 写入 check。脚本至多 16 KiB，`timeoutMs` 为 100..120000，默认 5000；stdout 与 stderr 合计至多 1 MiB，证据保存输出路径、字节数、哈希与有限预览。Node 以隔离测试目录为 cwd，`process.argv[1]` 是待验产物的绝对路径，可用 `require`；验证异步等待子进程完成并在超时/退出时清理整个进程树，不阻塞引擎事件循环。

**写入范围与 `.git`-free 导出审计**：
- 在隔离目录模式中，若任务声明了非空 `writeScopes`，验证阶段在测试执行**前与后**双重扫描任务工作区，任何落在声明 `writeScopes` 之外的新增产物文件或符号链接均直接产生 `type: "write_scope_guard"` 失败记录（测试输出应写入引擎注入的独立 `TMPDIR`）。
- 在 `git-worktree` 模式中，引擎先通过独立临时 `GIT_INDEX_FILE` 将当前 worktree 封存为不可变 `candidateCommit`，再用 `git diff --raw --find-renames -z <attemptStartCommit> <candidateCommit>` 做双树审计（覆盖 detached HEAD 新提交、重命名新旧路径、删除、mode `120000`/`160000`、符号链接与 Windows 目录联结），随后将 `candidateCommit` 导出到无 `.git` 元数据的临时目录执行 `node_test` / `command_test` 与快照冻结。
- 注意：`node_test` 与 `command_test` 均在本机用户权限下运行，`.git`-free 导出、时间/输出限制与工作区扫描不构成 OS 内核沙箱，不能声称隔离了系统级网络或绝对路径副作用。

任务完成、`engine_control action=verify` 与 `action=accept` 都可能运行已登记测试。`verification.status` 与执行 `state`、`acceptance` 分层：没有 checks 时始终 `status:"not_verified",passed:null`，不能以模型完成或调用方 accept 改称验证通过。检查失败可修复产物后 verify 重验，不必重跑模型；accept 会重新执行适用检查并核对当前版本和产物，版本变化不能沿用旧通过记录。机械通过仍只覆盖已登记条件；调用方判断、独立质量验收和发布授权另行保留。

`engine_control({action:"accept",taskId,expectedRevision?,reason?,acknowledgeHostFailure?})` 的普通调用保持兼容：expectedRevision 是非负安全整数，提供时须匹配当前任务 revision；reason 至多 2000 字符，省略时记录 null，有值须非空。母体取得当前 revision 时直接带入，并根据已核对的证据自行写简短理由，不要求用户手填，也不把未提供理由改写成“已人工核验”。异步检查后会再次核对当前 revision。

宿主 `completionStatus:"failed"` 而现有产物可用时，可先 verify；接受该异常必须同时给出 `acknowledgeHostFailure:true` 和非空 reason。理由说明依据与接受的限制，不能将宿主失败改为成功。acceptance 保存当时的宿主状态、attempt、结果路径与哈希、产物哈希、检查及依赖版本。actor 至多 200 字符，只是调用来源声明，默认 unknown，`actorAssurance:"caller-reported"` 不认证身份；MCP 按真实可得 metadata 记录来源，模型不自造 actor 或冒充真人。

`acceptance.versionPinned` 明确区分调用方是否提交了此前查看的 expectedRevision：提供为 true，未提供为 false，历史缺失为 unknown。内部 revision 并发检查始终存在，但不证明调用方读过该版。不能先盲取最新 revision 再声称已审阅。

验收前将登记产物及完整结果复制成版本快照（`git-worktree` 模式同步基于 `<attemptStartCommit>..<candidateCommit>` 持久化 SHA-256 校验的增量补丁至 `git-patches/`），核对复制字节的大小与哈希，再发布完整清单；`acceptance.snapshotId` 绑定该清单。派发依赖按 `{id,snapshotId}` 固定版本：隔离模式由引擎核验并物化到子任务独立目录，`git-worktree` 模式自动计算传递祖先闭环并按拓扑顺序重放全部上游增量补丁；父任务原目录删改不影响已冻结版本，快照、补丁或子副本损坏则拒绝使用，不能回退原路径。异常验收的 hostCompletionStatus、acknowledgeHostFailure、reason、versionPinned 作为必需依赖信息下传，不能压缩掉或称为普通成功。

旧 accepted 任务无 snapshotId 时须显式 `engine_control({action:"freeze",taskId,expectedRevision?})`；只按原验收记录的哈希冻结，不重新运行任意检查，不重写原验收人、理由或版本固定状态。旧字节已丢失或改变时拒绝冻结，下游继续阻塞。快照只覆盖登记文件与结果（`git-worktree` 模式覆盖增量补丁与登记文件），不覆盖整个项目；版本副本和哈希检测不构成 OS 隔离，不能阻止同账号进程改写仓库或证明所有旧进程已停止。

## 放弃未知任务的业务跟进

仅对 executionUnresolved 为 true 的 unknown、paused-unconfirmed、cancelled-unconfirmed 任务，可调用 `engine_control({action:"abandon",taskId,expectedRevision?,reason,evidence})`。reason 为非空文本至多 2000 字符，evidence 为非空文本至多 4000 字符，描述实际核对范围和未知事项，不编造停止证据。默认携带已查看的版本；业务退出意图明确时可由主线记录，不要求用户填写内部字段。

abandoned 保留旧 attempt、目录、证据、executionUnresolved 和占用容量；它不发送新的取消、不认证停止、不允许原地 resume/retry/accept，不自动创建替代任务。晚到完成或 reconcile 只能补充执行事实，不能把业务状态恢复成待验收或成功。下游 dependency-abandoned 需要重新规划，不能把放弃当成依赖已完成。新计划须明确新目录和外部副作用边界，未知旧尝试仍受全局容量限制；不能靠换目录、换绑定或人工声明绕过。可核对原执行身份时继续 reconcile，无法确认时保留未知。
