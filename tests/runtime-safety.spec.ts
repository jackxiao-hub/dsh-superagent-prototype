/** Host-enforced safety integration: actual Cordis pre-step waterfall, SQLite and managed Runtime lifecycle. */
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { Runtime } from '../src/app/runtime.ts'
import { SafetyConflict } from '../src/app/safety.ts'
import { key } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { reference } from './fixtures/deployment.ts'
import { deferred } from './fixtures/async.ts'

let h: Host | undefined
const host = () => h!
afterEach(async () => { vi.useRealTimers(); if (h) await h.stop(); h = undefined })
const agent = (id: string) => host().agents.get(id) as unknown as Agent
const admit = (id: string, turn: number, step: number, next = async () => ({ kind: 'enter' as const, messages: [] })) =>
  agentEvents(host().ctx, agent(id)).waterfall('agent/pre-step', { turn, step, messages: [], signal: new AbortController().signal }, next)
const denied = (id: string, name = 'bash') => host().guards.get(id)?.map(check => check({ name, arguments: {} })).find(Boolean)

it('selects a preset by resolved sandbox mode, disables approvals, and isolates the Router workspace', async () => {
  h = await startRuntime()
  const main = agent(h.runtime.masterId), services = h.services
  expect(services.permissionPresets.set).toHaveBeenCalledWith(main.session, 'restricted')
  expect(services.approval.setPolicy).toHaveBeenCalledWith(main, 'never')
  expect(services.workingDirectory.get(main.session as never)).toBe(join(h.directory, 'router-work'))
  // Simulate an old loaded Router still using the database directory, including a process launched there.
  await services.workingDirectory.set(main as never, h.directory)
  const job = h.jobs.run(main.id)
  await h.runtime.sessions.ensure(main.id, join(h.directory, 'router-work'), 'Router', 'orchestrator')
  expect(services.workingDirectory.set).toHaveBeenLastCalledWith(main, join(h.directory, 'router-work'), h.runtime.lifetime)
  expect(h.jobs.service.list(main.id).find(item => item.id === job)?.status).toBe('killed')
  expect(services.workingDirectory.get(main.session as never)).not.toBe(h.directory)
})

it('only applies full access after an explicit deployment opt-in', async () => {
  h = await startRuntime(undefined, { executionPermission: 'danger-full-access' })
  expect(h.services.permissionPresets.set).toHaveBeenCalledWith(agent(h.runtime.masterId).session, 'unrestricted')
  expect(h.services.approval.setPolicy).toHaveBeenCalledWith(agent(h.runtime.masterId), 'never')
})

it('admits exactly N root Worker steps through the real waterfall, then synchronously blocks tools and reports blocked', async () => {
  h = await startRuntime(undefined, { maxWorkerSteps: reference(2), maxWorkerTurns: reference(1) })
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix the bug'))
  expect(await admit(sessionId, 1, 1)).toMatchObject({ kind: 'enter' })
  expect(await admit(sessionId, 1, 1)).toMatchObject({ kind: 'enter' })
  expect(await admit(sessionId, 1, 2)).toMatchObject({ kind: 'enter' })
  expect(h.runtime.safety.usage(ticket.id)).toEqual({ steps: 2, turns: 1 })
  expect(await admit(sessionId, 1, 3)).toEqual({ kind: 'reject' })
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({ state: 'blocked', summary: expect.stringContaining('Root Worker scheduling budget') })
  expect(denied(sessionId)).toContain('budget')
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'bypass via raw executor' })).rejects.toThrow('budget')
  expect(h.runtime.safety.halted()).toBeUndefined()
  expect(h.runtime.safety.usage(ticket.id)).toEqual({ steps: 2, turns: 1 })
})

it('counts a recreated root Session separately using its durable createdAt without resetting the Ticket total', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  const old = agent(sessionId)
  await admit(sessionId, 0, 0)
  h.agents.delete(sessionId)
  const replacement = await h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, ticket.title, 'worker')
  expect(replacement.session.header.createdAt).not.toBe(old.session.header.createdAt)
  await admit(sessionId, 0, 0)
  expect(h.runtime.safety.usage(ticket.id)).toEqual({ steps: 2, turns: 2 })
})

