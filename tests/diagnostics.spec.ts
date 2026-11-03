import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { Safety } from '../src/app/safety.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import type { Decision, Ticket } from '../src/core/index.ts'
import { diagnose, diagnosticExitCode, diagnosticTime, SUPPORTED_DIAGNOSTICS_SCHEMA } from '../src/diagnostics/index.ts'
import { runDoctorCli } from '../src/diagnostics/cli.ts'

const AS_OF = '2026-11-03T12:00:00.000Z'
const SECRET = 'SECRET-do-not-print-token-account-message-operator-reason'
const at = (offset: number) => new Date(Date.parse(AS_OF) + offset).toISOString()
const directories: string[] = []
const stores = new Set<Store>()
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'dsh-doctor-spec-'))
  directories.push(path)
  return path
}
function fixture(saved = true) {
  const stateDir = directory(), path = join(stateDir, 'orchestrator.sqlite'), store = new Store(path)
  stores.add(store)
  if (saved) store.saveSettings({ sources: { offline: { config: { token: SECRET, endpoint: `https://secret.invalid/${SECRET}` } } },
    eval: { mode: 'observe', model: { provider: SECRET, model: SECRET, reasoningEffort: 'high' } } })
  const safety = new Safety(store, () => ({ maxWorkerSteps: 10, maxWorkerTurns: 10, inferredAdmissionsPerDay: 10 }), () => new Date(AS_OF))
  return {
    stateDir, path, store, safety,
    close(consistentBackup = true) {
      // Fixture writer prepares a standalone DELETE-journal database. Doctor never checkpoints or changes journal mode.
      if (consistentBackup) store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE')
      store.close(); stores.delete(store)
    },
  }
}
function snapshot(path: string) { return { bytes: readFileSync(path), mtime: statSync(path).mtimeMs, mode: statSync(path).mode } }
function decision(id: string, time: string, strength: Decision['strength'], kind: Decision['kind'] = 'ignore', wouldAccept = false): Decision {
  return { id, evalId: `eval-${id}`, threadKey: `offline:${SECRET}`, triggerIds: [SECRET], policyVersion: SECRET, at: time, kind,
    reason: [{ code: 'said', values: { text: SECRET } }], strength, audit: { would_accept: wouldAccept, secret: SECRET } }
}
function ticket(id: string, state: 'pending' | 'running' | 'stopped' | 'completed'): Ticket {
  return { id, title: SECRET, decisionId: SECRET,
    mandate: { strength: 'explicit', policyVersion: SECRET, basis: { via: 'listed' }, actor: { source: 'offline', id: SECRET }, scope: SECRET },
    channels: [{ source: 'offline', thread: SECRET, address: { token: SECRET } }],
    assignments: [{ id: `assignment-${id}`, state: state === 'pending' || state === 'running' ? state : 'ended', createdAt: at(-1000) }],
    inputs: [], undelivered: [], createdAt: at(-1000), updatedAt: at(-1000), origin: { triggerId: SECRET, triggerIds: [SECRET] },
    ...state === 'stopped' ? { ended: { at: at(-1000), by: 'human' as const, outcome: 'stopped' as const, reason: SECRET } }
      : state === 'completed' ? { ended: { at: at(-1000), by: 'executor' as const, outcome: 'completed' as const } } : {},
  }
}
function richFixture() {
  const f = fixture()
  for (const state of ['pending', 'running', 'stopped', 'completed'] as const) f.store.tickets.save(ticket(state, state))
  for (const value of [
    decision('explicit', at(-3_600_000), 'explicit', 'accept'), decision('inferred', at(-7_200_000), 'inferred', 'accept'),
    decision('observed', at(-10_800_000), 'inferred', 'ignore', true), decision('boundary-start', at(-86_400_000), 'inferred', 'ignore', true),
    decision('boundary-end', AS_OF, 'explicit'), decision('too-old', at(-86_400_001), 'inferred', 'ignore', true),
    decision('future', at(1), 'inferred', 'ignore', true),
  ]) f.store.decisions.save(value)
  f.store.triggers.save({ id: SECRET, source: 'offline', threads: [{ source: 'offline', id: SECRET }], actor: { source: 'offline', id: SECRET },
    human: true, at: AS_OF, text: SECRET, meta: { credential: SECRET } })
  const queue = new Effects(f.store, new HealthBoard(), () => Date.parse(at(-120_000)))
  queue.enqueue('assessment', SECRET, { triggerId: SECRET })
  queue.enqueue('reply', 'failed-reply', {})
  f.store.db.prepare('UPDATE effect SET attempts = 3, error = ? WHERE key = ?').run(SECRET, 'failed-reply')
  for (const status of ['pending', 'sent', 'dropped'] as const) {
    const message = { id: status, channel: { source: 'offline', thread: SECRET, address: { token: SECRET } }, text: SECRET, kind: 'notice' as const }
    f.store.receipts.add(message)
    if (status !== 'pending') f.store.receipts.settle(message, status === 'sent' ? 'sent' : 'channelGone')
  }
  return f
}
function cli(args: string[]) {
  let output = ''
  const code = runDoctorCli(args, text => { output += text })
  return { code, output, json: () => JSON.parse(output) as Record<string, unknown> }
}

