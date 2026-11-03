# Read-only diagnostics and isolated acceptance

本页是保守的运维/验收清单，不是已完成部署记录。doctor 只读已有 SQLite 状态，不启动 DSH、调用模型或修改 profile；不表示任何现有 GUI/端口已经部署本 fork，也不声明原生 Windows 的生产支持。

## Doctor：只读入口

构建产物准备好后：

```sh
node lib/doctor.js --help
node lib/doctor.js --state-dir /srv/superagent-backups/verified-snapshot
node lib/doctor.js --state-dir /srv/superagent-backups/verified-snapshot --as-of 2026-11-03T12:00:00.000Z
```

`--state-dir` 指向**已有** `orchestrator.sqlite` 的目录。优先对人工准备、独立保存的一致性 SQLite 备份运行。doctor 不创建缺失目录或数据库，不获取应用 profile lock，不加载/构造生产 Store/Runtime/Safety，不 migrate、checkpoint、chmod、修复或写回记录。

连接使用 `DatabaseSync(path, { readOnly: true })`，加 connection-local `query_only` 和只读事务；所有读取完成后关闭 connection。`quick_check(1)` 检查结构完整性，支持版本明确限制为当前 schema 11，旧版和未知新版一律阻断，不尝试升级。

stdout 除 `--help` 外为一个有界 JSON 文档：

- `schemaVersion: 1` 是报告格式，不是数据库版本；数据库版本在 `state.databaseSchema`。
- `mode: "read-only-diagnostics"`、`ok`、`status`、固定检查列表 `checks`、聚合 `counts`。
- 只投影 halt 的 `active/generation/phase/errorCount`；不输出 halt reason 或 cleanup error 内容。
- 只投影 `paused/evalMode`。无保存设置时标注 `saved: false` 并采用生产默认 `paused=false`、`observe`。
- 不输出消息、完整记录、Ticket/Trigger ID、账号、provider/model、凭据、CLI 参数值、绝对路径或原始异常文本。
- 本地 SQLite experimental warning 可能出现在 stderr，不属于 JSON。

### Exit/status 契约

| Exit | `status` | 含义 | 自动处理 |
| --- | --- | --- | --- |
| 0 | `healthy` | 本次已支持的持久字段/结构检查通过，未观察到 halt/pause/失败 effect | 只记录，不推断进程正在运行或外部系统健康 |
| 2 | `operator-held` | 持久 halt 或 processing pause 仍在 | 保持停止，交给人；绝不自动 resume |
| 2 | `blocked` | 不支持的 schema、缺失 WAL sidecar 或存在失败 effect | 报告固定 code，人工调查；不 migrate/重启/修复 |
| 1 | `error` | 参数/时间、IO、损坏、无效 JSON/聚合字段、关闭连接等失败 | 报警并保留原状态；不代表获得重启权限 |

队列里有未失败的 pending effect 本身并非故障；`failed` 是 `attempts > 0` 的 subset，包含尚在 backoff 的 retry。历史 dropped receipt 保留计数，但不因历史投递被永久丢弃就一概判定当前服务失败。`healthy` 只说明有限的数据库检查，不证明模型可用、账号权限正确、网络正常、进程活着或没有待办工作。

### 计数与时间边界

- `records`：Trigger、Thread、Ticket、Decision、receipt 总数。
- `tickets`：未结束、最新 Assignment 正在 running、由人停止的 Ticket 数；不是当前 OS 进程数。
- `effects`：总 pending 行数、`attempts > 0` 行数，以及最早 `since` 距 `asOf` 的完整秒数；无 effect 时 age 为 null，未来时间 age 为 0。
- `receipts`：pending/sent/dropped 聚合，不包含目标或文本。
- `decisions24h`：`[asOf - 24h, asOf]` 两端包含；未来记录不计。分 explicit/inferred、`would_accept`，并单列两种 strength 下的 accept 数。

24h 窗口是观察统计，**不是语义质量、准确率、误接单率或 PR 成功率**。would_accept 由已有 audit 字段计数；doctor 不重新评估任何消息。step/turn/admission 限制也不是 token/金额预算；doctor 不是 OS sandbox 证明。

