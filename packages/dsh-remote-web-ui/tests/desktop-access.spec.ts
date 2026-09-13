/** Desktop settings operate the Host-owned listener and retain mandatory device pairing. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply, type Config } from '../src/index.ts'
import type { DesktopRemoteState } from '../src/desktop-access.ts'
import * as lanBind from '../src/lan-bind.ts'
import * as firewall from '../src/firewall.ts'

vi.mock('../src/lan.ts', () => ({ lanIPv4Addresses: () => ['192.0.2.10'] }))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

it('applies live LAN and disable settings without writing Web profile blocks or running firewall commands', async () => {
  const ctx = new Context()
  const home = mkdtempSync(join(tmpdir(), 'remote-desktop-settings-'))
  cleanup.push(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  let state: DesktopRemoteState = { host: '127.0.0.1', port: ctx.webServer.port, listening: false }
  const observers = new Set<(value: DesktopRemoteState) => void>()
  const configure = vi.fn(async (selection: { enabled: boolean; lanBind: boolean }) => {
    state = { host: selection.lanBind ? '0.0.0.0' : '127.0.0.1', port: state.port, listening: selection.enabled }
    for (const observer of observers) observer(state)
    return state
  })
  const desktop = {
    initialize: vi.fn(async () => { state = { ...state, listening: true }; return state }),
    configure,
    status: () => state,
    onChange(observer: (value: DesktopRemoteState) => void) { observers.add(observer); return () => { observers.delete(observer) } },
  }
  const profileWrite = vi.spyOn(lanBind, 'writeLanBind')
  const firewallWrite = vi.spyOn(firewall, 'ensureFirewallRule')
  const firewallRemove = vi.spyOn(firewall, 'removeFirewallRule')
  let settings: Config = { enabled: true, requirePairingForLan: false, devicesFile: join(home, 'devices.json'), autoTunnel: false, relay: false }
  let changed: (() => void) | undefined
  ctx.reflect.provide('desktopRemoteAccess', desktop)
  ctx.reflect.provide('settings', {
    installSection(_context: unknown, _name: unknown, _schema: unknown, _base: unknown, hooks: { setSource(source: () => Config): void; onChange(): void }) {
      changed = hooks.onChange
      hooks.setSource(() => settings)
    },
  })
  await ctx.plugin({ inject: ['webServer'], apply }, settings)
  expect(desktop.initialize).toHaveBeenCalledWith(0)
  expect(configure).toHaveBeenLastCalledWith({ enabled: true, lanBind: false })
  expect(changed).toBeTypeOf('function')
  settings = { ...settings, lanBind: true }
  changed!()
  expect(configure).toHaveBeenLastCalledWith({ enabled: true, lanBind: true })
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const frame = await (await fetch(base + '/api/pair/lan-bind')).json()
  expect(frame).toMatchObject({ bindHost: '0.0.0.0', listening: true, pendingRestart: false, firewall: { managed: false } })
  const denied = await fetch(base + '/remote/api/anything')
  expect(denied.status).toBe(403)
  settings = { ...settings, enabled: false }
  changed!()
  expect(configure).toHaveBeenLastCalledWith({ enabled: false, lanBind: true })
  expect(profileWrite).not.toHaveBeenCalled()
  expect(firewallWrite).not.toHaveBeenCalled()
  expect(firewallRemove).not.toHaveBeenCalled()
  settings = { ...settings, enabled: true }
  changed!()
  const issued = await (await fetch(base + '/api/pair/issue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { token: string }
  const accepted = await fetch(base + '/api/pair/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: issued.token }) })
  expect(accepted.status).toBe(200)
  await accepted.json()
  expect(Object.keys(JSON.parse(readFileSync(join(home, 'devices.json'), 'utf8')))).toHaveLength(1)
  await ctx.fiber.dispose()
  expect(Object.keys(JSON.parse(readFileSync(join(home, 'devices.json'), 'utf8')))).toHaveLength(1)
  expect(configure).toHaveBeenLastCalledWith({ enabled: false, lanBind: false })
  expect(observers.size).toBe(0)
})
