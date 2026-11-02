/** Small offline CLI; stdout is one bounded JSON document except for --help. */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { DEFAULT_SCENARIO, ReplayScenarioSchema, runReplay, type ReplayScenario } from './index.ts'

export const MAX_FIXTURE_BYTES = 256 * 1024
const usage = 'Usage: node lib/replay.js [--fixture examples/replay-typo-pr.json]\nRuns the embedded offline safety scenario by default. No accounts, model, network or real PRs.\nExit codes: 0 = all checks passed, 1 = check/operation failure, 2 = invalid input.\n'

/** Injectable output keeps CLI tests in-process; this function does not mutate process.exitCode. */
export async function runReplayCli(args: string[], output: (text: string) => void = text => { process.stdout.write(text) }): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0 }
  let scenario: ReplayScenario
  try {
    if (args.length && (args.length !== 2 || args[0] !== '--fixture' || !args[1])) throw new Error('Expected no arguments, or --fixture <path>; use --help')
    let input: unknown
    if (args[1]) {
      const handle = openSync(args[1], 'r')
      try {
        const stat = fstatSync(handle)
        if (!stat.isFile()) throw new Error('Fixture must be a regular JSON file')
        if (stat.size > MAX_FIXTURE_BYTES) throw new Error(`Fixture exceeds ${MAX_FIXTURE_BYTES} bytes`)
        const bytes = Buffer.alloc(MAX_FIXTURE_BYTES + 1)
        // Reading at most the limit+1 also bounds a file that grows after fstat.
        const read = readFileBounded(handle, bytes)
        if (read > MAX_FIXTURE_BYTES) throw new Error(`Fixture exceeds ${MAX_FIXTURE_BYTES} bytes`)
        input = JSON.parse(bytes.subarray(0, read).toString('utf8')) as unknown
      } finally { closeSync(handle) }
    }
    scenario = ReplayScenarioSchema.parse(input === undefined ? DEFAULT_SCENARIO : input)
  } catch (error) {
    failure(output, 'invalid_input', error)
    return 2
  }
  try {
    const summary = await runReplay(scenario)
    output(`${JSON.stringify(summary)}\n`)
    return summary.ok ? 0 : 1
  } catch (error) {
    // Unexpected infrastructure/cleanup failures are runtime failures, not malformed fixture data.
    failure(output, 'runtime_failure', error)
    return 1
  }
}

function failure(output: (text: string) => void, code: 'invalid_input' | 'runtime_failure', error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 640)
  output(`${JSON.stringify({ schemaVersion: 1, mode: 'offline-replay', ok: false, error: { code, message } })}\n`)
}

function readFileBounded(handle: number, bytes: Buffer): number {
  let length = 0
  while (length < bytes.length) {
    const size = readSync(handle, bytes, length, bytes.length - length, null)
    if (!size) break
    length += size
  }
  return length
}