it('does not consume a budget for a rejected downstream step and rechecks halt after an awaited listener', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  expect(await admit(sessionId, 1, 1, async () => ({ kind: 'reject' } as never))).toEqual({ kind: 'reject' })
  expect(h.runtime.safety.usage(ticket.id).steps).toBe(0)
  const gate = deferred(), entered = deferred()
  const proposed = admit(sessionId, 1, 1, async () => { entered.resolve(); await gate.promise; return { kind: 'enter', messages: [] } })
  await entered.promise
  const stop = h.runtime.emergencyStop('Stop during step admission')
  gate.resolve()
  expect(await proposed).toEqual({ kind: 'reject' })
  expect(h.runtime.safety.usage(ticket.id).steps).toBe(0)
  await stop
})

it('disables delegation at the Host guard by default when configured, rather than relying on prompt text', async () => {
  h = await startRuntime(undefined, { allowWorkerSubagents: false })
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  expect(denied(sessionId, 'subagent')).toContain('disabled')
  expect(denied(sessionId, 'send_message')).toContain('disabled')
  expect(denied(sessionId, 'bash')).toBeUndefined()
})

it('commits the latch before cancel, shares concurrent cleanup, kills root and descendant jobs and uses reversible child drains', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  const root = agent(h.runtime.masterId), worker = agent(sessionId)
  const child = h.subagents.spawn(sessionId), grandchild = h.subagents.spawn(child)
  h.jobs.run(root.id); h.jobs.run(worker.id); h.jobs.run(child); h.jobs.run(grandchild)
  const cancel = vi.mocked(worker.cancel), original = cancel.getMockImplementation()!
  cancel.mockImplementation((...args) => { expect(h!.runtime.safety.halted()?.active).toBe(true); return original(...args) })
  const first = h.runtime.emergencyStop('Operator stop'), again = h.runtime.emergencyStop('A different reason')
  expect(first).toBe(again)
  const stopped = await first
  expect(stopped).toMatchObject({ active: true, reason: 'Operator stop', phase: 'halted', errors: [] })
  expect(h.subagents.service.drainDescendants).not.toHaveBeenCalled()
  expect(h.subagents.service.drainChildren).toHaveBeenCalled()
  expect(h.subagents.live(child)).toBe(false); expect(h.subagents.live(grandchild)).toBe(false)
  for (const id of [root.id, worker.id, child, grandchild]) expect(h.jobs.service.list(id).every(job => job.status !== 'running')).toBe(true)
  expect(root.status).toBe('idle'); expect(worker.status).toBe('idle')
  expect(denied(root.id)).toContain('halted')
})

it('kills jobs owned by a known Worker Session even after its Agent was unloaded', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  const job = h.jobs.run(sessionId)
  h.agents.delete(sessionId)
  const halt = await h.runtime.emergencyStop('Stop orphaned worker jobs')
  expect(halt.errors).toEqual([])
  expect(h.jobs.service.list(sessionId).find(item => item.id === job)?.status).toBe('killed')
})

it('retains intake and relays while halted without model wakeups and does not revive a person-stopped Ticket on resume', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  h.runtime.engine.stopTicket(ticket.id)
  const count = h.runtime.store.tickets.get(ticket.id)!.assignments.length
  const halt = await h.runtime.emergencyStop('Stop')
  h.deliveries.mockClear()
  const incoming = feishu('2', '@bot another task')
  h.runtime.receive(incoming); h.runtime.sessions.relay('while-halted', 'Do not wake')
  h.runtime.sessions.notify('while-halted', { value: true }, 'held notice')
  await h.runtime.idle()
  expect(h.runtime.store.triggers.get(incoming.id)).toBeDefined()
  expect(h.deliveries).not.toHaveBeenCalled()
  expect(h.runtime.effects.pending('relay', 'while-halted')).toBe(true)
  expect(h.runtime.effects.pending('notice', 'while-halted')).toBe(true)
  await expect(h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [] })).rejects.toThrow('halted')
  expect(await h.runtime.resumeSafety(halt.generation)).toBe(true)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: { by: 'human' } })
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(count)
  expect(h.runtime.safety.status()).toEqual({ active: false, generation: halt.generation + 1 })
})

