/** Real proper-lockfile heartbeat behavior, with no database or model and no manual production unlock path. */
import { afterEach, expect, it, vi } from 'vitest'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { lockSync } from 'proper-lockfile'
import { STATE_LOCK_STALE_MS, waitForStateLock } from '../src/app/startup-lock.ts'

const roots: string[] = []
const releases: (() => void)[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'superagent-startup-lock-')); roots.push(root)
  return { root, directory: join(root, 'state'), signal: new AbortController().signal }
}
const orphan = (directory: string, ageMs = 0) => {
  mkdirSync(directory, { recursive: true }); mkdirSync(`${directory}.lock`)
  const at = new Date(Date.now() - ageMs); utimesSync(`${directory}.lock`, at, at)
}
afterEach(() => {
  for (const release of releases.splice(0)) release()
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('superagent-startup-lock-')) throw new Error('Refusing unrelated cleanup target')
    rmSync(target, { recursive: true, force: true })
  }
})

it('creates only the state directory and returns immediately when no lock exists', async () => {
  const f = fixture(), onWait = vi.fn()
  await waitForStateLock(f.directory, { signal: f.signal, onWait })
  expect(readdirSync(f.directory)).toEqual([])
  expect(existsSync(`${f.directory}.lock`)).toBe(false)
  expect(onWait).not.toHaveBeenCalled()
  expect(STATE_LOCK_STALE_MS).toBe(30_000)
})

it('recognizes an expired orphan but leaves reclamation to the actual atomic lock acquisition', async () => {
  const f = fixture(); orphan(f.directory, STATE_LOCK_STALE_MS + 5_000)
  const before = statSync(`${f.directory}.lock`).mtimeMs
  await waitForStateLock(f.directory, { signal: f.signal })
  expect(statSync(`${f.directory}.lock`).mtimeMs).toBe(before)
  const release = lockSync(f.directory, { stale: STATE_LOCK_STALE_MS }); releases.push(release)
  expect(statSync(`${f.directory}.lock`).mtimeMs).toBeGreaterThan(before)
  expect(readdirSync(f.directory)).toEqual([])
})

it('waits on a fresh orphan and proceeds once it expires, without deleting or refreshing it', async () => {
  const f = fixture(); orphan(f.directory)
  let entered = () => {}
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const onWait = vi.fn(entered)
  const pending = waitForStateLock(f.directory, { signal: f.signal, pollMs: 5, timeoutMs: 1_000, onWait })
  await waiting
  expect(existsSync(`${f.directory}.lock`)).toBe(true)
  const old = new Date(Date.now() - STATE_LOCK_STALE_MS - 5_000)
  utimesSync(`${f.directory}.lock`, old, old)
  const expiredMtime = statSync(`${f.directory}.lock`).mtimeMs
  await pending
  expect(statSync(`${f.directory}.lock`).mtimeMs).toBe(expiredMtime)
  expect(onWait).toHaveBeenCalledTimes(1)
})

it('times out conservatively rather than taking a real live owner lock', async () => {
  const f = fixture(); mkdirSync(f.directory)
  releases.push(lockSync(f.directory, { stale: STATE_LOCK_STALE_MS }))
  const onWait = vi.fn(), before = statSync(`${f.directory}.lock`).mtimeMs
  await expect(waitForStateLock(f.directory, { signal: f.signal, timeoutMs: 35, pollMs: 5, onWait })).rejects.toMatchObject({ code: 'ELOCKED' })
  expect(existsSync(`${f.directory}.lock`)).toBe(true)
  expect(statSync(`${f.directory}.lock`).mtimeMs).toBe(before)
  expect(onWait).toHaveBeenCalledTimes(1)
  expect(() => lockSync(f.directory)).toThrow('already being held')
})

it('makes no filesystem changes when already aborted', async () => {
  const f = fixture(), control = new AbortController(); control.abort(new Error('Cancelled before start'))
  await expect(waitForStateLock(f.directory, { signal: control.signal })).rejects.toThrow('Cancelled before start')
  expect(readdirSync(f.root)).toEqual([])
})

it('aborts a pending wait promptly without touching the owner lock', async () => {
  const f = fixture(); orphan(f.directory)
  const control = new AbortController(), before = statSync(`${f.directory}.lock`).mtimeMs
  let entered = () => {}
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const pending = waitForStateLock(f.directory, { signal: control.signal, pollMs: 10_000, onWait: entered })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await waiting; control.abort(); await rejected
  expect(statSync(`${f.directory}.lock`).mtimeMs).toBe(before)
  expect(readdirSync(f.directory)).toEqual([])
})

it.each([
  { timeoutMs: 0 }, { timeoutMs: Infinity }, { pollMs: -1 }, { pollMs: 0.5 }, { staleMs: 1_999 }, { timeoutMs: 300_001 },
])('rejects invalid waiting limits before creating state: %j', async options => {
  const f = fixture()
  await expect(waitForStateLock(f.directory, { signal: f.signal, ...options })).rejects.toThrow(RangeError)
  expect(readdirSync(f.root)).toEqual([])
})

it('rejects relative paths before attempting filesystem work', async () => {
  const f = fixture()
  await expect(waitForStateLock('relative-state', { signal: f.signal })).rejects.toThrow('absolute path')
  expect(readdirSync(f.root)).toEqual([])
})
