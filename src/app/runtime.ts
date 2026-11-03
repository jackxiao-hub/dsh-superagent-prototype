/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, UserError, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { Safety, SafetyConflict, type SafetyHalt } from './safety.ts'
import { killJobs, runningJobs, until } from '../executor/background.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly safety: Safety
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private safetyStop?: Promise<SafetyHalt>
  /** Retain raw cleanup after a reporting timeout: it must never cancel work after recovery. */
  private safetyCleanup?: Promise<string[]>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const safety = this.safety = new Safety(store, () => ({ maxWorkerSteps: machine.maxWorkerSteps.get(),
        maxWorkerTurns: machine.maxWorkerTurns.get(), inferredAdmissionsPerDay: machine.inferredAdmissionsPerDay.get() }))
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime, safety, machine, paused: () => this.paused(),
        budgetExceeded: (ticketId, reason) => this.executor.budgetExceeded(ticketId, reason),
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), halted: () => !!safety.halted(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => ({ ...settingsPolicy(store.settings(), sources), paused: this.paused() })
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => {
          safety.assertRunning()
          if (ticket.mandate.strength === 'inferred') {
            const admission = safety.admitInferred(ticket.id)
            if (!admission.allowed) throw new UserError('notAdmissible', { reason: `Inferred Ticket admission refused: ${admission.reason}` })
          }
          return executor.prepare(ticket, outcome)
        }, emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused || !!this.safety.halted() }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    const routerDirectory = join(this.machine.stateDir, 'router-work')
    mkdirSync(routerDirectory, { recursive: true, mode: 0o700 })
    await this.sessions.ensure(this.masterId, routerDirectory, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    if (this.safety.halted()) await this.emergencyStop(this.safety.halted()!.reason)
    else this.executor.resume()
    this.passes.start()
    this.effects.start()
    if (!this.safety.halted()) this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      safety: this.safety, emergencyStop: reason => this.emergencyStop(reason), resumeSafety: generation => this.resumeSafety(generation),
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Commit the durable latch before any cancellation. Concurrent callers share one cleanup attempt; a failed cleanup can be retried. */
  emergencyStop(reason: string): Promise<SafetyHalt> {
    const halt = this.safety.halt(reason)
    if (this.safetyStop) return this.safetyStop
    // A timed-out cleanup is still owned. Do not start a second drain while its underlying service calls remain pending.
    if (this.safetyCleanup) return Promise.resolve(halt)
    this.executor.suspend()
    for (const id of [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]) {
      try { this.ctx.agents.get(id as SessionId)?.cancel({ kind: 'hook', reason: 'Emergency halt' }, { keepInbox: true }) }
      catch (error) { this.ctx.logger.warn('Emergency cancellation will be retried during cleanup: %s', String(error)) }
    }
    const cutoff = new AbortController()
    const cleanup = this.safetyCleanup = this.quiesce(cutoff.signal).catch(error => [String(error)])
    void cleanup.then(() => { if (this.safetyCleanup === cleanup) this.safetyCleanup = undefined })
    const work = (async () => {
      const result = await until(cleanup, undefined, 15_000)
      if (result === false) cutoff.abort()
      const errors = result === false ? ['Emergency cleanup timed out; underlying cleanup is still tracked; retry after it settles'] : result
      const settled = this.safety.settled(halt.generation, [...new Set(errors)].slice(0, 20).map(error => error.slice(0, 1000)))
      this.runtimeHealth.set({ state: errors.length ? 'error' : 'paused', detail: errors.length ? errors.join('; ') : `Emergency halt: ${halt.reason}`, at: now() })
      return settled
    })()
    this.safetyStop = work
    void work.then(() => { if (this.safetyStop === work) this.safetyStop = undefined }, () => { if (this.safetyStop === work) this.safetyStop = undefined })
    return work
  }
  /** Management control only: cleanup and CAS must succeed before reconciliation; budgets and person-stopped Tickets are retained. */
  async resumeSafety(expectedGeneration: number): Promise<boolean> {
    if (this.safetyStop || this.safetyCleanup) throw new SafetyConflict('Emergency cleanup is still running')
    if (this.closing() || !this.configured()) throw new SafetyConflict('Runtime is not ready to resume')
    const resumed = this.safety.resume(expectedGeneration, 'panel')
    if (resumed) {
      this.executor.resume()
      this.passes.request()
      this.runtimeHealth.set({ state: 'ready', detail: 'Emergency halt released by operator control', at: now() })
    }
    return resumed
  }
  /** Snapshot loaded roots and direct catalogs, including external children that have no local Agent. */
  private async safetyTargets(signal: AbortSignal): Promise<{ ids: string[]; roots: string[]; children: Map<string, string[]> }> {
    signal.throwIfAborted()
    const tickets = this.store.tickets.list()
    const ids = [...new Set([this.masterId, ...tickets.map(ticket => workerSessionId(ticket.id))])]
    // Jobs remain owned by Session ID after an Agent unload. Previously started Sessions must also be queried for external
    // descendants; a failed/missing catalog is not proof of quiescence. Never-started pending prepares have no Session yet.
    const started = new Set(tickets.filter(ticket => ticket.assignments.some(assignment => assignment.startedAt))
      .map(ticket => workerSessionId(ticket.id)))
    const roots = ids.filter(id => this.ctx.agents.get(id as SessionId) || started.has(id))
    const seen = new Set(ids), children = new Map<string, string[]>()
    const subagents = this.ctx.get('subagents') as { listChildren(id: string, signal?: AbortSignal): Promise<readonly { id: string }[]> } | undefined
    if (subagents) for (let index = 0; index < ids.length; index++) {
      if (!this.ctx.agents.get(ids[index]! as SessionId)) continue
      const rows = await subagents.listChildren(ids[index]!, signal)
      signal.throwIfAborted()
      if (rows.length > 10_000) throw new Error('Too many direct children to confirm emergency cleanup')
      children.set(ids[index]!, rows.map(child => child.id))
      for (const child of rows) {
        if (seen.has(child.id) || !this.ctx.agents.get(child.id as SessionId)) continue
        if (ids.length >= 10_000) throw new Error('Too many descendants to confirm emergency cleanup')
        seen.add(child.id); ids.push(child.id)
      }
    }
    return { ids, roots, children }
  }
  private async quiesce(signal: AbortSignal): Promise<string[]> {
    // This raw Promise stays owned even after the reporting deadline. Abort fences prohibit later cancellation after recovery.
    const errors: string[] = [], targets = await this.safetyTargets(signal)
    const cancel = (id: string) => {
      signal.throwIfAborted()
      try { this.ctx.agents.get(id as SessionId)?.cancel({ kind: 'hook', reason: 'Emergency halt' }, { keepInbox: true }) }
      catch (error) { errors.push(`Cancel ${id}: ${String(error)}`) }
    }
    for (const id of targets.ids) cancel(id)
    const stopped = await Promise.allSettled(targets.ids.map(id => killJobs(this.ctx, id, 'Emergency halt')))
    signal.throwIfAborted()
    stopped.forEach((result, index) => { if (result.status === 'rejected') errors.push(`Jobs ${targets.ids[index]}: ${String(result.reason)}`) })
    const subagents = this.ctx.get('subagents') as {
      drainChildren(parent: Agent, ids: readonly string[]): Promise<void>
      listDescendants(root: string, signal?: AbortSignal): Promise<readonly ({ kind: 'child'; id: string; activity: 'running' | 'inactive' }
        | { kind: 'diagnostic'; id: string; reason: string })[]>
    } | undefined
    // Await the actual drain capability, not stopBackground's bounded wrapper, which can outlive its timeout.
    if (subagents) for (const id of [...targets.ids].reverse()) {
      signal.throwIfAborted()
      const parent = this.ctx.agents.get(id as SessionId), children = targets.children.get(id) ?? []
      if (parent && children.length) try { await subagents.drainChildren(parent, children) }
      catch (error) { errors.push(`Subagents ${id}: ${String(error)}`) }
    }
    signal.throwIfAborted()
    // Child/job completions may wake their parent. Cancel once more and await actual driver quiescence.
    for (const id of targets.ids) cancel(id)
    await Promise.all(targets.ids.map(async id => { const agent = this.ctx.agents.get(id as SessionId); if (agent) await agent.whenIdle() }))
    signal.throwIfAborted()
    // Do not delay immediate child/job cancellation behind a slow external send; still require all in-flight effects to settle.
    await this.effects.idle()
    signal.throwIfAborted()
    for (const id of targets.ids) {
      const agent = this.ctx.agents.get(id as SessionId)
      if (agent && agent.status !== 'idle') errors.push(`Agent still running: ${id}`)
      if (runningJobs(this.ctx, id).length) errors.push(`Jobs still running: ${id}`)
    }
    if (subagents) for (const root of targets.roots) {
      const rows = await subagents.listDescendants(root, signal)
      signal.throwIfAborted()
      for (const child of rows) {
        if (child.kind === 'diagnostic') errors.push(`Cannot verify subagent ${child.id}: ${child.reason}`)
        else if (child.activity === 'running' || this.ctx.agents.get(child.id as SessionId)) errors.push(`Subagent still resident or running: ${child.id}`)
      }
    }
    return errors
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      if (this.safetyStop) await this.safetyStop
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
