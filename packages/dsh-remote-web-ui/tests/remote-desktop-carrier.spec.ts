// @vitest-environment jsdom
/** Native remote controls retain Desktop's Fetch and WebSocket carriers. */
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.unstubAllGlobals()
})

it('registers native pairing and settings controls without rewriting transports or starting phone effects', () => {
  vi.stubGlobal('window', new Proxy(window, {
    get(target, key) {
      return key === 'location' ? new URL('dsh-app://app/') : Reflect.get(target, key, target)
    },
  }))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const OriginalWebSocket = window.WebSocket
  const originalHtml = document.documentElement.outerHTML
  const listeners = new Set<() => void>()
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { enabled: true, requirePairingForLan: true }, writable: true, base: {}, stored: {} }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const registered: string[] = []
  const ctx = {
    effect(factory: () => () => void) { const dispose = factory(); disposers.push(dispose); return dispose },
    get: () => undefined,
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    settingsScope: { bind: () => scope },
    slots: {
      inject(_name: string, factory: () => () => void) { disposers.push(factory()) },
      register(spec: { name: string }) { registered.push(spec.name); return () => {} },
    },
  } as unknown as Parameters<typeof apply>[0]
  apply(ctx)
  for (const listener of listeners) listener()
  expect(registered).toEqual(['sidebar.footer.action', 'web-ui.plugin.item'])
  expect(fetch).not.toHaveBeenCalled()
  expect(window.fetch).toBe(fetch)
  expect(window.WebSocket).toBe(OriginalWebSocket)
  expect(document.documentElement.outerHTML).toBe(originalHtml)
})

it('leaves other custom-protocol hosts inert', () => {
  vi.stubGlobal('window', new Proxy(window, {
    get(target, key) { return key === 'location' ? new URL('other-app://app/') : Reflect.get(target, key, target) },
  }))
  const contextRead = vi.fn(() => { throw new Error('Unexpected plugin activation') })
  apply(new Proxy({} as Parameters<typeof apply>[0], { get: contextRead }))
  expect(contextRead).not.toHaveBeenCalled()
})
