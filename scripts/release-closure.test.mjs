import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRequiredArtifacts } from './release-publish.mjs'
const version = '0.3.21-gestaltrun.1'
const row = (name, fields = {}) => ({ path: `${name}.tgz`, pkg: { name: `@gestaltrun/${name}`, version, ...fields } })
const child = row('dsh-child')
const peer = row('dsh-peer')
const optional = row('dsh-optional')
const market = row('dsh-client-ui-market')
const aggregate = row('dsh-web-all', { dependencies: { '@gestaltrun/dsh-child': version, '@gestaltrun/dsh-better-sidebar': '0.19.1-gestaltrun.1' }, optionalDependencies: { '@gestaltrun/dsh-optional': version }, peerDependencies: { '@gestaltrun/dsh-peer': version, '@gestaltrun/dsh-client-ui-market': version }, peerDependenciesMeta: { '@gestaltrun/dsh-client-ui-market': { optional: true } } })
test('selects dependency, optional dependency and required peer archives before the root', () => {
  const rows = [aggregate, market, child, peer, optional]
  assert.deepEqual(selectRequiredArtifacts(rows, ['@gestaltrun/dsh-web-all']).map(row => row.pkg.name), ['@gestaltrun/dsh-child', '@gestaltrun/dsh-optional', '@gestaltrun/dsh-peer', '@gestaltrun/dsh-web-all'])
  assert.deepEqual(selectRequiredArtifacts(rows, []), rows)
})
test('rejects an unknown root, missing package and mismatched exact version', () => {
  assert.throws(() => selectRequiredArtifacts([aggregate, child, peer, optional], ['@linxin666/dsh-web-all']), /Unknown release root/)
  assert.throws(() => selectRequiredArtifacts([aggregate, child, optional], ['@gestaltrun/dsh-web-all']), /Missing required family archive/)
  assert.throws(() => selectRequiredArtifacts([aggregate, { ...child, pkg: { ...child.pkg, version: '0.3.21-gestaltrun.0' } }, peer, optional], ['@gestaltrun/dsh-web-all']), /Required family version mismatch/)
})
