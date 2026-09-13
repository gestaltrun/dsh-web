/** Deterministic gzip container for unpublished package archives. */
import { gunzipSync } from 'node:zlib'
import { gzipSync } from 'fflate'

/** Recompress verified tar bytes with pinned fflate, fixed mtime and RFC 1952 OS=255. */
export function canonicalizeGzip(archive) {
  if (archive.length < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b || archive[2] !== 8 || archive[3] !== 0) {
    throw new Error('Expected a plain gzip archive without optional header fields')
  }
  const tar = gunzipSync(archive)
  const canonical = Buffer.from(gzipSync(tar, { level: 9, mtime: 0 }))
  canonical[9] = 255
  if (!gunzipSync(canonical).equals(tar)) throw new Error('Canonical gzip changed the tar payload')
  return canonical
}