it('keeps a durable halt across a complete Runtime restart without automatically reconciling workers', async () => {
  h = await startRuntime()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  const halt = await h.runtime.emergencyStop('Persistent operator stop')
  await h.runtime.stop()
  const ctx = new Context()
  for (const [name, service] of Object.entries(h.services)) ctx.reflect.provide(name, service)
  const next = new Runtime(ctx, h.machine, vi.fn())
  try {
    await next.ready
    expect(next.safety.halted()).toMatchObject({ generation: halt.generation, phase: 'halted', errors: [] })
    expect(next.store.tickets.get(ticket.id)!.assignments).toHaveLength(ticket.assignments.length)
    expect(agent(`worker-${ticket.id}`).status).toBe('idle')
  } finally { await next.stop() }
})

it('refuses recovery while an external provider child is running without a local Agent', async () => {
  h = await startRuntime()
  const root = h.runtime.masterId
  Object.assign(h.subagents.service, {
    listChildren: vi.fn(async (id: string) => id === root ? [{ id: 'external-child', mode: 'external', createdAt: 1 }] : []),
    drainChildren: vi.fn(async () => {}),
    listDescendants: vi.fn(async () => [{ kind: 'child', id: 'external-child', mode: 'external', activity: 'running', hasChildren: false, parentId: root, depth: 1 }]),
  })
  const halt = await h.runtime.emergencyStop('Stop external work')
  expect(halt.errors.join(' ')).toContain('external-child')
  await expect(h.runtime.resumeSafety(halt.generation)).rejects.toThrow(SafetyConflict)
  h.subagents.service.listDescendants.mockResolvedValue([])
  const cleaned = await h.runtime.emergencyStop('Retry cleanup')
  expect(cleaned.errors).toEqual([])
})

it('queries activity for a previously started but unloaded Worker and conservatively retains halt for its external child', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  h.agents.delete(sessionId)
  const descendants = vi.fn(async (root: string) => root === sessionId
    ? [{ kind: 'child', id: 'offline-parent-external', mode: 'external', activity: 'running', hasChildren: false, parentId: root, depth: 1 }] : [])
  Object.assign(h.subagents.service, { listDescendants: descendants })
  const halt = await h.runtime.emergencyStop('Stop an unloaded worker forest')
  expect(descendants).toHaveBeenCalledWith(sessionId, expect.any(AbortSignal))
  expect(halt.errors.join(' ')).toContain('offline-parent-external')
  await expect(h.runtime.resumeSafety(halt.generation)).rejects.toThrow(SafetyConflict)
})

it('retains timed-out raw cleanup and fences it before any later cancellation, retry or recovery', async () => {
  h = await startRuntime()
  const root = agent(h.runtime.masterId), gate = deferred()
  const idle = vi.spyOn(h.runtime.effects, 'idle').mockReturnValue(gate.promise)
  vi.useFakeTimers()
  const stop = h.runtime.emergencyStop('Slow in-flight effect')
  await vi.advanceTimersByTimeAsync(15_001)
  const timedOut = await stop
  expect(timedOut.errors.join(' ')).toContain('timed out')
  const cancellations = vi.mocked(root.cancel).mock.calls.length, idleCalls = idle.mock.calls.length
  expect(await h.runtime.emergencyStop('Retry while raw call is pending')).toEqual(timedOut)
  expect(idle).toHaveBeenCalledTimes(idleCalls)
  await expect(h.runtime.resumeSafety(timedOut.generation)).rejects.toThrow('still running')
  idle.mockRestore(); gate.resolve()
  await vi.waitFor(() => expect((h!.runtime as unknown as { safetyCleanup?: Promise<unknown> }).safetyCleanup).toBeUndefined())
  expect(vi.mocked(root.cancel).mock.calls.length).toBe(cancellations)
  const cleaned = await h.runtime.emergencyStop('Actual cleanup retry')
  expect(cleaned.errors).toEqual([])
  await h.runtime.resumeSafety(cleaned.generation)
  vi.mocked(root.cancel).mockClear()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(root.cancel).not.toHaveBeenCalled()
})

