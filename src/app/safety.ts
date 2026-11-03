/** Durable operator halt and bounded scheduling budgets. These count admitted work, not model tokens or money. */
import { key } from '../core/ids.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

export interface SafetyLimits {
  maxWorkerSteps: number
  maxWorkerTurns: number
  inferredAdmissionsPerDay: number
}
export interface SafetyHalt {
  active: true
  generation: number
  at: string
  by: 'panel' | 'budget'
  reason: string
  phase: 'stopping' | 'halted'
  errors: string[]
}
export type SafetyStatus = { active: false; generation: number } | SafetyHalt
export interface WorkerUsage { steps: number; turns: number }
/** Only hashes of admitted positions are retained; a rejected position never grows the ledger. */
export interface WorkerStepLedger { positions: string[]; turns: string[] }
export type StepAdmission = { allowed: true; usage: WorkerUsage }
  | { allowed: false; reason: 'halted' | 'step-limit' | 'turn-limit'; usage: WorkerUsage }
export type InferredAdmission = { allowed: true; day: string; used: number }
  | { allowed: false; reason: 'halted' | 'daily-limit'; day: string; used: number }

/** A stale operator action or unfinished cleanup cannot release the halt latch. */
export class SafetyConflict extends Error {}
/** An operation requiring live processing was attempted while the durable halt latch was set. */
export class SafetyHalted extends Error {}

