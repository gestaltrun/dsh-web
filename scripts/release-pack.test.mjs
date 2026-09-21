/** Publication rejects foreign identities and local dependency specifications. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { packFamily, validateSidebarCandidate, integrity, REPOSITORY, runPnpm, validatePackage, validateTarball } from './release-pack.mjs'
import { validateArtifacts } from './release-publish.mjs'

const version = '0.3.21-gestaltrun.0'
function manifest() {
  return { name: '@gestaltrun/dsh-fixture', version, repository: { url: `https://github.com/${REPOSITORY}.git` }, publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' }, dependencies: { '@gestaltrun/dsh-better-sidebar': '0.19.1-gestaltrun.1' } }
}

test('only the fork namespace and repository can publish', () => {
  const pkg = manifest()
  assert.doesNotThrow(() => validatePackage(pkg, version, { packed: true }))
  for (const change of [{ name: '@linxin666/dsh-fixture' }, { repository: { url: 'https://github.com/zhu1090093659/dsh-web.git' } }, { version: '0.3.21' }, { private: true }, { publishConfig: { registry: 'https://example.org/' } }]) {
    assert.throws(() => validatePackage({ ...pkg, ...change }, version, { packed: true }))
  }
})

test('installed artifacts cannot refer back to upstream or a local filesystem', () => {
  for (const dependencies of [{ 'dsh-better-sidebar': '0.19.0' }, { '@linxin666/dsh-pet': '0.3.21' }, { '@gestaltrun/dsh-pet': 'workspace:*' }, { '@gestaltrun/dsh-pet': 'file:../pet' }, { '@gestaltrun/dsh-pet': '0.3.20' }, { '@gestaltrun/dsh-better-sidebar': '0.19.0' }]) {
    assert.throws(() => validatePackage({ ...manifest(), dependencies }, version, { packed: true }))
  }
})

test('publication verifies actual tarball bytes and the complete owned package set', () => {
  const root = mkdtempSync(join(tmpdir(), 'gestaltrun-publish-'))
  try {
    const pkg = manifest()
    const dir = join(root, 'packages', 'fixture')
    const stage = join(root, 'package')
    mkdirSync(dir, { recursive: true })
    mkdirSync(stage)
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg))
    const filename = 'fixture.tgz'
    const tarball = join(root, filename)
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
    const artifact = { name: pkg.name, version, filename, integrity: integrity(tarball) }
    const path = join(root, 'gestaltrun-packages.json')
    const index = { schemaVersion: 1, repository: REPOSITORY, version, packages: [artifact] }
    writeFileSync(path, JSON.stringify(index))
    assert.equal(validateArtifacts(root, { root, repository: REPOSITORY }).length, 1)
    assert.throws(() => validateArtifacts(root, { root, repository: 'upstream/dsh-web' }), /restricted/)
    writeFileSync(path, JSON.stringify({ ...index, packages: [] }))
    assert.throws(() => validateArtifacts(root, { root }), /Incomplete/)
    writeFileSync(path, JSON.stringify({ ...index, packages: [artifact, artifact] }))
    assert.throws(() => validateArtifacts(root, { root }), /duplicate/)
    writeFileSync(path, JSON.stringify({ ...index, packages: [{ ...artifact, filename: '../fixture.tgz' }] }))
    assert.throws(() => validateArtifacts(root, { root }), /filename/)
    writeFileSync(path, JSON.stringify(index))
    writeFileSync(join(stage, 'stale.js'), "import '@linxin666/dsh-fixture'\n")
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
    assert.throws(() => validateTarball(tarball, version), /Upstream npm identity/)
    writeFileSync(join(stage, 'stale.js'), "fetch('https://dsh-market.com/api/telemetry/event')\n")
    execFileSync('tar', ['-czf', tarball, '-C', root, 'package'])
    assert.throws(() => validateTarball(tarball, version), /Workshop install telemetry/)
    writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from('tampered')]))
    assert.throws(() => validateArtifacts(root, { root }), /digest/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('the package manager receives literal paths and arguments without a command shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'gestaltrun pnpm '))
  try {
    const cli = join(root, 'pnpm.cjs')
    writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    const args = ['pack', '--pack-destination', join(root, 'out with spaces'), '$(touch injected)', '`touch injected`']
    assert.deepEqual(JSON.parse(runPnpm(args, { cwd: root, encoding: 'utf8' }, cli)), args)
    assert.throws(() => runPnpm([], {}, 'pnpm.cmd'), /repository-pinned/)
    assert.throws(() => runPnpm([], {}, ''), /repository-pinned/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('candidate Sidebar requires exact producer bytes and the selected version', () => {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-candidate-'));
  try {
    mkdirSync(join(root, 'package'));
    const file = join(root, 'package/package.json');
    const archive = join(root, 'sidebar.tgz');
    writeFileSync(file, JSON.stringify({ name: '@gestaltrun/dsh-better-sidebar', version: '0.19.1-gestaltrun.1' }));
    execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
    validateSidebarCandidate(archive, integrity(archive));
    assert.throws(() => validateSidebarCandidate(archive));
    assert.throws(() => validateSidebarCandidate(archive, 'sha512-' + 'A'.repeat(86) + '=='));
    writeFileSync(file, JSON.stringify({ name: '@gestaltrun/dsh-better-sidebar', version: '0.19.1-gestaltrun.0' }));
    execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
    assert.throws(() => validateSidebarCandidate(archive, integrity(archive)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [options, args] of [
  [{ sidebarTarball: '/candidate.tgz' }, ['--sidebar-tarball', '/candidate.tgz']],
  [{ sidebarIntegrity: 'sha512-candidate' }, ['--sidebar-integrity', 'sha512-candidate']],
]) {
  test(`rejects unmatched candidate input before output or installation: ${args[0]}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'sidebar-input-pair-'));
    try {
      const out = join(root, 'output');
      assert.throws(() => packFamily({ out, root, ...options }), /Supply both/);
      assert.equal(existsSync(out), false);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release-pack.mjs', import.meta.url)),
        '--out', out, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Supply both/);
      assert.equal(existsSync(out), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
