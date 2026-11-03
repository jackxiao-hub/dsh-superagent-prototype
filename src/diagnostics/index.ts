/** Read-only, aggregate-only inspection. Deliberately never import Store/Runtime/Safety or run their constructors. */
import { lstatSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { KV } from '../kv.ts'

/** Deliberately fail closed on every other schema; tests compare this with the production Store's current version. */
export const SUPPORTED_DIAGNOSTICS_SCHEMA = 11
const DAY_MS = 86_400_000
export type DiagnosticStatus = 'healthy' | 'operator-held' | 'blocked' | 'error'
export interface DiagnosticCheck { id: string; status: 'pass' | 'hold' | 'fail'; code: string }
export interface DiagnosticCounts {
  records: { triggers: number; threads: number; tickets: number; decisions: number; receipts: number }
  tickets: { open: number; running: number; personStopped: number }
  effects: { pending: number; failed: number; oldestAgeSeconds: number | null }
  receipts: { pending: number; sent: number; dropped: number }
  decisions24h: { total: number; explicit: number; inferred: number; wouldAccept: number; acceptedExplicit: number; acceptedInferred: number }
}
export interface DiagnosticSummary {
  schemaVersion: 1
  mode: 'read-only-diagnostics'
  ok: boolean
  status: DiagnosticStatus
  asOf: string | null
  checks: DiagnosticCheck[]
  state: {
    databaseSchema: number | null
    halt: { active: boolean; generation: number; phase: 'running' | 'stopping' | 'halted'; errorCount: number } | null
    settings: { saved: boolean; paused: boolean; evalMode: 'off' | 'observe' | 'auto' } | null
  }
  counts: DiagnosticCounts | null
  limits: { windowHours: 24; maxChecks: 12; aggregateOnly: true }
  assurance: { readOnlyConnection: true; applicationWrites: false; autoHealing: false; semanticQuality: false; tokenBudgetProof: false; osIsolationProof: false; walSidecarsMayBeUsed: true }
}
export interface DiagnosticOptions { stateDir: string; asOf?: string }

/** Canonical UTC only, exact calendar validation; the full 24-hour window must remain within 1970..9999. */
export function diagnosticTime(value?: string): string {
  if (value === undefined) value = new Date().toISOString()
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('invalid_as_of')
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || milliseconds < DAY_MS || new Date(milliseconds).toISOString() !== value) throw new Error('invalid_as_of')
  return value
}

function empty(): DiagnosticSummary {
  return {
    schemaVersion: 1, mode: 'read-only-diagnostics', ok: false, status: 'error', asOf: null, checks: [],
    state: { databaseSchema: null, halt: null, settings: null }, counts: null,
    limits: { windowHours: 24, maxChecks: 12, aggregateOnly: true },
    assurance: { readOnlyConnection: true, applicationWrites: false, autoHealing: false, semanticQuality: false, tokenBudgetProof: false,
      osIsolationProof: false, walSidecarsMayBeUsed: true },
  }
}
function finish(summary: DiagnosticSummary): DiagnosticSummary {
  summary.status = summary.checks.some(check => check.status === 'fail') ? 'error'
    : summary.checks.some(check => check.status === 'hold' && ['operator_halt', 'processing_pause'].includes(check.id)) ? 'operator-held'
      : summary.checks.some(check => check.status === 'hold') ? 'blocked' : 'healthy'
  summary.ok = summary.status === 'healthy'
  return summary
}
function add(summary: DiagnosticSummary, id: string, status: DiagnosticCheck['status'], code: string): void { summary.checks.push({ id, status, code }) }
function scalar(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): Record<string, SQLInputValue> {
  const row = db.prepare(sql).get(...args)
  if (!row) throw new Error('missing_aggregate')
  return row
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_count')
  return value
}
const TABLES = {
  kv: ['key', 'value'], trigger: ['id', 'value', 'at'], disposition: ['id', 'value'], thread: ['key', 'value'], ticket: ['id', 'value'],
  decision: ['id', 'thread', 'value'], outbox: ['id', 'value'], trigger_thread: ['thread', 'id', 'at', 'human'],
  effect: ['kind', 'key', 'value', 'seq', 'generation', 'attempts', 'error', 'due', 'since'],
} as const

