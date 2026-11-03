import { expect, it, vi } from 'vitest'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

// Stub Runtime to capture the resolved Machine settings and restart callback.
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void }[])
const waitForStateLock = vi.hoisted(() => vi.fn(async (_directory: string, _options: { signal: AbortSignal; onWait?: () => void }) => {}))
vi.mock('../src/app/startup-lock.ts', () => ({ waitForStateLock }))
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  ready = Promise.resolve()
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void) { runtimes.push(this) }
  configured() { return true }
  async stop() {}
} }))
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const ctx = {
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn((_effect: () => unknown): unknown => undefined),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe }
}

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const config = Config({ stateDir: '/srv/state', promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: '/srv/state' }))
  // Saving a Source account change restarts dsh-superagent, which re-runs setup and refreshes the settings descriptor.
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: '/srv/state', github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on the GitHub Source)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
})

it('does not construct a Runtime or register setup before startup lock waiting completes', async () => {
  const { ctx } = context(), count = runtimes.length
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  waitForStateLock.mockImplementationOnce(async () => { await gate })
  const pending = apply(ctx as never, Config({ stateDir: '/srv/state' }))
  await Promise.resolve()
  expect(runtimes).toHaveLength(count)
  expect(ctx.inject).not.toHaveBeenCalled()
  expect(waitForStateLock).toHaveBeenLastCalledWith('/srv/state', { signal: expect.any(AbortSignal), onWait: expect.any(Function) })
  release(); await pending
  expect(runtimes).toHaveLength(count + 1)
})

it('does not construct a Runtime if its context is disposed while startup lock waiting settles', async () => {
  const { ctx } = context(), count = runtimes.length
  const cleanups: (() => void)[] = []
  ctx.effect.mockImplementation(effect => { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => void) })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  waitForStateLock.mockImplementationOnce(async () => { await gate })
  const pending = apply(ctx as never, Config({ stateDir: '/srv/state' }))
  expect(cleanups).toHaveLength(1)
  cleanups[0]!(); release()
  await expect(pending).rejects.toThrow('Superagent startup cancelled')
  expect(runtimes).toHaveLength(count)
  expect(ctx.inject).not.toHaveBeenCalled()
})