`--as-of` 只接受严格有效的 UTC `YYYY-MM-DDTHH:mm:ss.sssZ`，拒绝不可存在的日期、offset、缺省毫秒及超出范围的年份；完整 24h 窗口须落在 1970..9999 范围。省略时用当前时间，专项测试使用固定值确保确定性。输出检查数最多 12 个，无按记录增长的 detail array；SQL 仍可能扫描整个备份，因此不承诺固定执行耗时。

## SQLite 一致性与只读边界

1. **不要只复制运行中数据库的主文件。** WAL 可能含有尚未 checkpoint 的已提交数据；主文件单独 `cp` 不构成一致性备份。
2. 人工使用 SQLite 的受支持 backup API/工具，或在确认所有写入者已停止后采用经验证的一致性快照流程。保留配置、profile 和必要恢复材料的独立受限备份；不要把凭据或原始日志上传为诊断附件。
3. 推荐把在线备份导出到独立目录的、已完成事务且采用 DELETE journal mode 的目标数据库，再对该目标运行 doctor。doctor 本身不生成备份、不更换源数据库 journal mode。
4. 文件 header 表明 WAL 模式时，doctor 在打开 SQLite 前要求已有 regular `-wal` **和** `-shm`；缺任一个返回 `wal_snapshot_required`/exit 2，不创建它们，也不使用会忽略 WAL 的 `immutable=1`。
5. 即使服务干净停止，主文件仍可能保留 WAL header 而 sidecar 已移除。这仍会被保守拒绝；准备独立一致性备份，不要为了 doctor 创建空 sidecar 或修改生产数据库。
6. 对已存在 sidecar 的 live WAL，SQLite 可使用 read-lock/read-mark/共享内存；这是读取环境的 OS 层行为，不是应用 repair。preflight 不是并发删除 sidecar 的 OS 级防护；正式只读巡检优先使用独立稳定备份及合适的 OS 只读权限/挂载。不要把 `readOnly` 理解为零文件系统 metadata/共享内存副作用。

专项测试验证一致性备份读取前后**主数据库 bytes、mtime、mode 以及目录文件列表不变**；对 live WAL 验证同样的主数据库不变和读取未 checkpoint 数据。缺失路径、损坏文件、缺失 WAL sidecar 的拒绝也不新增文件。测试不宣称活跃 writer、WAL read-mark 或 atime 完全不变。

恢复备份必须由人停机、核对版本并在隔离环境演练。不要把旧备份覆盖到正在运行的 state directory，也不要让诊断脚本执行恢复。

## Isolated Linux acceptance checklist

以下均为**待执行的真实验收**，不能用离线模拟报告代替。部署基础见 [Deployment](006-deployment.md)，离线闭环见 [Replay](009-replay.md)。对照当前 fork 的实际 config schema；不要照搬旧版关于全权限默认值的描述。

### 1. 离线、版本与环境

- [ ] 固定并记录 fork commit、Node/DSH 版本、lockfile 和构建结果，先通过专项测试及离线 replay。
- [ ] `node lib/replay.js` 返回 exit 0；确认报告明确标注 synthetic Assessment/Executor/Channel/PR。
- [ ] 在独立 Linux VM/container/OS 账号中准备验收环境。使用新的 `DSH_HOME`/专用 profile、独立 stateDir 和 checkout；与个人 profile、凭据、工作目录完全分开。
- [ ] 使用无特权的专用 OS 用户；不要以 Unix root 运行 agent。root Worker 指根 worker Session，不是 Unix root。
- [ ] 核对 root router/worker 的 permission 配置及实际工作目录。默认 `workspace-write` 不等于可访问所有网络/CLI；若验收确需 `danger-full-access`，必须由人显式 opt-in 并记录扩大权限的风险。保持 worker subagents 默认关闭，除非另行验收。
- [ ] 只给测试仓库、agent GitHub 账号及必要模型凭据；不在该 OS 用户 home 放个人密钥。保护 loopback 管理面，不把管理 API 当成 OS 授权边界。

