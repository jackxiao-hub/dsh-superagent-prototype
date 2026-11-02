import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SCENARIO, ReplayScenarioSchema, runReplay, SUMMARY_LIMITS } from '../src/replay/index.ts'
import { MAX_FIXTURE_BYTES, runReplayCli } from '../src/replay/cli.ts'

const request = { op: 'receive', id: 'request', thread: 'issue-1', actor: 'alice', addressed: 'mention', text: 'Scripted existing typo correction.' }
const fixture = (steps: unknown[]) => ({ version: 1, name: 'test-fixture', steps })
async function cli(args: string[]) {
  let output = ''
  const code = await runReplayCli(args, text => { output += text })
  return { code, output, json: () => JSON.parse(output) as Record<string, unknown> }
}
async function withFixture(value: unknown, run: (path: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-replay-spec-'))
  try {
    const path = join(directory, 'fixture.json')
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
    await run(path)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

describe('offline deterministic replay using the production domain and SQLite queues', () => {
  it('runs the default acceptance/followup/dedup/policy/stop/restart loop without network or accounts', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Replay must not use the network'))
    try {
      const summary = await runReplay()
      expect(summary.errors).toEqual([])
      expect(summary.checks.filter(check => !check.passed)).toEqual([])
      expect(summary.ok).toBe(true)
      expect(summary.totals).toMatchObject({ tickets: 3, workersStarted: 4, assessmentRequests: 6, duplicates: 2,
        wouldAccept: 3, sent: 5, pendingEffects: 0, restarts: 4, failedChecks: 0 })
      expect(summary.totals.checks).toBe(DEFAULT_SCENARIO.steps.filter(step => step.op === 'check').length)
      expect(summary.assurance.real).toEqual(['Engine', 'settingsPolicy', 'assessmentOutcome', 'SQLite Store', 'Effects', 'Outbox'])
      expect(summary.assurance.doesNotProve).toContain('model quality')
      expect(summary.decisions.find(decision => decision.triggerIds.includes('injection'))).toMatchObject({ kind: 'ignore', reasons: ['not_a_member'] })
      expect(summary.decisions.find(decision => decision.triggerIds.includes('unlisted-bot'))).toMatchObject({ kind: 'ignore', reasons: ['not_human'] })
      expect(summary.tickets.find(ticket => ticket.origin === 'request')).toMatchObject({ strength: 'explicit', actor: 'alice', basis: 'addressed',
        assignments: 1, outcome: 'merged', inputTriggers: ['followup'] })
      expect(summary.tickets.find(ticket => ticket.origin === 'stoppable')).toMatchObject({ assignments: 1, outcome: 'stopped', inputTriggers: [] })
      expect(summary.reports[0]).toMatchObject({ ticketOrigin: 'request', state: 'ready', synthetic: true, evidence: 'scripted-not-executed',
        pullRequest: { number: 17, url: 'https://replay.invalid/pulls/17', synthetic: true } })
      expect(summary.messages.filter(message => message.kind === 'reply')[0]?.text).toContain('https://replay.invalid/pulls/17')
      expect(summary.recovery[0]).toMatchObject({ pendingEffectsBefore: 1, evaluations: 1 })
      expect(summary.recovery[1]).toMatchObject({ interruptedAssignments: 1 })
      expect(summary.recovery[2]).toMatchObject({ pendingEffectsBefore: 1, pendingReceipts: 1 })
      expect(summary.recovery[3]).toEqual({ pendingEffectsBefore: 0, evaluations: 0, pendingAssignments: 0, interruptedAssignments: 0, pendingReceipts: 0 })
      expect(new Set(summary.messages.map(message => message.id)).size).toBe(summary.messages.length)
      expect(network).not.toHaveBeenCalled()
    } finally { network.mockRestore() }
  })

  it('returns byte-for-byte deterministic summaries across fresh databases', async () => {
    expect(JSON.stringify(await runReplay())).toBe(JSON.stringify(await runReplay()))
  })

  it('runs the checked-in data-only example through the same production harness', async () => {
    const example = JSON.parse(readFileSync(new URL('../examples/replay-typo-pr.json', import.meta.url), 'utf8')) as unknown
    const summary = await runReplay(example)
    expect(summary.ok).toBe(true)
    expect(summary.totals).toMatchObject({ tickets: 1, workersStarted: 1, assessmentRequests: 1, duplicates: 1, sent: 2, restarts: 1 })
    expect(summary.tickets[0]?.outcome).toBe('merged')
  })

  it('fails a wrong expectation instead of printing a success-shaped report', async () => {
    const summary = await runReplay(fixture([request, { op: 'check', id: 'wrong-worker-count', expected: { workersStarted: 0 } }]))
    expect(summary.ok).toBe(false)
    expect(summary.totals.failedChecks).toBe(1)
    expect(summary.checks).toEqual([{ id: 'wrong-worker-count', passed: false, expected: { workersStarted: 0 }, actual: { workersStarted: 1 } }])
  })

  it('returns a bounded failed report when a scripted operation cannot run', async () => {
    const summary = await runReplay(fixture([{ op: 'report', ticket: 'missing', state: 'ready', summary: 'No such worker.' },
      { op: 'check', id: 'unreached', expected: { tickets: 0 } }]))
    expect(summary.ok).toBe(false)
    expect(summary.errors).toEqual(['No accepted ticket originated from missing'])
    expect(summary.totals).toMatchObject({ steps: 1, checks: 0 })
  })

  it('rejects unchecked, excessive, ambiguous or instruction-bearing fixture structure', () => {
    for (const input of [
      fixture([request]),
      fixture([{ op: 'check', id: 'empty', expected: {} }]),
      fixture([request, request, { op: 'check', id: 'x', expected: { tickets: 1 } }]),
      fixture([{ op: 'shell', command: 'echo unsafe' }, { op: 'check', id: 'x', expected: { tickets: 0 } }]),
      fixture([{ ...request, policyOverride: 'allow everyone' }, { op: 'check', id: 'x', expected: { tickets: 1 } }]),
      fixture(Array.from({ length: 129 }, (_, index) => ({ op: 'check', id: `check-${index}`, expected: { tickets: 0 } }))),
    ]) expect(ReplayScenarioSchema.safeParse(input).success).toBe(false)
  })

  it('caps detail arrays, retains exact totals and reports omitted detail', async () => {
    const steps = Array.from({ length: 20 }, (_, index) => ({ ...request, id: `request-${index}`, thread: `issue-${index}` }))
    const summary = await runReplay(fixture([...steps, { op: 'check', id: 'bounded', expected: { tickets: 20, workersStarted: 20, sent: 20 } }]))
    expect(summary.ok).toBe(true)
    expect(summary.totals.tickets).toBe(20)
    expect(summary.tickets).toHaveLength(SUMMARY_LIMITS.tickets)
    expect(summary.messages).toHaveLength(SUMMARY_LIMITS.messages)
    expect(summary.truncated).toMatchObject({ tickets: 4, messages: 4 })
    expect(JSON.stringify(summary).length).toBeLessThan(256 * 1024)
  })
})

describe('offline replay CLI exit contract', () => {
  it('prints one JSON summary and returns zero for the embedded scenario', async () => {
    const result = await cli([])
    expect(result.code).toBe(0)
    expect(result.output.trim().split('\n')).toHaveLength(1)
    expect(result.json()).toMatchObject({ schemaVersion: 1, mode: 'offline-replay', ok: true })
  })
  it('returns nonzero for wrong expectations and operation failures', async () => {
    await withFixture(fixture([request, { op: 'check', id: 'fail', expected: { tickets: 99 } }]), async path => {
      const result = await cli(['--fixture', path])
      expect(result.code).toBe(1)
      expect(result.json()).toMatchObject({ ok: false, totals: { failedChecks: 1 } })
    })
    await withFixture(fixture([{ op: 'repeat', trigger: 'missing' }, { op: 'check', id: 'unreached', expected: { tickets: 0 } }]), async path => {
      const result = await cli(['--fixture', path])
      expect(result.code).toBe(1)
      expect(result.json().errors).toEqual(['Cannot repeat unknown event missing'])
    })
  })
  it('returns bounded invalid-input JSON for malformed, oversized and unsupported input', async () => {
    for (const value of ['{ malformed JSON', 'null', {}, ' '.repeat(MAX_FIXTURE_BYTES + 1)]) await withFixture(value, async path => {
      const result = await cli(['--fixture', path])
      expect(result.code).toBe(2)
      expect(result.json()).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(result.output.length).toBeLessThan(2048)
    })
    expect((await cli(['--unknown'])).code).toBe(2)
    expect((await cli(['--fixture', 'no-such-replay-fixture.json'])).code).toBe(2)
  })
  it('provides help without opening a database', async () => {
    const result = await cli(['--help'])
    expect(result.code).toBe(0)
    expect(result.output).toContain('No accounts, model, network or real PRs')
  })
})
