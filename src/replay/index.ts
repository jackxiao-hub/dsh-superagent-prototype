/** Offline adapter around the production Engine, Policy, SQLite Store, Effects and Outbox. No DSH session or remote adapter is loaded. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { Engine, latestAssignment, liveTicket, runningAssignment, type Candidate, type Executor, type Ticket, type Trigger } from '../core/index.ts'
import { Store } from '../app/store.ts'
import { Effects } from '../app/effects.ts'
import { Outbox } from '../app/outbox.ts'
import { HealthBoard } from '../infra/health.ts'
import type { Commands } from '../infra/commands.ts'
import { assessmentOutcome, SettingsSchema, settingsPolicy, type Assessment } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { DEFAULT_SCENARIO, ReplayScenarioSchema, type ReplayExpected, type ReplayScenario, type ReplayStep } from './scenario.ts'

export { DEFAULT_SCENARIO, ReplayScenarioSchema } from './scenario.ts'
export type { ReplayScenario } from './scenario.ts'

/** Summary arrays are capped independently of the 128-step/64-check input limit; totals are never truncated. */
export const SUMMARY_LIMITS = { tickets: 16, decisions: 32, reports: 16, messages: 16, restarts: 16, checks: 64, errors: 8 } as const
interface RecordedReport {
  ticketOrigin: string; assignmentId: string; state: string; summary: string
  synthetic: true; evidence: 'scripted-not-executed'; pullRequest?: { number: number; url: string; synthetic: true }
}
interface RecordedMessage { id: string; ticketId?: string; kind: string; thread: string; text: string; synthetic: true }
interface Recovery { pendingEffectsBefore: number; evaluations: number; pendingAssignments: number; interruptedAssignments: number; pendingReceipts: number }
export interface ReplayCheck { id: string; passed: boolean; expected: ReplayExpected; actual: Record<string, unknown> }
export interface ReplaySummary {
  schemaVersion: 1
  mode: 'offline-replay'
  scenario: string
  ok: boolean
  assurance: { real: string[]; stubbed: string[]; doesNotProve: string[] }
  totals: { steps: number; checks: number; failedChecks: number; tickets: number; workersStarted: number; assessmentRequests: number;
    decisions: number; duplicates: number; sent: number; pendingEffects: number; wouldAccept: number; restarts: number }
  checks: ReplayCheck[]
  tickets: { id: string; origin: string; strength: string; actor: string; scope: string; basis: string; assignments: number;
    outcome: string; report: string; inputTriggers: string[] }[]
  decisions: { kind: string; triggerIds: string[]; strength: string; reasons: string[]; wouldAccept: boolean }[]
  reports: RecordedReport[]
  messages: RecordedMessage[]
  recovery: Recovery[]
  errors: string[]
  truncated: { tickets: number; decisions: number; reports: number; messages: number; restarts: number; errors: number }
}
interface Journal {
  workersStarted: number; assessmentRequests: number; duplicates: number; actions: number
  reports: RecordedReport[]; messages: RecordedMessage[]; recovery: Recovery[]; checks: ReplayCheck[]; errors: string[]
}
const pullThread = (number: number) => ({ source: 'replay', id: `pull-${number}` })
const scopeText = 'Correct only the specified existing typo; preserve meaning and behavior.'

