/** Read-only doctor CLI; no daemon, repair, shell, external API, or resume action. */
import { diagnose, diagnosticExitCode, diagnosticInputFailure } from './index.ts'

const help = 'Usage: node lib/doctor.js --state-dir <path> [--as-of YYYY-MM-DDTHH:mm:ss.sssZ]\nRead-only aggregate diagnostics for an existing orchestrator.sqlite.\nPrefer a separately prepared consistent SQLite backup; missing WAL sidecars are refused.\nExit codes: 0 healthy, 2 operator-held/state-blocked, 1 input/IO/corruption failure.\nNo auto-healing, manual-stop resume, model, network or account actions.\n'

/** Output is bounded/redacted JSON except for --help; never echoes unknown arguments or absolute paths. */
export function runDoctorCli(args: string[], output: (text: string) => void = text => { process.stdout.write(text) }): 0 | 1 | 2 {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(help); return 0 }
  let stateDir: string | undefined, asOf: string | undefined
  try {
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('invalid_arguments')
      if (flag === '--state-dir' && stateDir === undefined) stateDir = value
      else if (flag === '--as-of' && asOf === undefined) asOf = value
      else throw new Error('invalid_arguments')
    }
    if (!stateDir) throw new Error('invalid_arguments')
  } catch {
    const summary = diagnosticInputFailure()
    output(`${JSON.stringify(summary)}\n`)
    return 1
  }
  const summary = diagnose({ stateDir, ...asOf === undefined ? {} : { asOf } })
  output(`${JSON.stringify(summary)}\n`)
  return diagnosticExitCode(summary)
}
