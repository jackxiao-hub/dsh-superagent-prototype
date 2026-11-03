# Fork implementation roadmap

本 fork 在官方研究原型上增量实施，保留原作者、MIT 许可和研究代码免责声明。不修改用户现有的个人 Harness profile，不自动接入账号或启动真实外部任务。

## 阶段与放行条件

| 阶段 | 状态 | 范围 | 放行条件 |
| --- | --- | --- | --- |
| P0 | 完成；后续跨平台修复后远端三环境 CI 全通过 | DSH 0.2.1-rc.5、Cordis 4.0.5、Schemastery 3.18.5；锁文件；Linux/Windows CI | 无 peer 冲突，类型检查和构建通过；平台专用测试明确区分 |
| P1 | 完成离线领域闭环与本机验证 | 无账号、模型和网络的确定性离线回放；真实 Engine / Policy / SQLite / Effects / Outbox | 请求到模拟 PR/交付、订阅直通、去重、观察模式、停止与恢复全部有断言 |
| P2 | 完成本机完整验证 | 安全默认、独立 Router 工作目录、持久急停、调度预算、主动接单配额 | Host 端强制；跨重启不清零；急停先持久化再取消；人工恢复有 CAS |
| P3 | 待实现 | 主动观察统计、只读运维检查与部署验收说明 | 不自动扩大授权、不擅自恢复人工停止、故障原因可追溯 |

每一阶段单独提交。后续阶段可能在工作区并行开发，但只有经过审阅和相应验证的文件进入该阶段提交。

## P0：兼容性基线

- 开发依赖固定到当前 Harness `0.2.1-rc.5`，插件 peer / engines 的最低支持版本同步调整。旧 alpha 环境不再是本 fork 的支持目标。
- 显式对齐 Cordis include / group 插件版本，避免依赖升级后旧锁文件残留不兼容 peer。
- 适配 rc.5 配置表单的 `writable` 能力字段，不再读取已移除的 transport `mode`。
- Web 管理请求在服务尚无已绑定端口时拒绝，而不是猜测来源。
- 使用本机路径语义校验执行目录；Windows stateDir 接受盘符根路径和完整 UNC share，拒绝 `C:relative` 与裸 UNC server。
- 修复文档索引、PATH 分隔符、git 配置转义等测试的路径假设。

原始版本在本机 Windows / Node 24.13.0 上：类型检查通过，测试 **1160 通过、37 失败**。失败涉及 POSIX 脚本、信号、权限位和路径假设；不能把它们一概归因于 Harness API 不兼容。

升级后已本机执行：依赖安装、`pnpm peers check`、`pnpm typecheck`、回归测试与 `pnpm build`。POSIX 专用用例在 Windows 明确跳过，继续由 Linux CI 执行。并行阶段新增模块的文档索引在对应阶段一并维护。

## 开发验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm peers check
pnpm check
```

默认不运行依赖 lifecycle scripts。本项目所用 SQLite 为 Node 内置模块，不需另外编译 SQLite addon。

CI 在 Linux 的 Node 22.20.0 / 24.13.0 执行完整检查，在 Windows / Node 24.13.0 执行可移植检查。Windows 条件跳过的只有明确需要 POSIX 执行环境的用例：服务控制脚本、扩展名为空的 shell shim / Feishu consumer、真实 CLI setup 与 POSIX 权限位；POSIX kill 信号断言亦不适用 Windows。核心领域、授权、SQLite、投递、UI 与大部分 Runtime 测试仍然运行。

## P1：离线领域闭环

`pnpm build` 后执行 `pnpm replay`，默认运行 33 步、14 个检查，覆盖明确请求、Mandate、订阅直通、事件去重、观察模式、人工停止和 4 次 SQLite 关闭重开。专项测试 11 项，输出包含真实/模拟实现边界；失败返回非零退出码。自定义数据场景有 strict schema、大小和执行步数上限，不接受脚本或已有状态目录。

P1 集成本机 `pnpm check`：**1179 通过、29 个明确 POSIX 用例跳过**，类型检查和构建通过；构建后的默认场景与 JSON 示例均 exit 0。P0 远端 Linux 双版本完整 CI 已通过；Windows runner 的 TEMP 与 checkout 不同盘，暴露了 prompt 测试 fixture 使用跨盘 `relative()` 的问题，P1 将 fixture 限定到 package 同盘，未放宽生产路径规则。

这里的 P1 是可重复的领域闭环验收，不是已部署的真实 GitHub Agent；后者仍需专用账号和隔离环境中的集成验收。

## P2：Host 安全控制

详见 [安全默认与边界](010-safety.md)。默认 `workspace-write`、approval `never`、Worker subagents 关闭；Router 使用独立 `router-work`。每 Ticket 默认 120 root steps / 12 turns，UTC 每日 inferred 准入默认 0；明确请求不受这笔每日配额限制。

- Safety 使用现有 SQLite 原子事务持久化 halt / generation-CAS、position 账本与每日额度，不增加自定义 Session event。
- Host 实际 pre-step waterfall 强制预算，创建身份参与 position 去重；超限同步阻断工具与后续模型步骤。
- 急停先持久化，再取消 roots/jobs/子代/prepare，验证真正 quiet；超时底层 cleanup 仍追踪，禁止与后续恢复重叠。
- 面板跨 tab 提供急停、清理重试与人工 CAS 解除；旧 generation 的确认不能解除新一代 halt。预算可通过 DSH ConfigForm 修改，权限提升不在此表单提供。
- 保留的边界：只限制 root 调度，不是 token/费用预算；loopback API 不是强认证；Host subprocess、外部已提交写入、分支保护和真实 sandbox 需部署层解决。

P2 本机完整 `pnpm check`：**1215 通过、29 个 POSIX 用例跳过**；peer 检查、类型检查与构建通过。新增 Safety 12 项、Runtime safety 16 项，另有 HTTP / UI 的急停、CAS 冲突和预算配置回归；这些并非真实模型或 OS sandbox 验收。

P0/P1 的远端三环境 CI 在 stream-health 修复提交后已全通过：[Actions](https://github.com/jackxiao-hub/dsh-superagent-prototype/actions/runs/41485880598)。该修复保留同一 Feishu 连接上的 JSON 错误，避免 stdout/stderr 的 ready 行顺序掩盖错误；没有放宽 Linux 断言。

## 支持边界

**Windows 的类型检查、构建和领域测试通过，不代表 Windows 生产部署已支持。** 服务脚本仍依赖 `fcntl` / `tmux`，prepare 与 CLI shim 仍依赖 POSIX shell。首选独立 Linux 环境；WSL2 仅作为可选开发环境，需限制 Windows 盘挂载和互操作。

现有外部集成、会话循环与沙箱在本次本机测试中主要使用测试 Host；真实模型、GitHub/飞书账号、实际沙箱、已安装 bundle 的 UI 仍需独立环境中的集成验收。不得把离线模拟交付称为真实代码质量或实际 PR 的验证。

默认权限已改为 `workspace-write`，完全访问必须显式 opt-in；但这不是部署认证。不要把它安装进持有个人 SSH 密钥和其他项目凭据的 profile。运行时限制不取代专用 OS 账号、容器/VM、最小凭据、管理面隔离、分支保护与人工合并。