/** The only mutable authority lives in the production Store. Journal data is telemetry, not consulted for routing or authorization. */
class ReplayHost {
  readonly store: Store
  readonly effects: Effects
  readonly engine: Engine
  private dispatchEnabled = false
  private readonly executor: Executor
  constructor(path: string, private readonly now: () => number, private readonly journal: Journal) {
    this.store = new Store(path, error => { journal.errors.push(String(error).slice(0, 640)) })
    const board = new HealthBoard()
    this.effects = new Effects(this.store, board, now)
    const sources = new SourceRegistry(() => this.store.settings(), board)
    sources.register({
      kind: 'replay', title: { en: 'Offline replay stub', zh: '离线回放桩' },
      description: { en: 'Scripted, not a real external source', zh: '脚本输入，并非真实外部来源' },
      schema: z.object({}).strict(), fields: [], health: [],
      scope: () => ({ listened: true, observed: true, row: 'offline' }),
      channel: {
        send: async (_host, message) => {
          this.action()
          journal.messages.push({ id: message.id, ...message.ticketId ? { ticketId: message.ticketId } : {}, kind: message.kind,
            thread: message.channel.thread, text: message.text, synthetic: true })
          return 'sent'
        },
        link: () => ({ url: '', label: { en: 'Synthetic channel', zh: '模拟通道' } }),
      },
    })
    // Outbox carries Commands to its Source adapter; this adapter must never access it. Fail closed on any attempted use.
    const commands = new Proxy({} as Commands, { get() { throw new Error('Offline replay forbids subprocess/credential access') } })
    const outbox = new Outbox({ store: this.store, effects: this.effects, sources, commands, paused: () => !this.dispatchEnabled })
    const assessor = {
      request: (candidate: Candidate) => this.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }),
      release: (evalId: string) => { this.effects.cancel('assessment', evalId) },
    }
    this.executor = {
      start: (ticket, assignment) => this.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }),
      deliver: ticket => this.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }),
      stop: (ticket, assignment) => { this.effects.cancel('launch', assignment.id); this.effects.cancel('delivery', ticket.id) },
    }
    this.engine = new Engine({ repo: this.store, scope: sources, policy: () => settingsPolicy(this.store.settings(), sources),
      assessor, executor: this.executor, outbox, now: () => new Date(now()).toISOString() })
    const enabled = () => this.dispatchEnabled ? 1 : 0
    this.effects.handle('assessment', async ({ triggerId }, evalId) => {
      this.action()
      const candidate = this.engine.candidate(triggerId)
      if (!candidate || candidate.evalId !== evalId) return
      journal.assessmentRequests++
      this.engine.candidateDelivered(evalId)
      // This judgement is fixture data, never a natural-language classifier. A malicious event is still subject to the real gate.
      const trigger = candidate.triggers.at(-1)!
      const settings = this.store.settings()
      const assessment: Assessment = {
        decision: trigger.meta.replayAssessment === 'ignore' ? 'ignore' : 'accept',
        rule_assessments: settings.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched: true, reason: 'Scripted fixture match, not model evidence.' })),
        direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Scripted fixture direction.' },
        title: `Replay ${trigger.id}`, scope: scopeText, reason: 'Offline scripted assessment.',
        intent_evidence: 'Fixture declares implementation intent; no model was evaluated.', acknowledgement: 'Offline stub accepted the authorized typo request.',
      }
      const outcome = assessmentOutcome(assessment, settings, candidate.strength)
      this.engine.decide(triggerId, { ...outcome, evalId, audit: { ...outcome.audit, replay_stub: true } })
    }, { limit: enabled })
    this.effects.handle('launch', async ({ ticketId, assignmentId }) => {
      this.action()
      const ticket = this.store.tickets.get(ticketId)
      const assignment = ticket && latestAssignment(ticket)
      if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
      journal.workersStarted++
      this.engine.assignmentStarted(ticketId, assignmentId)
    }, { limit: enabled })
    this.effects.handle('delivery', async ({ ticketId }) => {
      this.action()
      const ticket = this.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || !ticket.undelivered.length) return
      const ids = [...ticket.undelivered]
      this.engine.inputsDelivered(ticketId, assignment.id, ids)
      this.engine.inputsRead(ticketId, ids)
      this.engine.turnEnded(ticketId, assignment.id)
    }, { limit: enabled })
  }
  private action(): void {
    if (++this.journal.actions > 1024) throw new Error('Offline effect budget (1024) exceeded')
  }
  seed(scenario: ReplayScenario): void {
    this.store.saveSettings(SettingsSchema.parse({
      sources: { replay: { enabled: true } }, eval: { mode: scenario.mode },
      policy: {
        rules: [{ id: 'replay-typo', name: 'Scripted typo fixture', instruction: 'A fixture rule, not a model evaluation.', enabled: true }],
        sources: { replay: { allowed: scenario.allowed.map(id => ({ id })), bots: scenario.bots.map(id => ({ id })),
          admission: { offline: { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'inferred' } } } },
      },
    }))
  }
  pendingEffects(): number { return Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM effect').get()!.n) }
  ticket(origin: string): Ticket {
    const ticket = this.store.tickets.list().find(item => item.origin.triggerId === origin)
    if (!ticket) throw new Error(`No accepted ticket originated from ${origin}`)
    return ticket
  }
  /** Reconstruct adapters, then reconcile only persisted production records through the Engine's lifecycle callbacks. */
  reconcile(pendingEffectsBefore: number): void {
    const recovery: Recovery = { pendingEffectsBefore, evaluations: 0, pendingAssignments: 0, interruptedAssignments: 0, pendingReceipts: 0 }
    for (const thread of this.store.threads.active()) if (thread.evaluating) {
      const evaluation = thread.evaluating
      if (!this.effects.pending('assessment', evaluation.id)) this.effects.enqueue('assessment', evaluation.id, { triggerId: evaluation.triggerIds[0]! })
      recovery.evaluations++
    }
    for (const ticket of this.store.tickets.active()) {
      if (!liveTicket(ticket)) continue
      const assignment = latestAssignment(ticket)
      if (assignment?.state === 'pending') { this.executor.start(ticket, assignment); recovery.pendingAssignments++ }
      else if (assignment?.state === 'running') { this.engine.assignmentInterrupted(ticket.id, assignment.id); recovery.interruptedAssignments++ }
    }
    for (const receipt of this.store.receipts.waiting()) {
      if (!this.effects.pending('reply', receipt.id)) this.effects.enqueue('reply', receipt.id, {})
      recovery.pendingReceipts++
    }
    this.journal.recovery.push(recovery)
  }
  receive(step: Extract<ReplayStep, { op: 'receive' }>): void {
    const trigger: Trigger = { id: step.id, source: 'replay', threads: [{ source: 'replay', id: step.thread }],
      actor: { source: 'replay', id: step.actor }, human: step.human, ...step.addressed ? { addressed: step.addressed } : {},
      at: new Date(this.now()).toISOString(), text: step.text, channel: { source: 'replay', thread: step.thread, address: { message: step.id } },
      meta: { replayAssessment: step.assessment } }
    this.engine.receive(trigger)
    // Evaluate synchronously so defer leaves a genuine durable assessment effect, rather than an in-memory work item.
    this.engine.evaluateDue()
  }
  repeat(id: string): void {
    const trigger = this.store.triggers.get(id)
    if (!trigger) throw new Error(`Cannot repeat unknown event ${id}`)
    if (this.engine.receive(trigger) !== 'duplicate') throw new Error(`Production intake did not deduplicate ${id}`)
    this.journal.duplicates++
  }
  report(step: Extract<ReplayStep, { op: 'report' }>): void {
    const ticket = this.ticket(step.ticket)
    const assignment = runningAssignment(ticket)
    if (!assignment || !liveTicket(ticket)) throw new Error(`No running fake executor for ${step.ticket}`)
    const pullRequest = step.pull ? { number: step.pull, url: `https://replay.invalid/pulls/${step.pull}`, synthetic: true as const } : undefined
    if (pullRequest) {
      if (step.state !== 'ready') throw new Error('A synthetic PR delivery requires a ready report')
      this.engine.bindThread(ticket.id, pullThread(pullRequest.number), true)
    }
    const summary = `${step.summary}${pullRequest ? ` Synthetic PR: ${pullRequest.url}` : ''}`
    this.engine.report(ticket.id, { state: step.state, summary })
    this.journal.reports.push({ ticketOrigin: step.ticket, assignmentId: assignment.id, state: step.state, summary,
      synthetic: true, evidence: 'scripted-not-executed', ...pullRequest ? { pullRequest } : {} })
    if (step.state === 'ready') this.engine.reply({ purpose: 'result', ticketId: ticket.id, text: summary })
  }
  async flush(): Promise<void> {
    this.dispatchEnabled = true
    try {
      this.engine.evaluateDue()
      this.effects.start()
      await this.effects.idle()
      const errors = this.store.db.prepare("SELECT kind, error FROM effect WHERE attempts > 0 ORDER BY seq LIMIT 1").get()
      if (errors) throw new Error(`Offline ${String(errors.kind)} effect failed: ${String(errors.error)}`)
      if (this.pendingEffects()) throw new Error('Offline effect queue did not settle')
    } finally { this.dispatchEnabled = false }
  }
  async close(): Promise<void> { this.dispatchEnabled = false; try { await this.effects.drain() } finally { this.store.close() } }
  decisions() { return this.store.threads.list().flatMap(thread => this.store.decisions.byThread(thread.key)) }
  actual(expected: ReplayExpected): Record<string, unknown> {
    const decisions = this.decisions()
    const all: Record<string, unknown> = {
      tickets: this.store.tickets.list().length, workersStarted: this.journal.workersStarted, assessmentRequests: this.journal.assessmentRequests,
      decisions: decisions.length, duplicates: this.journal.duplicates, sent: this.journal.messages.length,
      pendingEffects: this.pendingEffects(), wouldAccept: decisions.filter(item => item.audit?.would_accept === true).length, restarts: this.journal.recovery.length,
    }
    if (expected.ticket) {
      const wanted = expected.ticket, ticket = this.ticket(wanted.origin)
      const triggerIds = ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])
      const facts: Record<string, unknown> = {
        origin: ticket.origin.triggerId, strength: ticket.mandate.strength, actor: ticket.mandate.actor.id, scope: ticket.mandate.scope,
        basis: ticket.mandate.basis.via, assignments: ticket.assignments.length, inputs: ticket.inputs.length,
        outcome: ticket.ended?.outcome ?? 'open', report: latestAssignment(ticket)?.report?.state ?? 'none',
        recoveryNotes: ticket.inputs.filter(input => input.kind === 'text' && input.text.includes('host restarted')).length,
        ...wanted.includesTrigger ? { includesTrigger: triggerIds.includes(wanted.includesTrigger) ? wanted.includesTrigger : null } : {},
        ...wanted.excludesTrigger ? { excludesTrigger: triggerIds.includes(wanted.excludesTrigger) ? null : wanted.excludesTrigger } : {},
      }
      all.ticket = Object.fromEntries(Object.keys(wanted).map(key => [key, facts[key]]))
    }
    return Object.fromEntries(Object.keys(expected).map(key => [key, all[key]]))
  }
}

