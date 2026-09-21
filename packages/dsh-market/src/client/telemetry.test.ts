/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportDailyHeartbeat } from './telemetry.ts'

describe('disabled Workshop install telemetry', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([false, true])('does not send or touch browser state with webdriver=%s', (webdriver) => {
    const values = new Map([['dsh-web-ui-telemetry-visitor', 'existing-user-data']])
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    }
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    const randomUUID = vi.fn(() => '0123456789abcdef0123456789abcdef')
    vi.stubGlobal('navigator', { webdriver })
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID })
    reportDailyHeartbeat([{ name: '@gestaltrun/dsh-pet', version: '0.3.21-gestaltrun.1' }])
    reportDailyHeartbeat([{ name: 'skin:blue-fantasy', channel: 'npm' }])
    expect(fetch).not.toHaveBeenCalled()
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(randomUUID).not.toHaveBeenCalled()
    expect([...values]).toEqual([['dsh-web-ui-telemetry-visitor', 'existing-user-data']])
  })
})