/** Never returns exception messages, paths, row contents, identities, account configuration, or message text. */
export function diagnose(options: DiagnosticOptions): DiagnosticSummary {
  const summary = empty()
  let db: DatabaseSync | undefined, stage = 'input'
  try {
    if (!options || typeof options.stateDir !== 'string' || !options.stateDir.trim() || options.stateDir.length > 4096
      || options.stateDir.includes('\0') || Object.keys(options).some(key => key !== 'stateDir' && key !== 'asOf')) throw new Error('invalid_options')
    summary.asOf = diagnosticTime(options.asOf)
    add(summary, 'input', 'pass', 'valid')
    stage = 'database'
    const path = join(options.stateDir, 'orchestrator.sqlite')
    let exists: ReturnType<typeof lstatSync>
    try { exists = lstatSync(path) } catch { add(summary, 'database', 'fail', 'database_missing_or_unreadable'); return finish(summary) }
    if (!exists.isFile()) { add(summary, 'database', 'fail', 'database_not_regular'); return finish(summary) }
    const header = Buffer.alloc(100)
    const descriptor = openSync(path, 'r')
    try {
      if (readSync(descriptor, header, 0, header.length, 0) !== header.length || header.subarray(0, 15).toString('ascii') !== 'SQLite format 3' || header[15] !== 0) {
        throw new Error('invalid_database_header')
      }
    } finally { closeSync(descriptor) }
    if (header[18] === 2 || header[19] === 2) {
      // SQLite can create missing WAL sidecars even for a read-only main DB. Refuse before opening instead of using immutable=1,
      // which would ignore uncheckpointed WAL. Prefer a separately prepared consistent backup in DELETE journal mode.
      const present = ['-wal', '-shm'].every(suffix => { try { return lstatSync(`${path}${suffix}`).isFile() } catch { return false } })
      if (!present) { add(summary, 'database', 'hold', 'wal_snapshot_required'); return finish(summary) }
    }
    // No mkdir, profile lock, schema migration, checkpoint, chmod or writable fallback. A missing DB cannot be created in this mode.
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN')
    add(summary, 'database', 'pass', 'read_only_connection')
    stage = 'integrity'
    const integrity = db.prepare('PRAGMA quick_check(1)').get()
    if (!integrity || Object.values(integrity)[0] !== 'ok') { add(summary, 'integrity', 'fail', 'quick_check_failed'); return finish(summary) }
    add(summary, 'integrity', 'pass', 'quick_check_ok')
    stage = 'schema'
    const schema = scalar(db, 'SELECT value FROM kv WHERE key = ?', KV.store.schema)
    let version: unknown
    try { version = JSON.parse(String(schema.value)) as unknown } catch { version = null }
    summary.state.databaseSchema = typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : null
    if (summary.state.databaseSchema !== SUPPORTED_DIAGNOSTICS_SCHEMA) {
      add(summary, 'schema', 'hold', 'unsupported_schema_no_migration')
      return finish(summary)
    }
    for (const [table, columns] of Object.entries(TABLES)) {
      const found = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
      if (!found) throw new Error('missing_table')
      const names = new Set(db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => row.name))
      if (columns.some(column => !names.has(column))) throw new Error('missing_column')
    }
    add(summary, 'schema', 'pass', 'supported_schema')
    stage = 'records'
    // Validate JSON without reading full records into JavaScript; malformed data must not look like healthy zero counts.
    for (const table of ['kv', 'trigger', 'disposition', 'thread', 'ticket', 'decision', 'outbox', 'effect']) {
      if (number(scalar(db, `SELECT COUNT(*) AS n FROM ${table} WHERE typeof(value) != 'text' OR NOT json_valid(value)`).n)) throw new Error('invalid_json')
    }
    const invalid = scalar(db, `SELECT
      (SELECT COUNT(*) FROM decision WHERE json_type(value, '$') != 'object' OR json_type(value, '$.at') != 'text'
        OR julianday(value ->> '$.at') IS NULL OR COALESCE(value ->> '$.strength', '') NOT IN ('explicit', 'inferred')
        OR COALESCE(value ->> '$.kind', '') NOT IN ('ignore', 'accept', 'reopen', 'stop', 'unavailable')) +
      (SELECT COUNT(*) FROM ticket WHERE json_type(value, '$') != 'object' OR json_type(value, '$.assignments') IS NOT 'array') +
      (SELECT COUNT(*) FROM outbox WHERE COALESCE(value ->> '$.status', '') NOT IN ('pending', 'sent', 'dropped')) +
      (SELECT COUNT(*) FROM effect WHERE typeof(attempts) != 'integer' OR attempts < 0 OR julianday(since) IS NULL OR typeof(due) != 'integer') AS n`)
    if (number(invalid.n)) throw new Error('invalid_record_shape')
    summary.state.settings = settings(db)
    summary.state.halt = halt(db)
    summary.counts = counts(db, summary.asOf)
    add(summary, 'records', 'pass', 'aggregate_fields_valid')
    add(summary, 'operator_halt', summary.state.halt.active ? 'hold' : 'pass', summary.state.halt.active ? 'operator_resume_required' : 'not_halted')
    add(summary, 'processing_pause', summary.state.settings.paused ? 'hold' : 'pass', summary.state.settings.paused ? 'operator_resume_required' : 'not_paused')
    add(summary, 'effect_delivery', summary.counts.effects.failed ? 'hold' : 'pass', summary.counts.effects.failed ? 'retrying_effects_require_review' : 'no_failed_effects')
    return finish(summary)
  } catch {
    // Native SQLite and filesystem errors often contain a path or stored text. Only a fixed stage code is exposed.
    add(summary, stage, 'fail', `${stage}_inspection_failed`)
    return finish(summary)
  } finally {
    if (db) {
      try { db.close() } catch { add(summary, 'close', 'fail', 'connection_close_failed'); finish(summary) }
    }
  }
}

