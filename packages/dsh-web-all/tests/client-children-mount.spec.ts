import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountClientChildren } from '../src/client/mount-children.ts'

const MOUNTED_PLUGINS = Symbol.for('dsh-web.mounted-plugins')

vi.mock('../src/client/children.generated.ts', () => ({
  clientChildren: [
    { name: '@gestaltrun/fake-own-entry', module: { apply: () => {} } },
    { name: '@gestaltrun/fake-mounts', module: { apply: () => {} } },
    { name: '@gestaltrun/fake-sync-throw', module: { apply: () => {} } },
    { name: '@gestaltrun/fake-no-apply', module: {} },
    { name: '@gestaltrun/dsh-client-ui-plugin-manager', module: { apply: () => {} } },
  ],
}))

interface RecordedDefinition {
  name: string
  inject: string[]
  apply: unknown
}

function fakeCtx(outcomes: Record<string, 'ok' | 'reject' | 'throw'> = {}) {
  const mounted: Array<RecordedDefinition> = []
  const ctx = {
    plugin(def: RecordedDefinition) {
      const outcome = outcomes[def.name] ?? 'ok'
      if (outcome === 'throw') throw new Error('sync boom')
      if (outcome === 'reject') return Promise.reject(new Error('async boom'))
      mounted.push(def)
      return Promise.resolve()
    },
  }
  return { ctx: ctx as never, mounted }
}

function bootWith(entries: Array<string | { id?: string }>): void {
  vi.stubGlobal('__DSH_BOOT__', {
    entries: entries.map((entry) => typeof entry === 'string' ? { id: entry } : entry),
  })
}

/** Stub the row-state route answer; undefined simulates a host without the route. */
function rowsRouteAnswer(active: string[] | undefined): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (active === undefined) throw new Error('fetch failed: no route')
    return {
      ok: true,
      json: async () => ({ ok: true, children: active }),
    }
  }))
}

describe('mountClientChildren', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[MOUNTED_PLUGINS]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Default: the host predates the rows route — fail open like before.
    rowsRouteAnswer(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(console.error).mockRestore()
  })

  it('skips children the loader serves through their own entries and mounts the rest', async () => {
    bootWith(['@gestaltrun/fake-own-entry'])
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted.map((def) => def.name)).toEqual([
      '@gestaltrun/fake-mounts',
      '@gestaltrun/fake-sync-throw',
      '@gestaltrun/dsh-client-ui-plugin-manager',
    ])
    expect(mounted[0].inject).toEqual([])
  })

  it('mounts every child when no boot payload is present', async () => {
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted).toHaveLength(4) // every child except the no-apply shape
  })

  it('mounts family children under the real aggregate boot graph (#1372 regression)', async () => {
    // Real host wire shape: boot entries are client-bundle graph rows whose ids
    // are package names (graphRow). Patch row ids like `web-ui-plugin-manager`
    // never appear, so the children must mount despite a fully-populated graph.
    bootWith([
      { id: '@deepseek-ai/dsh-client-modules' },
      { id: '@gestaltrun/dsh-web-all' },
      { id: '@gestaltrun/dsh-perf' },
    ])
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted.some((def) => def.name === '@gestaltrun/dsh-client-ui-plugin-manager')).toBe(true)
    expect(mounted).toHaveLength(4) // every child except the no-apply shape
  })

  it('keeps mounting siblings when one child throws synchronously', async () => {
    bootWith([])
    const { ctx, mounted } = fakeCtx({ '@gestaltrun/fake-mounts': 'throw' })
    await expect(mountClientChildren(ctx)).resolves.toBeUndefined()
    expect(mounted.map((def) => def.name)).toEqual([
      '@gestaltrun/fake-own-entry',
      '@gestaltrun/fake-sync-throw',
      '@gestaltrun/dsh-client-ui-plugin-manager',
    ])
    expect(console.error).toHaveBeenCalledTimes(2) // the throw + the no-apply shape
  })

  it('captures async fiber rejections without escaping', async () => {
    bootWith([])
    const { ctx, mounted } = fakeCtx({ '@gestaltrun/fake-sync-throw': 'reject' })
    await mountClientChildren(ctx)
    expect(mounted.map((def) => def.name)).toEqual([
      '@gestaltrun/fake-own-entry',
      '@gestaltrun/fake-mounts',
      '@gestaltrun/dsh-client-ui-plugin-manager',
    ])
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(console.error).toHaveBeenCalledWith(
      '[dsh-web-all] client child degraded: @gestaltrun/fake-sync-throw',
      expect.any(Error),
    )
  })

  it('honours the shared mount registry across instances', async () => {
    bootWith([])
    ;(globalThis as Record<symbol, unknown>)[MOUNTED_PLUGINS] = new Set(['@gestaltrun/fake-mounts'])
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted.map((def) => def.name)).toEqual([
      '@gestaltrun/fake-own-entry',
      '@gestaltrun/fake-sync-throw',
      '@gestaltrun/dsh-client-ui-plugin-manager',
    ])
  })

  it('hides children whose family row is inactive (#1372 row gating)', async () => {
    bootWith([])
    rowsRouteAnswer([
      '@gestaltrun/fake-own-entry',
      '@gestaltrun/fake-sync-throw',
      '@gestaltrun/fake-no-apply',
      // @gestaltrun/fake-mounts disabled through a user patch override
      '@gestaltrun/dsh-client-ui-plugin-manager',
    ])
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted.map((def) => def.name)).toEqual([
      '@gestaltrun/fake-own-entry',
      '@gestaltrun/fake-sync-throw',
      '@gestaltrun/dsh-client-ui-plugin-manager',
    ])
  })

  it('fails open when the rows route answers a non-200', async () => {
    bootWith([])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted).toHaveLength(4)
  })

  it('fails open when the rows payload shape is wrong', async () => {
    bootWith([])
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, children: ['@gestaltrun/fake-mounts', 42] }),
    })))
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted).toHaveLength(4)
  })

  it('fails open when the rows answer is not json', async () => {
    bootWith([])
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => { throw new Error('invalid json') },
    })))
    const { ctx, mounted } = fakeCtx()
    await mountClientChildren(ctx)
    expect(mounted).toHaveLength(4)
  })
})
