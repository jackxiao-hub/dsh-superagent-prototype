# P1：离线 deterministic replay

这是一条**可执行的领域闭环证据**，不是完整 Super-agent，也不衡量模型质量。依赖和构建产物准备好后，运行不需要 DSH 服务、GitHub/飞书账号、模型、API key 或网络。

## 运行

在仓库根目录，使用项目支持的 Node.js（含 `node:sqlite`）：

```sh
pnpm build
node lib/replay.js
node lib/replay.js --fixture examples/replay-typo-pr.json
pnpm exec vitest run tests/replay.spec.ts
```

构建步骤使用现有依赖；不需要为 replay 安装新的运行依赖。如果已有构建产物，直接执行 `node lib/replay.js` 即可。`--help` 显示参数说明。默认场景嵌入代码，运行构建后的 CLI 不依赖当前目录或源代码 fixture 的位置。

stdout 为单行 JSON；Node 的 SQLite experimental warning 可能出现在 stderr，不属于 JSON 报告。

- `0`：所有检查通过，且没有操作/队列错误。
- `1`：检查不匹配或场景操作失败；报告中 `ok: false`。
- `2`：参数、JSON、文件大小或 schema 错误；输出 bounded `invalid_input` JSON。

默认场景的关键总数：

```json
{
  "ok": true,
  "totals": {
    "steps": 33,
    "checks": 14,
    "failedChecks": 0,
    "tickets": 3,
    "workersStarted": 4,
    "assessmentRequests": 6,
    "decisions": 8,
    "duplicates": 2,
    "sent": 5,
    "pendingEffects": 0,
    "wouldAccept": 3,
    "restarts": 4
  }
}
```

`workersStarted` 是**假 Executor 启动次数**，包括同一 Ticket 恢复时的新 Assignment；不是模型 worker 数量或成功 PR 数。

## 真实代码与桩的边界

| 使用生产实现 | 明确模拟 |
| --- | --- |
| core Engine 的 Intake/Evals/Tickets/Assignments/Replies | fixture 输入来源及其 actor/human/addressed 标记 |
| `settingsPolicy` gate、allowlist、Mandate revalidation | fixture 声明的 Assessment 接受/忽略，不读取自然语言意图 |
| `assessmentOutcome` 的 rules、direction 和 observe 转换 | 假 Executor：仅报告启动、输入送达/已读和脚本化结构化结果 |
| 真实 SQLite Store、事务、Effects 队列、Outbox receipts | 本地模拟 Channel，仅收集消息，不调用网络 |
| SourceRegistry 路由与 Thread 绑定 | `https://replay.invalid/pulls/17` 等合成 PR，未创建或合并真实 PR |

没有第二套简化状态机。所有接单、跟进、去重、停止、授权和 Assignment 状态变化均经生产 Engine；队列落在真实 SQLite 中。replay adapter 只组合端口、给出脚本结果，以及在重开数据库后把持久记录交还给生产生命周期回调。

Assessment 中的 intent/direction/rule evidence 均写明是 fixture 声明；不意味着模型识别了请求。报告的 `synthetic: true`、`evidence: "scripted-not-executed"` 和顶层 `assurance` 保留这个边界。没有执行 shell、git、CI、真实测试、仓库修改或模型推理。传给 Channel 的 Commands 端口为 fail-closed stub，任何访问都会报错。

## 默认场景证明什么

1. allowlisted `alice` 明确提及/直连 agent，经真实 gate 得到 explicit Decision → Ticket → Mandate → Assignment，产生模拟 acknowledgement。
2. 同 Thread 人类 follow-up 直接送到现有 Ticket，不启动第二次 Assessment 或 worker；重复 origin/follow-up 事件不重复创建记录或输入。
3. 假 Executor 输出结构化 ready report，绑定合成 PR Thread，结果经真实 Outbox 投递；随后合成 merge 事实结束 Ticket。
4. 未列名人员的恶意文本，包括冒充 SYSTEM、修改 allowlist 和泄露 secret 的要求，不改变身份、配置或授权。未知 bot 同样不获得明确授权。
5. observe 模式下 inferred 候选的脚本评估虽是 accept，真实 `assessmentOutcome` 只记录 `would_accept`，不启动 worker。
6. 人停止 Ticket 后，listed bot 和无 sender 的 CI 事件均不恢复这个 Ticket、不向它增加输入。此处默认 observe 模式也不因这些 inferred 候选另建 worker；这不宣称任意 auto 配置下所有自动候选都被拒绝。
7. 真实文件数据库关闭重开四次：
   - 先持久化待处理 Eval/assessment effect，重开后继续接单；
   - 正在运行的 Assignment 经 `Engine.assignmentInterrupted` 生成恢复 note 和新 Assignment，Ticket 与 Mandate 不变；
   - ready 后尚未发送的 result receipt/reply effect，重开后投递一次；
   - 再次重开已 settled 的记录，既不重复发送，也不启动新 Assignment。