const MAX_BUDGET = 100_000, MAX_ID = 256, MAX_TEXT = 1000, MAX_ERRORS = 20
function integer(value: number, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Invalid ${name}`)
}
function identifier(value: string, name: string): void {
  if (typeof value !== 'string' || !value.length || value.length > MAX_ID) throw new TypeError(`Invalid ${name}`)
}
function text(value: string, name: string): void {
  if (typeof value !== 'string' || value.length > MAX_TEXT || !value.trim()) throw new TypeError(`Invalid ${name}`)
}
const totals = (ledger: WorkerStepLedger): WorkerUsage => ({ steps: ledger.positions.length, turns: ledger.turns.length })

/**
 * SQLite-backed halt latch and admission counters shared by a Runtime's scheduling gates.
 * Every mutation is synchronous and atomic: halt() returns only after its latch commits, so callers cancel work afterwards.
 * When nested in a caller's transaction, durability occurs at that outer commit; no cancellation belongs inside it.
 * Call admitStep only for the sessions the Host intends to budget (initially root Workers; nested agents are not implicit).
 * Call admitInferred inside the Engine's ticket-creation transaction so a later refusal rolls its reservation back too.
 */
export class Safety {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'atomic'>, private readonly limits: () => SafetyLimits,
    private readonly now: () => Date = () => new Date()) {}

  status(): SafetyStatus {
    const state = this.store.get(KV.safety.halt) ?? { active: false as const, generation: 0 }
    integer(state.generation, 'halt generation')
    if (typeof state.active !== 'boolean') throw new Error('Invalid durable halt state')
    if (state.active && (state.phase !== 'stopping' && state.phase !== 'halted'
      || !Array.isArray(state.errors) || state.errors.length > MAX_ERRORS)) throw new Error('Invalid durable halt state')
    return state
  }
  halted(): SafetyHalt | undefined { const state = this.status(); return state.active ? state : undefined }
  assertRunning(): void { if (this.halted()) throw new SafetyHalted('Processing is halted; only an operator may resume it') }

  /** Set the latch before the caller cancels/drains work. Re-entry preserves the first reason and generation. */
  halt(reason: string, by: 'panel' | 'budget' = 'panel'): SafetyHalt {
    text(reason, 'halt reason')
    if (by !== 'panel' && by !== 'budget') throw new TypeError('Invalid halt origin')
    return this.store.atomic(() => {
      const current = this.status()
      if (current.active) return current
      integer(current.generation + 1, 'halt generation')
      const halt: SafetyHalt = { active: true, generation: current.generation + 1, at: this.now().toISOString(),
        by, reason, phase: 'stopping', errors: [] }
      this.store.set(KV.safety.halt, halt)
      return halt
    })
  }
  /** Record cleanup completion; errors retain the latch and must be cleared by a successful cleanup retry. */
  settled(generation: number, errors: readonly string[] = []): SafetyHalt {
    integer(generation, 'halt generation')
    if (!Array.isArray(errors) || errors.length > MAX_ERRORS) throw new TypeError('Too many cleanup errors')
    for (const error of errors) text(error, 'cleanup error')
    return this.store.atomic(() => {
      const current = this.status()
      if (!current.active || current.generation !== generation) throw new SafetyConflict('Halt changed during cleanup')
      const halt: SafetyHalt = { ...current, phase: 'halted', errors: [...errors] }
      this.store.set(KV.safety.halt, halt)
      return halt
    })
  }
  /** Human-only CAS release, after successful cleanup; neither resumes nor resets any ticket budget itself. */
  resume(expectedGeneration: number, origin: 'panel'): boolean {
    integer(expectedGeneration, 'halt generation')
    if (origin !== 'panel') throw new SafetyConflict('Only the management panel may resume processing')
    return this.store.atomic(() => {
      const current = this.status()
      if (current.generation !== expectedGeneration) throw new SafetyConflict('Halt changed; reload before resuming')
      if (!current.active) return false
      if (current.phase !== 'halted' || current.errors.length) throw new SafetyConflict('Halt cleanup has not completed successfully')
      integer(current.generation + 1, 'halt generation')
      this.store.set(KV.safety.halt, { active: false, generation: current.generation + 1 })
      return true
    })
  }
  private configured(): SafetyLimits {
    const limits = this.limits()
    integer(limits.maxWorkerSteps, 'maxWorkerSteps', 1, MAX_BUDGET)
    integer(limits.maxWorkerTurns, 'maxWorkerTurns', 1, MAX_BUDGET)
    integer(limits.inferredAdmissionsPerDay, 'inferredAdmissionsPerDay', 0, MAX_BUDGET)
    return limits
  }
  private ledger(ticketId: string): WorkerStepLedger {
    identifier(ticketId, 'ticket id')
    const ledger = this.store.get(KV.safety.worker(key(ticketId))) ?? { positions: [], turns: [] }
    if (!Array.isArray(ledger.positions) || !Array.isArray(ledger.turns)
      || ledger.positions.length > MAX_BUDGET || ledger.turns.length > MAX_BUDGET) throw new Error('Invalid durable worker ledger')
    return ledger
  }
  usage(ticketId: string): WorkerUsage { return totals(this.ledger(ticketId)) }
  /** Bounded totals only, not the internal position hashes. */
  stepLedger(ticketId: string): WorkerUsage { return this.usage(ticketId) }

  /** Reserve one stable step; turns are unique by session+turn, including across retries and Runtime restarts. */
  admitStep(ticketId: string, position: { sessionId: string; turn: number; step: number }): StepAdmission {
    identifier(ticketId, 'ticket id'); identifier(position.sessionId, 'session id')
    integer(position.turn, 'turn'); integer(position.step, 'step')
    return this.store.atomic(() => {
      const ledger = this.ledger(ticketId), usage = totals(ledger)
      if (this.halted()) return { allowed: false, reason: 'halted', usage }
      const limits = this.configured()
      const identity = key(position.sessionId, String(position.turn), String(position.step))
      if (ledger.positions.includes(identity)) return { allowed: true, usage }
      if (usage.steps >= limits.maxWorkerSteps) return { allowed: false, reason: 'step-limit', usage }
      const turn = key(position.sessionId, String(position.turn)), newTurn = !ledger.turns.includes(turn)
      if (newTurn && usage.turns >= limits.maxWorkerTurns) return { allowed: false, reason: 'turn-limit', usage }
      ledger.positions.push(identity)
      if (newTurn) ledger.turns.push(turn)
      this.store.set(KV.safety.worker(key(ticketId)), ledger)
      return { allowed: true, usage: totals(ledger) }
    })
  }
  /** Count newly created inferred Tickets per UTC date. A Ticket keeps its first reservation even on later dates. */
  admitInferred(ticketId: string): InferredAdmission {
    identifier(ticketId, 'ticket id')
    return this.store.atomic(() => {
      const claimed = this.store.get(KV.safety.inferredTicket(key(ticketId)))
      const day = claimed?.day ?? this.now().toISOString().slice(0, 10)
      const used = this.store.get(KV.safety.inferredDay(day)) ?? 0
      integer(used, 'daily admissions', 0, MAX_BUDGET)
      if (this.halted()) return { allowed: false, reason: 'halted', day, used }
      const limits = this.configured()
      if (claimed) return { allowed: true, day, used }
      if (used >= limits.inferredAdmissionsPerDay) return { allowed: false, reason: 'daily-limit', day, used }
      this.store.set(KV.safety.inferredDay(day), used + 1)
      this.store.set(KV.safety.inferredTicket(key(ticketId)), { day })
      return { allowed: true, day, used: used + 1 }
    })
  }
}