function settings(db: DatabaseSync): NonNullable<DiagnosticSummary['state']['settings']> {
  const pointer = db.prepare('SELECT json_extract(value, \'$\') AS revision FROM kv WHERE key = ?').get(KV.settings.revision)
  if (!pointer) return { saved: false, paused: false, evalMode: 'observe' }
  const revision = number(pointer.revision)
  if (!revision) throw new Error('invalid_settings_revision')
  const row = scalar(db, `SELECT json_type(value, '$.settings.paused') AS pausedType, value ->> '$.settings.paused' AS paused,
    value ->> '$.settings.eval.mode' AS mode FROM kv WHERE key = ?`, KV.settings.version(revision))
  if (!['true', 'false'].includes(String(row.pausedType)) || !['off', 'observe', 'auto'].includes(String(row.mode))) throw new Error('invalid_settings')
  return { saved: true, paused: row.paused === 1, evalMode: row.mode as 'off' | 'observe' | 'auto' }
}
function halt(db: DatabaseSync): NonNullable<DiagnosticSummary['state']['halt']> {
  const row = db.prepare(`SELECT json_type(value, '$.active') AS activeType, value ->> '$.active' AS active,
    value ->> '$.generation' AS generation, value ->> '$.phase' AS phase,
    json_type(value, '$.errors') AS errorsType, json_array_length(value, '$.errors') AS errors FROM kv WHERE key = ?`).get(KV.safety.halt)
  if (!row) return { active: false, generation: 0, phase: 'running', errorCount: 0 }
  if (!['true', 'false'].includes(String(row.activeType))) throw new Error('invalid_halt')
  const generation = number(row.generation)
  if (row.active === 0) return { active: false, generation, phase: 'running', errorCount: 0 }
  if ((row.phase !== 'stopping' && row.phase !== 'halted') || row.errorsType !== 'array' || number(row.errors) > 20) throw new Error('invalid_halt')
  return { active: true, generation, phase: row.phase, errorCount: number(row.errors) }
}
function counts(db: DatabaseSync, asOf: string): DiagnosticCounts {
  const records = Object.fromEntries(['trigger', 'thread', 'ticket', 'decision', 'outbox'].map(table => [table,
    number(scalar(db, `SELECT COUNT(*) AS n FROM ${table}`).n)]))
  const tickets = scalar(db, `SELECT
    COUNT(*) FILTER (WHERE value -> '$.ended' IS NULL) AS open,
    COUNT(*) FILTER (WHERE value -> '$.ended' IS NULL AND value ->> '$.assignments[#-1].state' = 'running') AS running,
    COUNT(*) FILTER (WHERE value ->> '$.ended.by' = 'human' AND value ->> '$.ended.outcome' = 'stopped') AS stopped FROM ticket`)
  const effects = scalar(db, 'SELECT COUNT(*) AS pending, COUNT(*) FILTER (WHERE attempts > 0) AS failed, MIN(since) AS oldest FROM effect')
  const oldest = effects.oldest === null ? null : Date.parse(String(effects.oldest))
  if (oldest !== null && !Number.isFinite(oldest)) throw new Error('invalid_effect_time')
  const receipts = scalar(db, `SELECT COUNT(*) FILTER (WHERE value ->> '$.status' = 'pending') AS pending,
    COUNT(*) FILTER (WHERE value ->> '$.status' = 'sent') AS sent,
    COUNT(*) FILTER (WHERE value ->> '$.status' = 'dropped') AS dropped FROM outbox`)
  const windowStart = new Date(Date.parse(asOf) - DAY_MS).toISOString()
  const decisions = scalar(db, `SELECT COUNT(*) AS total,
    COUNT(*) FILTER (WHERE value ->> '$.strength' = 'explicit') AS explicit,
    COUNT(*) FILTER (WHERE value ->> '$.strength' = 'inferred') AS inferred,
    COUNT(*) FILTER (WHERE json_type(value, '$.audit.would_accept') = 'true') AS wouldAccept,
    COUNT(*) FILTER (WHERE value ->> '$.kind' = 'accept' AND value ->> '$.strength' = 'explicit') AS acceptedExplicit,
    COUNT(*) FILTER (WHERE value ->> '$.kind' = 'accept' AND value ->> '$.strength' = 'inferred') AS acceptedInferred
    FROM decision WHERE julianday(value ->> '$.at') >= julianday(?) AND julianday(value ->> '$.at') <= julianday(?)`, windowStart, asOf)
  return {
    records: { triggers: records.trigger!, threads: records.thread!, tickets: records.ticket!, decisions: records.decision!, receipts: records.outbox! },
    tickets: { open: number(tickets.open), running: number(tickets.running), personStopped: number(tickets.stopped) },
    effects: { pending: number(effects.pending), failed: number(effects.failed), oldestAgeSeconds: oldest === null ? null : Math.max(0, Math.floor((Date.parse(asOf) - oldest) / 1000)) },
    receipts: { pending: number(receipts.pending), sent: number(receipts.sent), dropped: number(receipts.dropped) },
    decisions24h: { total: number(decisions.total), explicit: number(decisions.explicit), inferred: number(decisions.inferred), wouldAccept: number(decisions.wouldAccept),
      acceptedExplicit: number(decisions.acceptedExplicit), acceptedInferred: number(decisions.acceptedInferred) },
  }
}

export function diagnosticExitCode(summary: DiagnosticSummary): 0 | 1 | 2 { return summary.ok ? 0 : summary.status === 'error' ? 1 : 2 }
/** CLI input errors use the same bounded/redacted envelope and never include user-provided flag values. */
export function diagnosticInputFailure(): DiagnosticSummary {
  const summary = empty()
  add(summary, 'input', 'fail', 'invalid_arguments')
  return finish(summary)
}