it('tracks the actual pending child drain beyond its reporting timeout and requires a fresh quiet cleanup before recovery', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot fix it'))
  const child = h.subagents.spawn(sessionId), entered = deferred(), gate = deferred()
  const drain = h.subagents.service.drainChildren, original = drain.getMockImplementation()!
  drain.mockImplementation(async (parent, ids) => { entered.resolve(); await gate.promise; await original(parent, ids) })
  vi.useFakeTimers()
  try {
    const stop = h.runtime.emergencyStop('Slow provider disposal')
    await entered.promise
    await vi.advanceTimersByTimeAsync(15_001)
    const timedOut = await stop
    expect(timedOut.errors.join(' ')).toContain('timed out')
    expect(h.subagents.live(child)).toBe(true)
    await expect(h.runtime.resumeSafety(timedOut.generation)).rejects.toThrow('still running')
    const attempts = drain.mock.calls.length
    await h.runtime.emergencyStop('No overlapping provider disposal')
    expect(drain).toHaveBeenCalledTimes(attempts)
    gate.resolve()
    await vi.waitFor(() => expect((h!.runtime as unknown as { safetyCleanup?: Promise<unknown> }).safetyCleanup).toBeUndefined())
    expect(h.runtime.safety.halted()?.errors.length).toBeGreaterThan(0)
    await expect(h.runtime.resumeSafety(timedOut.generation)).rejects.toThrow(SafetyConflict)
    const cleaned = await h.runtime.emergencyStop('Confirm quiet after provider completed')
    expect(cleaned.errors).toEqual([])
    expect(await h.runtime.resumeSafety(cleaned.generation)).toBe(true)
  } finally { gate.resolve() }
})

it('aborts an in-flight Host prepare command, retains its pending launch and restarts it only after operator recovery', async () => {
  h = await startRuntime()
  const settings = h.runtime.store.settings(), gate = deferred()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'prepare-a-workspace' } })
  h.hooks.prepare = gate.promise
  const trigger = feishu('1', '@bot fix it')
  h.runtime.receive(trigger); await h.runtime.idle()
  const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix it', worktree_name: 'fix-it', acknowledgement: '收到，修复。' })
  const id = (result.ticket as { ticket_id: string }).ticket_id
  await vi.waitFor(() => expect(h!.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.includes('prepare-a-workspace'))).toBe(true))
  const prepare = h.subprocess.spawn.mock.calls.find(([spec]) => spec.argv.includes('prepare-a-workspace'))![0]
  const stopped = await h.runtime.emergencyStop('Stop preparing')
  expect(prepare.signal?.aborted).toBe(true)
  expect(stopped.errors).toEqual([])
  expect(h.runtime.store.tickets.get(id)?.assignments.at(-1)).toMatchObject({ state: 'pending' })
  expect(h.agents.has(`worker-${id}`)).toBe(false)
  gate.resolve()
  await h.runtime.resumeSafety(stopped.generation)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(id)?.assignments.at(-1)).toMatchObject({ state: 'running' })
})

it('reserves inferred admissions inside ticket creation, rolling back rejection before acknowledgements or launch', async () => {
  h = await startRuntime(undefined, { inferredAdmissionsPerDay: reference(0) })
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    rules: [{ id: 'copy', name: 'Copy', instruction: 'Fix copy', enabled: true }] } })
  const incoming = feishu('1', 'replace subtitle with browser', { mentions: [] })
  h.runtime.receive(incoming); await h.runtime.idle()
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: incoming.id })
  const decide = () => h!.runTool(h!.runtime.masterId, 'orchestrator_eval_decide', { trigger_id: incoming.id,
    decision: 'accept', title: 'Fix copy', worktree_name: 'copy-fix', scope: 'copy', reason: 'clear change', intent_evidence: 'quoted',
    acknowledgement: '收到，修正文案。', rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy change' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'the message specifies replacement' } })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_1', chat_id: 'oc_team' }] })
  await expect(decide()).rejects.toThrow('daily-limit')
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.replyStatus(key('ack', incoming.id))).toBeUndefined()
  expect(h.runtime.store.keys(KV.safety.inferredTicket)).toEqual([])
  ;(h.machine.inferredAdmissionsPerDay as ReturnType<typeof reference<number>>).set(1)
  expect(await decide()).toMatchObject({ decision: 'accept' })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.runtime.store.keys(KV.safety.inferredTicket)).toHaveLength(1)
})
