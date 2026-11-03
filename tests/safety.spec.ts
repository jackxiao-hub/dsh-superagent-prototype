/** Real SQLite coverage for durable halt and bounded scheduling admissions, independent of the Agent loop. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Safety, SafetyConflict, SafetyHalted, type SafetyLimits } from '../src/app/safety.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

let directory: string, path: string, store: Store, safety: Safety, limits: SafetyLimits, time: Date
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-safety-'))
  path = join(directory, 'orchestrator.sqlite')
  limits = { maxWorkerSteps: 3, maxWorkerTurns: 2, inferredAdmissionsPerDay: 2 }
  time = new Date('2026-11-02T23:59:59.000Z')
  store = new Store(path)
  safety = new Safety(store, () => limits, () => time)
})
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }) })
function reopen(): void {
  store.close(); store = new Store(path)
  safety = new Safety(store, () => limits, () => time)
}
const step = (turn: number, number: number, sessionId = 'worker-one') => ({ sessionId, turn, step: number })
const rows = () => Number(store.db.prepare("SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'safety-%'").get()!.count)

it('commits the halt before cancellation, keeps the first reason on re-entry, and survives a real Store reopen', () => {
  expect(safety.status()).toEqual({ active: false, generation: 0 })
  expect(safety.halted()).toBeUndefined()
  const halt = safety.halt('Operator emergency stop')
  // An independent connection sees the committed latch before a caller would cancel any Agent or job.
  const observer = new Store(path)
  try { expect(new Safety(observer, () => limits).halted()).toEqual(halt) } finally { observer.close() }
  expect(halt).toEqual({ active: true, generation: 1, at: time.toISOString(), by: 'panel',
    reason: 'Operator emergency stop', phase: 'stopping', errors: [] })
  expect(safety.halt('Budget limit', 'budget')).toEqual(halt)
  expect(() => safety.assertRunning()).toThrow(SafetyHalted)
  reopen()
  expect(safety.halted()).toEqual(halt)
})

it('requires completed cleanup, no errors, a current generation and panel origin to resume', () => {
  const halt = safety.halt('Stop')
  expect(() => safety.resume(halt.generation, 'panel')).toThrow(SafetyConflict)
  safety.settled(halt.generation, ['A job has not stopped'])
  expect(() => safety.resume(halt.generation, 'panel')).toThrow(SafetyConflict)
  reopen()
  expect(safety.halted()).toMatchObject({ phase: 'halted', errors: ['A job has not stopped'] })
  safety.settled(halt.generation)
  expect(() => safety.resume(halt.generation, 'tool' as 'panel')).toThrow(SafetyConflict)
  expect(() => safety.resume(halt.generation + 1, 'panel')).toThrow(SafetyConflict)
  expect(safety.resume(halt.generation, 'panel')).toBe(true)
  expect(safety.status()).toEqual({ active: false, generation: 2 })
  expect(safety.resume(2, 'panel')).toBe(false)
  expect(() => safety.resume(halt.generation, 'panel')).toThrow(SafetyConflict)
  expect(() => safety.assertRunning()).not.toThrow()
  const next = safety.halt('Stop again')
  expect(next.generation).toBe(3)
  expect(() => safety.settled(halt.generation)).toThrow(SafetyConflict)
  expect(() => safety.resume(halt.generation, 'panel')).toThrow(SafetyConflict)
  expect(safety.halted()).toEqual(next)
})

it('allows exactly N steps, deduplicates stable positions and retains totals across restarts and sessions', () => {
  expect(safety.usage('one')).toEqual({ steps: 0, turns: 0 })
  expect(safety.admitStep('one', step(0, 0))).toEqual({ allowed: true, usage: { steps: 1, turns: 1 } })
  expect(safety.admitStep('one', step(0, 0))).toEqual({ allowed: true, usage: { steps: 1, turns: 1 } })
  expect(safety.admitStep('one', step(0, 1))).toMatchObject({ allowed: true, usage: { steps: 2, turns: 1 } })
  reopen()
  expect(safety.admitStep('one', step(0, 0, 'another-session'))).toEqual({ allowed: true, usage: { steps: 3, turns: 2 } })
  const count = rows()
  expect(safety.admitStep('one', step(0, 2))).toEqual({ allowed: false, reason: 'step-limit', usage: { steps: 3, turns: 2 } })
  expect(rows()).toBe(count)
  expect(safety.stepLedger('one')).toEqual({ steps: 3, turns: 2 })
  // At capacity, an admitted position remains idempotent, but another Ticket has its own budget.
  expect(safety.admitStep('one', step(0, 1))).toMatchObject({ allowed: true })
  expect(safety.admitStep('two', step(0, 0))).toMatchObject({ allowed: true, usage: { steps: 1, turns: 1 } })
})

it('counts turns per session+turn without charging steps that a turn limit refuses', () => {
  limits = { ...limits, maxWorkerSteps: 10, maxWorkerTurns: 1 }
  expect(safety.admitStep('one', step(1, 1))).toMatchObject({ allowed: true })
  expect(safety.admitStep('one', step(2, 1))).toEqual({ allowed: false, reason: 'turn-limit', usage: { steps: 1, turns: 1 } })
  expect(safety.admitStep('one', step(1, 1, 'another-session'))).toMatchObject({ allowed: false, reason: 'turn-limit' })
  expect(safety.admitStep('one', step(1, 2))).toEqual({ allowed: true, usage: { steps: 2, turns: 1 } })
  expect(safety.usage('one')).toEqual({ steps: 2, turns: 1 })
})

it('shares atomic budget reservations across independent Safety instances', () => {
  const other = new Safety(store, () => limits, () => time)
  const admissions = [safety, other, safety, other].map((service, index) => service.admitStep('one', step(1, index)))
  expect(admissions.map(admission => admission.allowed)).toEqual([true, true, true, false])
  expect(other.usage('one')).toEqual({ steps: 3, turns: 1 })
})

it('refuses all admissions while halted and never resets budgets on resume', () => {
  safety.admitStep('one', step(1, 1)); safety.admitInferred('one')
  const halt = safety.halt('Stop'), count = rows()
  expect(safety.admitStep('one', step(1, 1))).toMatchObject({ allowed: false, reason: 'halted' })
  expect(safety.admitStep('two', step(1, 1))).toMatchObject({ allowed: false, reason: 'halted' })
  expect(safety.admitInferred('one')).toMatchObject({ allowed: false, reason: 'halted' })
  expect(safety.admitInferred('two')).toMatchObject({ allowed: false, reason: 'halted' })
  expect(rows()).toBe(count)
  safety.settled(halt.generation); safety.resume(halt.generation, 'panel')
  expect(safety.usage('one')).toEqual({ steps: 1, turns: 1 })
  expect(safety.admitInferred('one')).toEqual({ allowed: true, day: '2026-11-02', used: 1 })
})

it('counts inferred Tickets once per UTC day, includes no failed admission, and makes zero disable new admissions', () => {
  expect(safety.admitInferred('one')).toEqual({ allowed: true, day: '2026-11-02', used: 1 })
  expect(safety.admitInferred('one')).toEqual({ allowed: true, day: '2026-11-02', used: 1 })
  expect(safety.admitInferred('two')).toEqual({ allowed: true, day: '2026-11-02', used: 2 })
  const count = rows()
  expect(safety.admitInferred('three')).toEqual({ allowed: false, reason: 'daily-limit', day: '2026-11-02', used: 2 })
  expect(rows()).toBe(count)
  reopen()
  time = new Date('2026-11-03T00:00:00.000Z')
  expect(safety.admitInferred('three')).toEqual({ allowed: true, day: '2026-11-03', used: 1 })
  // A retry on a later day is not a newly created Ticket and consumes nothing from today's quota.
  expect(safety.admitInferred('one')).toEqual({ allowed: true, day: '2026-11-02', used: 2 })
  expect(store.get(KV.safety.inferredDay('2026-11-03'))).toBe(1)
  limits = { ...limits, inferredAdmissionsPerDay: 0 }
  expect(safety.admitInferred('four')).toMatchObject({ allowed: false, reason: 'daily-limit' })
})

it('uses UTC calendar dates rather than the input Date offset', () => {
  time = new Date('2026-11-03T00:30:00+08:00')
  expect(safety.admitInferred('one')).toMatchObject({ day: '2026-11-02' })
  time = new Date('2026-11-03T08:00:00+08:00')
  expect(safety.admitInferred('two')).toMatchObject({ day: '2026-11-03', used: 1 })
})

it('rolls back halt, worker positions and inferred reservations with an enclosing Engine transaction', () => {
  expect(() => store.atomic(() => {
    safety.admitStep('one', step(1, 1)); safety.admitInferred('one'); safety.halt('Stop')
    throw new Error('Ticket creation failed')
  })).toThrow('Ticket creation failed')
  expect(safety.status()).toEqual({ active: false, generation: 0 })
  expect(safety.usage('one')).toEqual({ steps: 0, turns: 0 })
  expect(rows()).toBe(0)
  expect(safety.admitInferred('one')).toMatchObject({ allowed: true, used: 1 })
})

it('rolls back the daily count if writing its ticket claim fails', () => {
  const write = store.set.bind(store)
  const fail = vi.spyOn(store, 'set').mockImplementation((name, value) => {
    if (name.startsWith(KV.safety.inferredTicket.prefix)) throw new Error('Disk failure')
    write(name, value)
  })
  expect(() => safety.admitInferred('one')).toThrow('Disk failure')
  expect(rows()).toBe(0)
  fail.mockRestore()
  expect(safety.admitInferred('one')).toMatchObject({ allowed: true, used: 1 })
})

it('rejects invalid identifiers, unsafe counters and excessive limits without growing durable data', () => {
  for (const ticket of ['', 'x'.repeat(257)]) {
    expect(() => safety.admitInferred(ticket)).toThrow(TypeError)
    expect(() => safety.admitStep(ticket, step(0, 0))).toThrow(TypeError)
  }
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => safety.admitStep('one', step(value, 0))).toThrow(TypeError)
    expect(() => safety.admitStep('one', step(0, value))).toThrow(TypeError)
  }
  expect(() => safety.admitStep('one', step(0, 0, 'x'.repeat(257)))).toThrow(TypeError)
  expect(() => safety.halt('x'.repeat(1001))).toThrow(TypeError)
  limits = { ...limits, maxWorkerSteps: 100_001 }
  expect(() => safety.admitStep('one', step(0, 0))).toThrow(TypeError)
  limits = { ...limits, maxWorkerSteps: 0 }
  expect(() => safety.admitStep('one', step(0, 0))).toThrow(TypeError)
  limits = { ...limits, maxWorkerSteps: 1, inferredAdmissionsPerDay: -1 }
  expect(() => safety.admitInferred('one')).toThrow(TypeError)
  expect(rows()).toBe(0)
})

it('stores one bounded ledger per Ticket and nothing for thousands of over-budget positions or inferred attempts', () => {
  limits = { maxWorkerSteps: 1, maxWorkerTurns: 1, inferredAdmissionsPerDay: 0 }
  expect(safety.admitStep('one', step(0, 0))).toMatchObject({ allowed: true })
  for (let index = 1; index <= 2000; index++) {
    expect(safety.admitStep('one', step(index, index, `session-${index}`)).allowed).toBe(false)
    expect(safety.admitInferred(`ticket-${index}`).allowed).toBe(false)
  }
  expect(rows()).toBe(1)
  const ledger = store.get(store.keys(KV.safety.worker)[0]!)!
  expect(ledger.positions).toHaveLength(1)
  expect(ledger.turns).toHaveLength(1)
  expect(JSON.stringify(ledger).length).toBeLessThan(150)
})