/** Always uses an isolated temporary SQLite file; restart closes it and constructs fresh adapters on the same file. */
export async function runReplay(input: unknown = DEFAULT_SCENARIO): Promise<ReplaySummary> {
  const scenario = ReplayScenarioSchema.parse(input)
  const temporaryRoot = resolve(tmpdir())
  const directory = mkdtempSync(join(temporaryRoot, 'dsh-superagent-replay-'))
  const database = join(directory, 'replay.sqlite')
  const journal: Journal = { workersStarted: 0, assessmentRequests: 0, duplicates: 0, actions: 0, reports: [], messages: [], recovery: [], checks: [], errors: [] }
  let clock = Date.UTC(2026, 0, 1), steps = 0
  let host: ReplayHost | undefined
  try {
    host = new ReplayHost(database, () => clock, journal)
    host.seed(scenario)
    for (const step of scenario.steps) {
      clock += 1000
      steps++
      if (step.op === 'check') {
        const actual = host.actual(step.expected)
        journal.checks.push({ id: step.id, expected: step.expected, actual, passed: JSON.stringify(actual) === JSON.stringify(step.expected) })
        continue
      }
      switch (step.op) {
        case 'receive': host.receive(step); break
        case 'repeat': host.repeat(step.trigger); break
        case 'report': host.report(step); break
        case 'closePull': host.engine.threadClosed(pullThread(step.pull), step.outcome, new Date(clock).toISOString()); break
        case 'stop': host.engine.stopTicket(host.ticket(step.ticket).id, step.reason); break
        case 'restart': {
          const pending = host.pendingEffects()
          await host.close()
          host = undefined
          host = new ReplayHost(database, () => clock, journal)
          host.reconcile(pending)
          break
        }
      }
      if (!('defer' in step && step.defer)) await host.flush()
    }
    await host.flush()
    return summarize(host, scenario, journal, steps)
  } catch (error) {
    journal.errors.push((error instanceof Error ? error.message : String(error)).slice(0, 640))
    return summarize(host, scenario, journal, steps)
  } finally {
    try { await host?.close() } finally {
      // Only remove the directory created above, never a caller-supplied state path.
      if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('dsh-superagent-replay-')) throw new Error('Unsafe temporary replay path')
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function summarize(host: ReplayHost | undefined, scenario: ReplayScenario, journal: Journal, steps: number): ReplaySummary {
  const tickets = host?.store.tickets.list() ?? [], decisions = host?.decisions() ?? []
  const failedChecks = journal.checks.filter(check => !check.passed).length
  return {
    schemaVersion: 1, mode: 'offline-replay', scenario: scenario.name,
    ok: !journal.errors.length && !failedChecks && journal.checks.length === scenario.steps.filter(step => step.op === 'check').length,
    assurance: { real: ['Engine', 'settingsPolicy', 'assessmentOutcome', 'SQLite Store', 'Effects', 'Outbox'],
      stubbed: ['fixture assessment', 'fake executor', 'synthetic source/channel', 'synthetic PR'],
      doesNotProve: ['model quality', 'real GitHub acceptance', 'real CI or test execution', 'DSH session recovery', 'OS sandbox isolation'] },
    totals: { steps, checks: journal.checks.length, failedChecks, tickets: tickets.length, workersStarted: journal.workersStarted,
      assessmentRequests: journal.assessmentRequests, decisions: decisions.length, duplicates: journal.duplicates, sent: journal.messages.length,
      pendingEffects: host?.pendingEffects() ?? 0, wouldAccept: decisions.filter(item => item.audit?.would_accept === true).length, restarts: journal.recovery.length },
    checks: journal.checks,
    tickets: tickets.slice(0, SUMMARY_LIMITS.tickets).map(ticket => ({ id: ticket.id, origin: ticket.origin.triggerId, strength: ticket.mandate.strength,
      actor: ticket.mandate.actor.id, scope: ticket.mandate.scope, basis: ticket.mandate.basis.via, assignments: ticket.assignments.length,
      outcome: ticket.ended?.outcome ?? 'open', report: latestAssignment(ticket)?.report?.state ?? 'none',
      inputTriggers: ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : []).slice(0, 16) })),
    decisions: decisions.slice(0, SUMMARY_LIMITS.decisions).map(decision => ({ kind: decision.kind, triggerIds: decision.triggerIds.slice(0, 16),
      strength: decision.strength, reasons: decision.reason.map(reason => reason.code).slice(0, 16), wouldAccept: decision.audit?.would_accept === true })),
    reports: journal.reports.slice(0, SUMMARY_LIMITS.reports), messages: journal.messages.slice(0, SUMMARY_LIMITS.messages),
    recovery: journal.recovery.slice(0, SUMMARY_LIMITS.restarts), errors: journal.errors.slice(0, SUMMARY_LIMITS.errors),
    truncated: { tickets: Math.max(0, tickets.length - SUMMARY_LIMITS.tickets), decisions: Math.max(0, decisions.length - SUMMARY_LIMITS.decisions),
      reports: Math.max(0, journal.reports.length - SUMMARY_LIMITS.reports), messages: Math.max(0, journal.messages.length - SUMMARY_LIMITS.messages),
      restarts: Math.max(0, journal.recovery.length - SUMMARY_LIMITS.restarts), errors: Math.max(0, journal.errors.length - SUMMARY_LIMITS.errors) },
  }
}
