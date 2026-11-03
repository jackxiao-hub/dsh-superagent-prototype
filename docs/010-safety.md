# Safety defaults, durable budgets and operator halt

本 fork 的 P2 增加 Host 端调度保护，不把 prompt 中的约定当作强制策略，也不把这些保护称为完整的安全沙箱。真实模型、OS sandbox、GitHub 权限和实际外部操作仍需独立环境验收；当前个人 profile 不会因此自动安装或切换。

## 默认值与权限

| 配置 | 默认值 | 生效及边界 |
| --- | --- | --- |
| `executionPermission` | `workspace-write` | root Router / Worker 显式选择实际提供该 sandbox mode 的 permission preset；approval 为 `never`。修改需重启 |
| `allowWorkerSubagents` | `false` | 默认不准入嵌套 Worker，避免绕开 root budget；修改需重启 |
| `maxWorkerSteps` | `120` | 每 Ticket 的 root Worker step 准入总量，跨 turn、重试、Session 与重启保留；1..100000，可动态调整 |
| `maxWorkerTurns` | `12` | 每 Ticket 不同 root Worker turn 的准入总量；1..100000，可动态调整 |
| `inferredAdmissionsPerDay` | `0` | UTC 每日新 inferred Ticket 准入；0 禁用，不影响明确请求；0..100000，可动态调整 |

三个数值限制可通过 **Settings → Deployment** 的可写 DSH ConfigForm 调整。权限与委派开关仅显示，不在此表单提供提升权限的操作；必须审阅专用 profile 的配置并重启。更改上限不清零已经记录的用量。`eval.mode` 仍默认为 `observe`：候选 `would_accept` 不启动 inferred Worker；即使另行打开 `auto`，默认每日配额 0 仍拒绝新 inferred Ticket。

`danger-full-access` 必须由操作员显式选择；不要为了绕过 workspace-write 下的网络/CLI 错误就自动升级。没有相应 permission preset、工作目录服务或 approval 服务时应拒绝初始化，而不是退回完全访问模式。

Router 的工作目录变为 `stateDir/router-work`，不再把 SQLite、配置和锁所在的整个 stateDir 当成可写 workspace。已有 Router Session 迁移前先取消并确认工作停止，再持久化新 cwd。这个目录分离**只缩小写入面**，不等于禁止读取凭据、不等于隔离同 OS 用户，也不保证网络访问被隔离。

## 调度预算，不是模型费用上限

- 在实际 `agent/pre-step` waterfall 返回 `enter` 前，由 Host 同步计入用量；下游监听器等待后再次检查 halt。
- position 由持久 Session 身份、turn、step 标识；Session 创建时间参与身份。同一位置重入不重复扣费；相同 Session ID 被删除重建后不能用 turn 0 复用旧额度。
- 超限时拒绝进入下一步，记录 blocked 状态并停止后台执行；不能只靠模型自行停手。工具门禁同时检查初始化、halt、Ticket 是否结束和预算阻断。
- 每日 inferred 准入在创建 Ticket 的 Engine 事务内保留。拒绝会回滚，不启动 Worker，也不发出接单 acknowledgement。重试同一 Ticket 不重复消耗一笔每日准入。
- **不限制已经在途的模型请求、provider 自动重试、tokens、金额或 wall-clock 时间。** 这些需要 provider/运行环境的独立硬限制。
- 若显式打开 nested agents，预算仍只覆盖 root Worker，不覆盖 nested agent 的步骤和费用。必须另行验收；不能把 root 限额描述成整个 agent tree 的费用限制。
- 暂停、急停、人工恢复和进程重启不重置预算。确需增加上限应由人显式调整，不能通过删 KV 或重新建 Ticket 自动规避。

预算和 halt 的实现见 [Safety](../src/app/safety.ts)，集成见 [Sessions](../src/app/sessions.ts) 与 [Runtime](../src/app/runtime.ts)。

## 三种“停止”不可混用

