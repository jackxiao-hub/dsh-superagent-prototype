/** Startup-only readiness check; Runtime retains the final atomic lock acquisition and sole-writer ownership. */
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { checkSync } from 'proper-lockfile'

/** Shared by the readiness check and Runtime's actual lock acquisition. Never shorten this to bypass a live owner. */
export const STATE_LOCK_STALE_MS = 30_000
const MAX_WAIT_MS = 300_000

export interface StartupLockOptions {
  signal: AbortSignal
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
  onWait?: () => void
}
const bounded = (name: string, value: number, minimum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_WAIT_MS) throw new RangeError(`${name} must be an integer from ${minimum} to ${MAX_WAIT_MS}`)
  return value
}
/**
 * Wait without constructing Runtime, opening SQLite, acquiring or removing a lock, or starting external work.
 * checkSync uses the same heartbeat expiry policy as lockSync; the latter must still decide any acquisition race.
 */
export async function waitForStateLock(directory: string, options: StartupLockOptions): Promise<void> {
  const { signal, onWait } = options
  signal.throwIfAborted()
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new TypeError('State directory must be an absolute path')
  const timeout = bounded('timeoutMs', options.timeoutMs ?? 40_000, 1)
  const poll = bounded('pollMs', options.pollMs ?? 500, 1)
  // proper-lockfile clamps stale to at least 2000ms; reject misleading smaller values rather than pretending to honor them.
  const stale = bounded('staleMs', options.staleMs ?? STATE_LOCK_STALE_MS, 2_000)
  if (onWait !== undefined && typeof onWait !== 'function') throw new TypeError('onWait must be a function')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const deadline = performance.now() + timeout
  let announced = false
  for (;;) {
    signal.throwIfAborted()
    if (!checkSync(directory, { stale })) return
    if (!announced) { announced = true; onWait?.() }
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw Object.assign(new Error(`Superagent state directory remains locked after ${timeout} ms; another instance may still own it. Investigate the owner; do not delete the lock or database.`), { code: 'ELOCKED' })
    await delay(Math.min(poll, remaining), undefined, { signal })
  }
}
