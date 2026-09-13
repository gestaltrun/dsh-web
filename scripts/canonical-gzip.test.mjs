/** Package gzip bytes are independent of the build host's operating system. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import { canonicalizeGzip } from './canonical-gzip.mjs'

test('Linux and macOS archives canonicalize to identical bytes without changing the tar or input', () => {
  const tar = Buffer.from('owned archive fixture\0with payload'.repeat(1000))
  const linux = gzipSync(tar, { level: 1 })
  const mac = gzipSync(tar, { level: 9 })
  linux[9] = 3
  mac[9] = 19
  const first = canonicalizeGzip(linux)
  assert.deepEqual(first, canonicalizeGzip(mac))
  assert.deepEqual(gunzipSync(first), tar)
  assert.equal(first[9], 255)
  assert.equal(linux[9], 3)
  assert.equal(mac[9], 19)
  assert.deepEqual(canonicalizeGzip(first), first)
})

test('invalid headers and corrupt payload checksums are rejected', () => {
  assert.throws(() => canonicalizeGzip(Buffer.from('plain tar')), /plain gzip/)
  for (const [offset, value] of [[0, 0], [2, 7], [3, 2]]) {
    const invalid = gzipSync(Buffer.from('owned fixture'))
    invalid[offset] = value
    assert.throws(() => canonicalizeGzip(invalid), /plain gzip/)
  }
  const invalid = gzipSync(Buffer.from('owned fixture'))
  invalid[invalid.length - 8] ^= 1
  assert.throws(() => canonicalizeGzip(invalid), /incorrect data check/)
})