| 操作 | 含义 |
| --- | --- |
| Ticket stop | 按既有领域规则结束单个 Ticket；后续 bot/CI 不能仅因有上下文就获得重开授权 |
| Processing pause | 停止新的评估、派工和 Outbox 发送；来源仍记录输入。**不取消正在运行的 turn/job** |
| Global safety halt | 先持久化 latch，再取消受管理 Router、Worker、其子任务及后台工作；保持锁定直到人明确解除 |

面板所有 tab 的顶部提供 **急停全部工作**。急停成功写入 SQLite 后才开始清理，清理包括：

1. 停止新的模型准入、消息唤醒、派工和回复；中止 Worker prepare 调度。
2. 取消受管理 root；等待正在执行的 effects，不把“已发出 cancel”误认为已停止。
3. 清理 jobs 和子 agent；子 agent provider 包括没有本地 Agent 实例的执行。
4. 再次取消可能被完成事件唤醒的父 Session，确认 driver、jobs 与 descendants 确实静止。
5. 持久化 `phase: halted` 及有界 `errors`。只有没有未确认清理项时才允许解除。

已提交给 GitHub、飞书或其他外部系统的操作不可撤销，急停不是事务回滚。跨进程的任意外部写入也不是 exactly-once 保证。

### 超时、重试与重启

- 超时会报告清理未确认并保留 latch。底层 cleanup promise 仍单独追踪；超时不会让旧任务在人工恢复后继续取消新工作。
- 旧 cleanup 仍在运行时，不并发启动另一轮危险清理，也不允许 resume。必要时由人调查或停进程；不得删 latch“解锁”。
- 重复 stop 幂等地保留现有 generation / reason。清理失败后可用面板 **重新确认清理**，不是自动 resume。
- 启动读到已有 latch 时可重新尝试清理，但不自动恢复 Executor；正常重启不清除人为停止状态。

## 人工 generation-CAS 解除

人工确认清理后，通过当前 live 管理面重新读取 halt generation，再确认解除同一代 halt。面板会在观察到 generation 变化时关闭旧确认弹窗；服务器也检查 CAS，旧值返回 409，不盲目重试。工具中不注册解除急停的操作。

```text
POST safety/halt    {"reason":"Operator requested stop"}
POST safety/resume  {"generation":7}
```

上述是 loopback 管理 API 的相对路由，实际前缀及请求头见 [Deployment](006-deployment.md)。resume 不清预算，不复活人停止的 Ticket，也不清除独立的 processing pause。清理未结束、存在 errors 或 Runtime 未就绪时拒绝恢复。

**“不提供给模型工具”不等于强认证。** 现有 loopback、same-origin 和 `x-orchestrator-request` 只防误用/跨站请求；没有密码学证明请求来自人。具备同 OS 用户完全访问或可访问本机管理端口的 shell 可能直接调用 API。正式部署必须隔离管理面及网络/进程权限，不能依赖一个 `by: panel` 字符串区分人和模型。

## 部署前仍必须满足

- 独立 Linux OS 账号/VM/container、独立 profile / stateDir；不放个人 SSH、其他项目和组织管理凭据。
- 最小模型及 GitHub 凭据，限制出口和本机管理端口。Host prepare、Source CLI 是可信 Host subprocess，不自动受 Worker sandbox 约束。
- 服务端分支保护、必要 checks、人类 review 与人工 merge。当前原型没有通用的 Host merge 授权引擎；命令 shim / prompt 不构成 merge 安全边界。
- 离线 replay 仅证明领域流程；真实模型 → diff/tests → PR → 人工 merge、实际 sandbox 和安装后的 UI 需单独验收。

专项覆盖见 [Safety tests](../tests/safety.spec.ts)、[Runtime safety tests](../tests/runtime-safety.spec.ts)、[HTTP tests](../tests/http.spec.ts) 和 [panel tests](../tests/panel-execution.spec.tsx)。这些测试不是外部系统或 OS 权限的生产认证。
