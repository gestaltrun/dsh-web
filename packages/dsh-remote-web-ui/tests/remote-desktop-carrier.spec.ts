// @vitest-environment jsdom
/** Remote UI registration must leave Desktop's transport and UI untouched. */
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

// Context reads would start registering effects, slots, settings, or subscriptions.
const contextRead = vi.fn(() => { throw new Error('Desktop must not activate the remote UI') })

afterEach(() => {
  vi.unstubAllGlobals()
  contextRead.mockClear()
})

it('does not register remote entries or probe pairing from the Desktop page', () => {
  vi.stubGlobal('window', new Proxy(window, {
    get(target, key) {
      return key === 'location' ? new URL('dsh-app://app/') : Reflect.get(target, key, target)
    },
  }))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const OriginalWebSocket = window.WebSocket
  const originalHtml = document.documentElement.outerHTML
  const ctx = new Proxy({} as Parameters<typeof apply>[0], { get: contextRead })
  apply(ctx)
  expect(contextRead).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(window.fetch).toBe(fetch)
  expect(window.WebSocket).toBe(OriginalWebSocket)
  expect(document.documentElement.outerHTML).toBe(originalHtml)
})
