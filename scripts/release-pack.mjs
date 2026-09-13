#!/usr/bin/env node
/** Build and pack the complete Gestaltrun plugin family without publishing. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalizeGzip } from './canonical-gzip.mjs'
import { walkFamilyPackages } from './lib/family-packages.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const REPOSITORY = 'gestaltrun/dsh-web'
export const SCOPE = '@gestaltrun/'
export const SIDEBAR = '@gestaltrun/dsh-better-sidebar'
export const SIDEBAR_VERSION = '0.19.1-gestaltrun.0'

/** Invoke the package manager which launched this script through the current Node executable. */
export function runPnpm(args, options, cli = process.env.npm_execpath) {
  if (!cli || !/(?:^|[\\/])pnpm(?:\.[cm]?js)?$/.test(cli)) throw new Error('Run this command through the repository-pinned pnpm release:pack script')
  return execFileSync(process.execPath, [cli, ...args], options)
}

/** Require fork ownership, one cohort version, and registry-safe dependency names. */
export function validatePackage(pkg, version, { packed = false } = {}) {
  if (!pkg.name?.startsWith(`${SCOPE}dsh-`) || pkg.private === true) throw new Error(`Not a publishable Gestaltrun package: ${pkg.name}`)
  if (pkg.version !== version || !/^\d+\.\d+\.\d+(?:-gestaltrun\.\d+)?$/.test(version)) throw new Error(`Unexpected family version: ${pkg.name}@${pkg.version}`)
  if (pkg.repository?.url?.replace(/^git\+/, '') !== `https://github.com/${REPOSITORY}.git`) throw new Error(`Unexpected repository: ${pkg.name}`)
  if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/' || pkg.publishConfig?.access !== 'public') throw new Error(`Unexpected npm destination: ${pkg.name}`)
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (name.startsWith('@linxin666/') || name === 'dsh-better-sidebar') throw new Error(`Upstream plugin dependency: ${name}`)
      if (packed && /^(workspace:|file:|link:)/.test(range)) throw new Error(`Local dependency in artifact: ${name}`)
      if (name.startsWith(SCOPE) && name !== SIDEBAR && range !== version && !(range === 'workspace:*' && !packed)) throw new Error(`Family dependency version mismatch: ${name}@${range}`)
      if (name === SIDEBAR && range !== SIDEBAR_VERSION) throw new Error(`Unexpected sidebar version: ${range}`)
    }
  }
}

/** Read the manifest contained in an npm tarball, without extracting files. */
export function tarballPackage(path) {
  return JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }))
}

/** Validate the packed manifest and reject stale modules with the upstream npm identity. */
export function validateTarball(path, version) {
  const pkg = tarballPackage(path)
  validatePackage(pkg, version, { packed: true })
  const entries = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n')
  for (const entry of entries) {
    if (!entry.startsWith('package/') || entry.split('/').includes('..')) throw new Error('Invalid archive entry')
    if (!/\.(?:[cm]?js|yml)$/.test(entry)) continue
    const text = execFileSync('tar', ['-xOf', path, entry], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (text.includes('@linxin666/')) throw new Error(`Upstream npm identity in executable artifact: ${entry}`)
    if (text.includes('https://dsh-market.com/api/telemetry/event')) throw new Error(`Workshop install telemetry in executable artifact: ${entry}`)
  }
  return pkg
}

/** Hash the exact archive bytes which will be installed or published. */
export function integrity(path) {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
}

/** Install an unpublished sidebar archive for local builds while preserving committed config. */
export function installSidebarOverride(tarball, root = ROOT) {
  const path = resolve(tarball)
  const pkg = tarballPackage(path)
  if (pkg.name !== SIDEBAR || pkg.version !== SIDEBAR_VERSION) throw new Error('Sidebar override must contain the pinned Gestaltrun package')
  const workspacePath = join(root, 'pnpm-workspace.yaml')
  const lockPath = join(root, 'pnpm-lock.yaml')
  const workspace = readFileSync(workspacePath, 'utf8')
  const lock = readFileSync(lockPath)
  if (/^overrides:/m.test(workspace)) throw new Error('Local sidebar installation requires merging an existing overrides mapping')
  writeFileSync(workspacePath, `${workspace.trimEnd()}\n\noverrides:\n  '${SIDEBAR}': ${JSON.stringify(`file:${path}`)}\n`)
  try {
    runPnpm(['install', '--no-frozen-lockfile', '--ignore-scripts'], { cwd: root, stdio: 'inherit' })
  } finally {
    writeFileSync(workspacePath, workspace)
    writeFileSync(lockPath, lock)
  }
}

/** Build, validate, and write the owned family archives plus their integrity manifest. */
export function packFamily({ out, sidebarTarball, root = ROOT }) {
  const output = resolve(out)
  mkdirSync(output, { recursive: true })
  const family = walkFamilyPackages(root).map(({ dir, pkgPath }) => ({ dir, pkg: JSON.parse(readFileSync(pkgPath, 'utf8')) })).filter(({ pkg }) => !pkg.private)
  if (family.length === 0) throw new Error('No publishable family packages')
  const version = family[0].pkg.version
  for (const { pkg } of family) validatePackage(pkg, version)
  if (sidebarTarball) installSidebarOverride(sidebarTarball, root)
  execFileSync(process.execPath, ['scripts/sync-shared.mjs', '--check'], { cwd: root, stdio: 'inherit' })
  execFileSync(process.execPath, ['scripts/aggregate.mjs', '--check'], { cwd: root, stdio: 'inherit' })
  // Build tools preserve companion chunks; remove prior outputs before packaging.
  for (const { dir } of family) rmSync(join(dir, 'lib'), { recursive: true, force: true })
  runPnpm(['build'], { cwd: root, stdio: 'inherit' })
  const artifacts = []
  for (const { pkg } of family) {
    runPnpm(['--config.ignore-scripts=true', '--filter', pkg.name, 'pack', '--pack-destination', output], { cwd: root, stdio: 'inherit' })
    const filename = `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`
    const path = join(output, filename)
    if (!existsSync(path)) throw new Error(`Missing package archive: ${filename}`)
    writeFileSync(path, canonicalizeGzip(readFileSync(path)))
    validateTarball(path, version)
    artifacts.push({ name: pkg.name, version: pkg.version, filename, integrity: integrity(path) })
  }
  const manifest = { schemaVersion: 1, repository: REPOSITORY, version, packages: artifacts }
  writeFileSync(join(output, 'gestaltrun-packages.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter(arg => arg !== '--'), options: { out: { type: 'string' }, 'sidebar-tarball': { type: 'string' } } })
  if (!values.out) throw new Error('Usage: pnpm release:pack --out <directory> [--sidebar-tarball <archive>]')
  console.log(JSON.stringify(packFamily({ out: values.out, sidebarTarball: values['sidebar-tarball'] }), null, 2))
}