### 2. 一条真实模型 → PR → 人工合并闭环

- [ ] 配置真实 model；先用 observe 模式、最小 allowlist、限定规则、明确的 root step/turn 上限，inferred 自动接单额度维持 0。
- [ ] 在受控测试仓库发一条 allowlisted、明确提及 agent 的小范围 typo 请求。核对真实 Decision → Ticket/Mandate → Assignment，而不是只看聊天回复。
- [ ] 验证真实 worker 只改授权范围；人工检查 diff、实际 test/check 证据和 PR 链接。没有实际执行的测试必须标注未运行。
- [ ] 禁止自动合并；由人审批并手动 merge。核对绑定 PR 的关闭事实、Ticket 结束结果、Outbox acknowledgement/result 无重复投递。
- [ ] 同 Thread follow-up 不新开无关授权；重复 source event 不重复接单。未列名人员/恶意文本不能提升 allowlist 或扩大 Mandate。
- [ ] 人停止一个 Ticket 后，bot/CI 不恢复该 Ticket。专用 profile 重启后仍保持停止语义；不得通过清库/重置 budget 绕过。
- [ ] 生成独立一致性备份，doctor 聚合与人工记录相符。真实 PR 的 review/merge 证据单独保存；doctor 计数不取代它。

### 3. Observe 观察，不直接打开 auto

- [ ] 在受控时间窗口保留 observe inferred 候选；核对 would_accept 有记录而未启动 inferred worker。
- [ ] 按固定 UTC `asOf` 导出 doctor 聚合，对照人工抽样标签与明确授权边界。语义误差必须人工判定，不把统计个数说成准确率。
- [ ] 需要 auto 时另做风险审批与独立验收；本清单不因为 `healthy`、某个 would_accept 数量或一次 PR 成功就自动切换模式。

## Halt、清理与人工 generation-CAS resume

- **Ticket stop、processing pause、全局 safety halt 是不同状态。** doctor 只报告它们，不转换它们。
- 人触发 halt 后，持久 latch 应先落盘；等待 root/descendant agent、背景 job、in-flight effect/外部命令的清理。
- `phase: stopping` 或 `errorCount > 0` 时保持 halt。由人调查受限日志并通过现有控制面重试清理；不要把 errors 从数据库直接删掉来“解锁”。
- 人确认 `phase: halted` 且 `errorCount: 0` 后，在**当前 live 管理面重新读取** generation，再明确提交同一个 generation 的 resume。独立 backup 中的 doctor generation 可能已过时，不是自动 resume 凭证。
- 当前控制面使用 `POST safety/halt` 和 `POST safety/resume`（后者 body 为 `{"generation": n}`）；只供人工运维使用，不交给模型工具、cron 或 watchdog 自动调用。CAS 冲突说明状态已变化，应重新检查，不盲目重试。
- 人工 resume 也不重置已计入的 root worker budget，不复活人停止的 Ticket；未单独取消 processing pause 时仍应保持其含义。

## Startup / watchdog：只诊断，不修复

- 启动前检查备份与版本，运行 doctor 并记录 exit code；这不是“有错误就迁移/重启”的授权。
- 巡检只调用只读入口并通知人；exit 2 保持 operator hold，exit 1 也不自动重启。不要让脚本改代码、重新安装、重建 profile、删 state、清 safety latch 或自动打开 auto mode。
- 手动停止进程/服务的 marker 与数据库 safety halt 都应被尊重。doctor 不读取/清除 service stop marker，因此绝不能只因 `healthy` 就启动一个可能被人停止的服务。
- 持久 DB 中的 running Assignment 不证明 OS worker 仍活着；实际服务状态另由人检查，不由 doctor执行外部进程命令。

实现：[diagnostics/index.ts](../src/diagnostics/index.ts)、[CLI](../src/diagnostics/cli.ts)、[构建入口](../scripts/doctor.ts)；专项断言：[diagnostics.spec.ts](../tests/diagnostics.spec.ts)。