describe('read-only production SQLite diagnostics', () => {
  it('matches the current Store schema and reads a healthy consistent database without changing bytes, mtime, mode or files', () => {
    expect(SUPPORTED_DIAGNOSTICS_SCHEMA).toBe(SCHEMA_VERSION)
    const f = fixture(); f.close()
    const before = snapshot(f.path), files = readdirSync(f.stateDir)
    const report = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
    expect(report.ok).toBe(true)
    expect(diagnosticExitCode(report)).toBe(0)
    expect(report.state).toEqual({ databaseSchema: 11, halt: { active: false, generation: 0, phase: 'running', errorCount: 0 },
      settings: { saved: true, paused: false, evalMode: 'observe' } })
    expect(report.counts?.effects).toEqual({ pending: 0, failed: 0, oldestAgeSeconds: null })
    expect(snapshot(f.path)).toEqual(before)
    expect(readdirSync(f.stateDir)).toEqual(files)
  })

  it('reports production defaults when no settings snapshot or safety latch was saved', () => {
    const f = fixture(false); f.close()
    expect(diagnose({ stateDir: f.stateDir, asOf: AS_OF }).state.settings).toEqual({ saved: false, paused: false, evalMode: 'observe' })
  })

  it('aggregates tickets, queue age/failures, pending/sent/dropped receipts and the exact last-24h observation window', () => {
    const f = richFixture(); f.close()
    const report = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
    expect(report.status).toBe('blocked')
    expect(diagnosticExitCode(report)).toBe(2)
    expect(report.counts).toEqual({
      records: { triggers: 1, threads: 0, tickets: 4, decisions: 7, receipts: 3 },
      tickets: { open: 2, running: 1, personStopped: 1 }, effects: { pending: 2, failed: 1, oldestAgeSeconds: 120 },
      receipts: { pending: 1, sent: 1, dropped: 1 },
      decisions24h: { total: 5, explicit: 2, inferred: 3, wouldAccept: 2, acceptedExplicit: 1, acceptedInferred: 1 },
    })
    expect(report.checks).toContainEqual({ id: 'effect_delivery', status: 'hold', code: 'retrying_effects_require_review' })
  })

  it('treats operator halt and pause as held, exposing only generation/phase/error count and never releasing the latch', () => {
    const f = fixture()
    f.store.saveSettings({ ...f.store.settings(), paused: true })
    const halt = f.safety.halt(SECRET)
    f.safety.settled(halt.generation, [SECRET])
    f.close()
    const before = snapshot(f.path)
    const report = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
    expect(report.status).toBe('operator-held')
    expect(report.ok).toBe(false)
    expect(diagnosticExitCode(report)).toBe(2)
    expect(report.state.halt).toEqual({ active: true, generation: 1, phase: 'halted', errorCount: 1 })
    expect(report.state.settings?.paused).toBe(true)
    expect(snapshot(f.path)).toEqual(before)
    expect(diagnose({ stateDir: f.stateDir, asOf: AS_OF }).state.halt).toEqual(report.state.halt)
  })

  it('can observe a live WAL snapshot when both existing sidecars are present, without changing the main database', () => {
    const f = richFixture()
    expect(existsSync(`${f.path}-wal`)).toBe(true)
    expect(existsSync(`${f.path}-shm`)).toBe(true)
    const before = snapshot(f.path), files = readdirSync(f.stateDir)
    const report = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
    expect(report.counts?.tickets.running).toBe(1)
    expect(report.counts?.decisions24h.wouldAccept).toBe(2)
    expect(snapshot(f.path)).toEqual(before)
    expect(readdirSync(f.stateDir)).toEqual(files)
    expect(report.assurance.walSidecarsMayBeUsed).toBe(true)
  })

  it('refuses a WAL-mode file with missing sidecars before SQLite could create them', () => {
    const f = fixture(); f.close(false)
    expect(readFileSync(f.path)[18]).toBe(2)
    expect(existsSync(`${f.path}-wal`)).toBe(false)
    expect(existsSync(`${f.path}-shm`)).toBe(false)
    const before = snapshot(f.path), files = readdirSync(f.stateDir)
    const report = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
    expect(report.status).toBe('blocked')
    expect(diagnosticExitCode(report)).toBe(2)
    expect(report.checks).toContainEqual({ id: 'database', status: 'hold', code: 'wal_snapshot_required' })
    expect(report.counts).toBeNull()
    expect(snapshot(f.path)).toEqual(before)
    expect(readdirSync(f.stateDir)).toEqual(files)
  })

  it('fails closed on old/new schemas without creating, migrating or checkpointing anything', () => {
    for (const version of [10, 12]) {
      const f = fixture(); f.store.set(KV.store.schema, version); f.close()
      const before = snapshot(f.path), files = readdirSync(f.stateDir)
      const report = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
      expect(diagnosticExitCode(report)).toBe(2)
      expect(report.state.databaseSchema).toBe(version)
      expect(report.checks).toContainEqual({ id: 'schema', status: 'hold', code: 'unsupported_schema_no_migration' })
      expect(report.counts).toBeNull()
      expect(snapshot(f.path)).toEqual(before)
      expect(readdirSync(f.stateDir)).toEqual(files)
    }
  })

  it('never creates a missing directory/database and rejects a directory in place of the database', () => {
    const root = directory(), missing = join(root, SECRET, 'absent')
    const report = diagnose({ stateDir: missing, asOf: AS_OF })
    expect(diagnosticExitCode(report)).toBe(1)
    expect(existsSync(join(root, SECRET))).toBe(false)
    expect(readdirSync(root)).toEqual([])
    const stateDir = directory()
    expect(diagnosticExitCode(diagnose({ stateDir, asOf: AS_OF }))).toBe(1)
    expect(readdirSync(stateDir)).toEqual([])
    mkdirSync(join(stateDir, 'orchestrator.sqlite'))
    const wrongType = diagnose({ stateDir, asOf: AS_OF })
    expect(diagnosticExitCode(wrongType)).toBe(1)
    expect(wrongType.checks).toContainEqual({ id: 'database', status: 'fail', code: 'database_not_regular' })
    expect(readdirSync(stateDir)).toEqual(['orchestrator.sqlite'])
  })

  it('reports corrupted files and malformed stored JSON as failures, without leaking native error text', () => {
    const stateDir = directory(), path = join(stateDir, 'orchestrator.sqlite')
    writeFileSync(path, SECRET.repeat(20))
    const before = snapshot(path), files = readdirSync(stateDir)
    const damaged = diagnose({ stateDir, asOf: AS_OF })
    expect(diagnosticExitCode(damaged)).toBe(1)
    expect(JSON.stringify(damaged)).not.toContain(SECRET)
    expect(JSON.stringify(damaged)).not.toContain(stateDir)
    expect(snapshot(path)).toEqual(before)
    expect(readdirSync(stateDir)).toEqual(files)
    const f = fixture(); f.store.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('invalid-record', `{${SECRET}`); f.close()
    const malformed = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
    expect(diagnosticExitCode(malformed)).toBe(1)
    expect(malformed.checks).toContainEqual({ id: 'records', status: 'fail', code: 'records_inspection_failed' })
  })

  it('is deterministic, bounded and aggregate-only even when stored messages/settings/halt/errors contain secrets', () => {
    const f = richFixture(), latch = f.safety.halt(SECRET)
    f.safety.settled(latch.generation, [SECRET])
    f.close()
    const first = diagnose({ stateDir: f.stateDir, asOf: AS_OF }), second = diagnose({ stateDir: f.stateDir, asOf: AS_OF })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    const output = JSON.stringify(first)
    expect(output).not.toContain(SECRET)
    expect(output).not.toContain(f.stateDir)
    expect(output).not.toContain('https://secret.invalid')
    expect(output).not.toContain('triggerIds')
    expect(output.length).toBeLessThan(6000)
    expect(first.checks.length).toBeLessThanOrEqual(first.limits.maxChecks)
    expect(first.assurance).toMatchObject({ readOnlyConnection: true, applicationWrites: false, autoHealing: false, semanticQuality: false, tokenBudgetProof: false, osIsolationProof: false })
  })

  it('validates exact canonical UTC times and uses Date.now only when asOf is omitted', () => {
    for (const invalid of ['2026-02-30T12:00:00.000Z', '2026-11-03', '2026-11-03T12:00:00Z', '2026-11-03T12:00:00.000+00:00',
      '1970-01-01T12:00:00.000Z', '99999-01-01T00:00:00.000Z', 'garbage', SECRET]) expect(() => diagnosticTime(invalid)).toThrow()
    expect(diagnosticTime(AS_OF)).toBe(AS_OF)
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(AS_OF) })
    try { expect(diagnosticTime()).toBe(AS_OF) } finally { vi.useRealTimers() }
  })
})

