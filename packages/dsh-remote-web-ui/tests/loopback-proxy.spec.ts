/**
 * The loopback reverse proxy's connection lifecycle over real HTTP servers:
 * an outer-client abort must stop the inner request, an inner reset must tear
 * the outer leg down without an unhandled error, and normal completion must
 * keep reusing the upstream keep-alive connection.
 */
import { Agent, createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { setImmediate as immediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { proxyLoopbackHttp } from '../src/loopback-proxy.ts'
import { PairingService } from '../src/pairing.ts'
import { makeRemoteApiRoutes } from '../src/remote-api.ts'

interface TestServer {
  port: number
  close: () => Promise<void>
}

async function listen(server: Server): Promise<TestServer> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
  }
}

/** Outer server whose every request is proxied to the given port. */
async function serveProxy(port: number): Promise<TestServer> {
  const server: Server = createServer((req, res) => { proxyLoopbackHttp(req, res, port, req.url ?? '/') })
  return await listen(server)
}

/** One client request; resolves with status, collected body, and the abort error if any. */
function call(port: number, opts: { method?: string; chunked?: boolean } = {}): Promise<{
  status: number | undefined
  body: string
  premature: boolean
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', ...(opts.chunked === true ? {} : {}) },
      (res) => {
        const chunks: Buffer[] = []
        let premature = false
        res.on('data', (chunk) => { chunks.push(chunk as Buffer) })
        res.on('error', () => { premature = true })
        res.on('close', () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), premature })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const settle = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Poll a predicate until it holds or the deadline passes, then return its final
 * value. The proxy propagates an outer abort asynchronously; a loaded runner can
 * take longer than any fixed sleep, and polling keeps the assertion strict while
 * removing the load sensitivity (the deadline still fails a real regression).
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await settle(stepMs)
  }
  return predicate()
}

describe('loopback proxy connection lifecycle', () => {
  it('stops the inner request when the outer client aborts mid-body', async () => {
    let innerCompleted = false
    let innerAborted = false
    const upstream: Server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        innerCompleted = true
        res.writeHead(200)
        res.end('ok')
      })
      // A proxy-side reset surfaces as ECONNRESET / 'aborted' on the inner request.
      req.on('error', () => { innerAborted = true })
      req.on('aborted', () => { innerAborted = true })
    })
    const up = await listen(upstream)
    const proxy = await serveProxy(up.port)
    try {
      // A chunked POST whose body never finishes: abort mid-flight.
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'POST' })
        req.on('error', () => { resolve() })
        req.write('partial-body-half')
        setTimeout(() => {
          req.destroy()
          resolve()
        }, 30)
      })
      const aborted = await waitFor(() => innerAborted)
      expect(innerCompleted).toBe(false)
      expect(aborted).toBe(true)
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  it('tears the outer leg down when the inner response dies mid-stream', async () => {
    const upstream: Server = createServer((req, res) => {
      // Announce a longer body than will ever be sent, then truncate.
      res.writeHead(200, { 'content-length': '64' })
      res.write('half-')
      setTimeout(() => { res.destroy() }, 20)
    })
    const up = await listen(upstream)
    const proxy = await serveProxy(up.port)
    try {
      const result = await call(proxy.port)
      expect(result.status).toBe(200)
      expect(result.body).toBe('half-')
      expect(result.premature).toBe(true)
    } finally {
      await proxy.close()
      await up.close()
    }
  })

  it('keeps the upstream keep-alive connection across sequential proxied requests', async () => {
    let connections = 0
    const upstream: Server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('hello')
      })
    })
    upstream.on('connection', () => { connections += 1 })
    const up = await listen(upstream)
    const proxy = await serveProxy(up.port)
    try {
      for (let i = 0; i < 5; i += 1) {
        const result = await call(proxy.port)
        expect(result.status).toBe(200)
        expect(result.body).toBe('hello')
        expect(result.premature).toBe(false)
      }
      // One pooled socket serves every request: a naive close-hook that
      // destroyed the upstream on normal completion would open five.
      expect(connections).toBe(1)
    } finally {
      await proxy.close()
      await up.close()
    }
  })
})

