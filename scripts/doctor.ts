/** tsdown entry: build as lib/doctor.js. */
import { runDoctorCli } from '../src/diagnostics/cli.ts'
process.exitCode = runDoctorCli(process.argv.slice(2))
