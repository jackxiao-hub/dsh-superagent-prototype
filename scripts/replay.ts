/** tsdown CLI entry: build this as lib/replay.js. */
import { runReplayCli } from '../src/replay/cli.ts'
process.exitCode = await runReplayCli(process.argv.slice(2))