for (const action of ['revoke', 'stop'] as const) {
  it(`closes the pending inner connection when ${action} occurs before response headers`, async () => {
    const service = new PairingService({ tokenTtlMs: 60_000, offlineAfterMs: 10_000, maxDevices: 4, cookieName: 'test_pair' })
    service.setLanBases([{ address: '192.0.2.10', base: 'http://192.0.2.10:3080' }])
    const accepted = service.accept(service.issue().token)
    if (!accepted.ok) throw new Error('Pairing failed')
    const entered = Promise.withResolvers<{ req: IncomingMessage; res: ServerResponse }>()
    const inner = createServer((req, res) => {
      req.resume()
      req.on('end', () => { entered.resolve({ req, res }) })
    })
    let outer: Server | undefined
    let caller: ClientRequest | undefined
    try {
      const upstream = await listen(inner)
      const [route] = makeRemoteApiRoutes({ service, port: upstream.port })
      outer = createServer((req, res) => { void route.handler(req, res) })
      const proxy = await listen(outer)
      const failed = Promise.withResolvers<Error>()
      caller = httpRequest({ host: '127.0.0.1', port: proxy.port, path: '/remote/api/probe', headers: { cookie: `test_pair=${accepted.deviceId}` } })
      caller.on('error', failed.resolve)
      caller.end()
      const active = await entered.promise
      if (action === 'revoke') service.revoke(accepted.deviceId)
      else service.stop()
      expect(await failed.promise).toMatchObject({ code: 'ECONNRESET' })
      expect(await waitFor(() => active.req.socket.destroyed && active.res.destroyed)).toBe(true)
      const connections = await new Promise<number>((resolve, reject) => {
        inner.getConnections((error, count) => { if (error) reject(error); else resolve(count) })
      })
      expect(connections).toBe(0)
    } finally {
      caller?.destroy()
      outer?.closeAllConnections()
      inner.closeAllConnections()
      await Promise.all([outer, inner].map(server => server === undefined ? undefined : new Promise<void>(resolve => { server.close(() => { resolve() }) })))
    }
  })
}

it('does not create an inner socket after the outer client closes while waiting for inner authentication', async () => {
  const entered = Promise.withResolvers<void>()
  const authenticated = Promise.withResolvers<string>()
  const outerClosed = Promise.withResolvers<void>()
  let connections = 0
  const inner = createServer((_req, res) => { res.end('unexpected request') })
  inner.on('connection', () => { connections++ })
  let outer: Server | undefined
  let caller: ClientRequest | undefined
  const connect = vi.spyOn(Agent.prototype, 'createConnection')
  try {
    const upstream = await listen(inner)
    outer = createServer((req, res) => {
      res.once('close', () => { outerClosed.resolve() })
      proxyLoopbackHttp(req, res, upstream.port, '/probe', {
        ready: () => { entered.resolve(); return authenticated.promise },
        invalidate: () => {},
      })
    })
    const proxy = await listen(outer)
    caller = httpRequest({ host: '127.0.0.1', port: proxy.port })
    caller.on('error', () => { /* This client deliberately closes before authentication resolves. */ })
    caller.end()
    await entered.promise
    caller.destroy()
    await outerClosed.promise
    connect.mockClear()
    authenticated.resolve('inner=credential')
    await immediate()
    expect(connect).not.toHaveBeenCalled()
    expect(connections).toBe(0)
  } finally {
    authenticated.resolve('inner=credential')
    caller?.destroy()
    outer?.closeAllConnections()
    inner.closeAllConnections()
    await Promise.all([outer, inner].map(server => server === undefined ? undefined : new Promise<void>(resolve => { server.close(() => { resolve() }) })))
    connect.mockRestore()
  }
})
