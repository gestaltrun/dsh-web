#!/usr/bin/env node
/** Publish only the previously validated Gestaltrun archives to npm. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { integrity, REPOSITORY, validateTarball } from './release-pack.mjs'
import { walkFamilyPackages } from './lib/family-packages.mjs'

/** Reject foreign, incomplete, or modified artifact sets before the first publication. */
export function validateArtifacts(directory, { repository = process.env.GITHUB_REPOSITORY, root = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  if (repository && repository !== REPOSITORY) throw new Error('Publishing is restricted to gestaltrun/dsh-web')
  const manifest = JSON.parse(readFileSync(join(directory, 'gestaltrun-packages.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY || !Array.isArray(manifest.packages)) throw new Error('Invalid Gestaltrun artifact manifest')
  const expected = new Map(walkFamilyPackages(root).map(({ pkgPath }) => JSON.parse(readFileSync(pkgPath, 'utf8'))).filter(pkg => !pkg.private).map(pkg => [pkg.name, pkg.version]))
  const seen = new Set()
  const validated = []
  for (const artifact of manifest.packages) {
    if (typeof artifact.filename !== 'string' || basename(artifact.filename) !== artifact.filename || !artifact.filename.endsWith('.tgz')) throw new Error('Invalid artifact filename')
    const path = join(directory, artifact.filename)
    if (integrity(path) !== artifact.integrity) throw new Error(`Artifact digest mismatch: ${artifact.filename}`)
    const pkg = validateTarball(path, manifest.version)
    if (pkg.name !== artifact.name || pkg.version !== artifact.version || expected.get(pkg.name) !== pkg.version || seen.has(pkg.name)) throw new Error('Unexpected or duplicate family archive')
    seen.add(pkg.name)
    validated.push({ path, pkg })
  }
  if (seen.size !== expected.size || expected.size === 0) throw new Error('Incomplete plugin family')
  // Child packages become available before the aggregate which depends on them.
  return validated.sort((a, b) => Number(a.pkg.name.endsWith('/dsh-web-all')) - Number(b.pkg.name.endsWith('/dsh-web-all')))
}

/** Select exact family dependencies and required peers after validating the complete archive inventory. */
export function selectRequiredArtifacts(artifacts, roots) {
  if (roots.length === 0) return artifacts
  const byName = new Map(artifacts.map(artifact => [artifact.pkg.name, artifact]))
  const selected = new Set()
  const visiting = new Set()
  const ordered = []
  const visit = (name) => {
    if (selected.has(name)) return
    const artifact = byName.get(name)
    if (artifact === undefined) throw new Error(`Missing required family archive: ${name}`)
    if (visiting.has(name)) throw new Error(`Cyclic family dependency: ${name}`)
    visiting.add(name)
    const peers = Object.fromEntries(Object.entries(artifact.pkg.peerDependencies ?? {})
      .filter(([peer]) => artifact.pkg.peerDependenciesMeta?.[peer]?.optional !== true))
    const dependencies = { ...artifact.pkg.dependencies, ...artifact.pkg.optionalDependencies, ...peers }
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (!dependency.startsWith('@gestaltrun/') || dependency === '@gestaltrun/dsh-better-sidebar') continue
      const target = byName.get(dependency)
      if (target === undefined) throw new Error(`Missing required family archive: ${dependency}`)
      if (target.pkg.version !== version) throw new Error(`Required family version mismatch: ${dependency}@${version}`)
      visit(dependency)
    }
    visiting.delete(name)
    selected.add(name)
    ordered.push(artifact)
  }
  for (const root of roots) {
    if (!byName.has(root)) throw new Error(`Unknown release root: ${root}`)
    visit(root)
  }
  return ordered
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter(arg => arg !== '--'), options: { from: { type: 'string' }, tag: { type: 'string', default: 'latest' }, 'dry-run': { type: 'boolean', default: false }, root: { type: 'string', multiple: true }, list: { type: 'boolean', default: false } } })
  if (!values.from || !/^[a-z][a-z0-9-]*$/.test(values.tag)) throw new Error('Usage: pnpm release:publish --from <directory> [--tag latest] [--root <package>] [--list] [--dry-run]')
  if (process.platform === 'win32') throw new Error('Publish npm archives through the Linux release workflow; Windows supports release:pack')
  const artifacts = selectRequiredArtifacts(validateArtifacts(resolve(values.from)), values.root ?? [])
  if (values.list) {
    console.log(JSON.stringify({ packages: artifacts.map(({ path, pkg }) => ({ name: pkg.name, version: pkg.version, filename: basename(path), integrity: integrity(path) })) }, null, 2))
    process.exit(0)
  }
  for (const { path, pkg } of artifacts) {
    const args = ['publish', path, '--registry', 'https://registry.npmjs.org/', '--access', 'public', '--tag', values.tag]
    if (values['dry-run']) args.push('--dry-run')
    if (process.env.GITHUB_ACTIONS === 'true' && !values['dry-run']) args.push('--provenance')
    execFileSync('npm', args, { stdio: 'inherit' })
    console.log(`Published ${pkg.name}@${pkg.version}${values['dry-run'] ? ' (dry run)' : ''}`)
  }
}