describe('doctor CLI', () => {
  it('prints one JSON summary with correct healthy/held/blocked/failure exit codes', () => {
    const f = fixture(); f.close()
    const healthy = cli(['--state-dir', f.stateDir, '--as-of', AS_OF])
    expect(healthy.code).toBe(0)
    expect(healthy.output.trim().split('\n')).toHaveLength(1)
    expect(healthy.json()).toMatchObject({ schemaVersion: 1, mode: 'read-only-diagnostics', ok: true })
    const held = fixture(); held.safety.halt(SECRET); held.close()
    expect(cli(['--state-dir', held.stateDir, '--as-of', AS_OF]).code).toBe(2)
    const wal = fixture(); wal.close(false)
    expect(cli(['--state-dir', wal.stateDir, '--as-of', AS_OF]).code).toBe(2)
    expect(cli(['--state-dir', join(f.stateDir, 'missing'), '--as-of', AS_OF]).code).toBe(1)
  })

  it('rejects unsupported/duplicate/missing flags and invalid time without echoing argument text or creating files', () => {
    const root = directory(), missing = join(root, SECRET)
    for (const args of [[], ['--state-dir'], ['--unknown', SECRET], ['--state-dir', missing, '--state-dir', missing],
      ['--state-dir', missing, '--as-of', SECRET], ['--as-of', AS_OF], ['--help', SECRET]]) {
      const result = cli(args)
      expect(result.code).toBe(1)
      expect(result.json()).toMatchObject({ ok: false, status: 'error', mode: 'read-only-diagnostics' })
      expect(result.output).not.toContain(SECRET)
      expect(result.output).not.toContain(root)
    }
    expect(readdirSync(root)).toEqual([])
  })

  it('shows help without touching a database', () => {
    const result = cli(['--help'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('No auto-healing, manual-stop resume')
  })
})