`restart` 不保留旧 Engine、Effects、SourceRegistry 或 Executor 实例；仅遥测 journal 继续累计计数。策略、事件、Tickets、Assignments、Evals、receipts 和 effects 均从同一个 SQLite 文件重新读取。reconciliation 通过 `assignmentInterrupted` 及 durable effect 重新排队完成；没有模拟 DSH Session、真实进程崩溃、外部平台幂等性或操作系统隔离。

## Fixture 格式

示例：[replay-typo-pr.json](../examples/replay-typo-pr.json)。schema 和完整默认安全场景见 [scenario.ts](../src/replay/scenario.ts)。

顶层为 `version: 1`、`name`、`mode`（默认 observe）、`allowed`、`bots`、`steps`。固定模拟 Source 为 `replay`，固定规则为 `replay-typo`；fixture 不能执行代码、配置模型、注入任意 Policy 或指定持久化路径。

支持的步骤：

- `receive`：`id/thread/actor/text`，可指定 `human`、`addressed`、`assessment: accept|ignore`、`defer`。
- `repeat`：指定已有 `trigger` ID，重放存储中的同一事件。不要用两个 `receive` 重复 ID。
- `report`：按 origin Trigger ID 指定 `ticket`，以及 `state/summary`；ready 可带合成 `pull` 编号；可 `defer`。
- `closePull`：指定合成 `pull` 和 `merged|closed` 事实。
- `stop`：按 origin 指定 `ticket` 与 `reason`，代表人的停止操作。
- `restart`：关闭真实 SQLite connection，创建新适配器并 reconciliation，再处理持久队列。
- `check`：唯一 `id` 与非空 `expected`；比较总数及可选单个 Ticket 的选择字段。失败保留 expected/actual 并使进程非零退出。

`defer: true` 保留真实队列，便于后续 check 和 restart 检查提交后尚未 dispatch 的情况；check 不隐式驱动队列，普通操作后和场景结束时会处理队列。

**Core 语义细节：** origin Trigger 存于 `Ticket.origin`，并不重复写入 `Ticket.inputs`。因此一个 origin 加一个 follow-up 的 `inputs` 是 1。`includesTrigger/excludesTrigger` 断言的是后续 trigger inputs，不包含 origin。

## 确定性与边界

- 使用固定起点的逻辑时钟；每个步骤前进 1 秒；没有网络、模型、随机语义或定时 sleep。
- 每次运行创建独立临时 SQLite 文件，并在退出时清理；不接受用户已有状态目录，不修改正式实例状态。
- CLI 只读取 regular JSON 文件，最多 256 KiB；读取本身也有上限，文件增长不会造成无界读。
- schema 为 strict：最多 128 步、64 个 check、16 个 allowed/bot；ID、消息、summary 和数字都有限制。空检查集、空 expected、重复 receive/check ID 和未知字段均拒绝。
- effect 处理预算为 1024；失败队列不被当作成功。报告最多保留 16 Tickets、32 Decisions、16 reports、16 messages、16 次 restart、8 条错误；`truncated` 给出省略数量，总数不截断。每条 Ticket 的 input Trigger ID 和每条 Decision 的 Trigger/reason 列表最多 16 项。
- JSON 不包含临时路径、耗时、真实时钟或完整数据库；相同 fixture 在当前实现下产生完全一致的报告。测试对两次 fresh run 做了字节级一致性断言。报告不是未来 core 版本的永久 golden；领域语义变更应明确审阅并更新预期。

入口：[scripts/replay.ts](../scripts/replay.ts)；实现：[index.ts](../src/replay/index.ts)、[cli.ts](../src/replay/cli.ts)；断言：[replay.spec.ts](../tests/replay.spec.ts)。

这完成 P1 的离线领域回放闭环，不证明真实模型质量、真实 GitHub 验收、真实 CI 结果、DSH Session 恢复或完整产品可上线。
