/**
 * The mirror, measured against the thing it mirrors.
 *
 * `src/gate.ts` repeats the profile gate's peer reading in a few lines of semver.
 * A copy is exactly the kind of code that drifts: the upstream rule could gain a
 * condition and this package would keep describing the old one, while its own
 * tests — written against the copy — stayed green. So the suite imports the gate
 * itself, `@deepseek-ai/dsh-app-boot`, and compares the two verdicts over a matrix
 * of versions and ranges.
 *
 * The equivalence is asserted as the gate reports it: `evaluatePluginCompatibility`
 * returns `undefined` when every dsh peer is satisfied, and a record when one is
 * not, so a version is gate-admitted exactly when that call returns `undefined`.
 * The `workspace:` spellings are compared with the alias resolved the way the
 * audit resolves it — to the version being tested, which is the gate's own
 * resolution when it judges a plugin running as that version.
 *
 * The second half of the file pins the substitution the tool rests on: the
 * version of `@deepseek-ai/dsh-tools` stands in for the runtime's. That is only
 * sound if the dsh packages ship the same versions — measured from the registry
 * on 2026-10-09 as 31 identical version strings for `dsh-tools`, `dsh-app-boot`
 * and `dsh-agent` — and the pins this package carries are asserted here to agree
 * in the tree the tests actually run in.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { admits, WORKSPACE_ALIASES } from '../lib/gate.js'
import { LADDER, RUNTIME, manifest } from './fixtures.mjs'

/** Ranges the matrix walks: the measured ones, the shapes an author writes, and the ones that do not parse. */
const RANGES = [
  '^0.2.0', '^0.1.6', '~0.2.0-rc.1', '0.2.0-rc.2', '*', '>=0.1.0 <0.2.0',
  '>=0.1.7-alpha.1 <0.2.0', '>=0.2.0-rc.1 <0.2.0 || >=0.1.7-alpha.1 <0.2.0',
  '>=0.1.2 <0.2.0-0', 'workspace:^', 'workspace:~', 'workspace:*',
  '', '   ', 'not-a-range', 'latest',
]

/** Versions the matrix walks: the ladder plus versions either side of it. */
const VERSIONS = [...LADDER, '0.0.1', '0.2.1', '1.0.0']

/** The requirement the audit would test for a declared range. */
function requirementOf(declared, version) {
  return WORKSPACE_ALIASES.includes(declared) ? version : declared
}

test('the mirror agrees with the gate on every version and range in the matrix', () => {
  let compared = 0
  for (const version of VERSIONS) {
    for (const range of RANGES) {
      const issue = evaluatePluginCompatibility(manifest(range), {}, version)
      const gateAdmits = issue === undefined
      const mirrored = admits(version, requirementOf(range, version), 'gate')
      assert.equal(mirrored, gateAdmits, `gate(${JSON.stringify(range)}, ${version})`)
      compared += 1
    }
  }
  // A matrix that collapsed to a handful of cases would prove little; the count
  // is asserted so a broken fixture cannot make this file vacuous.
  assert.equal(compared, VERSIONS.length * RANGES.length)
  assert.ok(compared > 400, `expected a wide matrix, compared ${compared}`)
})

test('the gate admits a range the plain reading refuses, at the prerelease runtime', () => {
  // The divergence the whole package exists to report, taken from the gate
  // itself rather than from the mirror.
  const range = '>=0.1.7-alpha.1 <0.2.0'
  assert.equal(evaluatePluginCompatibility(manifest(range), {}, RUNTIME), undefined, 'the gate admits it')
  assert.equal(admits(RUNTIME, range, 'plain'), false, 'plain semver refuses it')
})

test('the mirror matches the gate for a range that does not parse, without throwing', () => {
  // The gate answers "incompatible" rather than throwing here, and the audit has
  // to say the same thing rather than refuse the whole report.
  const issue = evaluatePluginCompatibility(manifest('not-a-range'), {}, RUNTIME)
  assert.notEqual(issue, undefined, 'the gate reports the peer as incompatible')
  assert.deepEqual(issue.peers, { '@deepseek-ai/dsh-tools': 'not-a-range' })
  assert.equal(admits(RUNTIME, 'not-a-range', 'gate'), false)
})

test('the gate throws on a non-string range, which is why the audit reports it as unreadable', () => {
  assert.throws(
    () => evaluatePluginCompatibility({ name: 'p', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': 1 } }, {}),
    /must be a string/,
  )
})

test('the gate is not consulted for a peer that is not a dsh package', () => {
  const issue = evaluatePluginCompatibility({ name: 'p', version: '1.0.0', peerDependencies: { react: '^99.0.0' } }, {}, RUNTIME)
  assert.equal(issue, undefined, 'a non-dsh peer cannot make a plugin incompatible')
})

test('the version the audit reads stands in for the runtime version in this tree', () => {
  // The substitution, asserted where it is used: if the pins in this package ever
  // disagreed, the tool would report a runtime line for a version it is not
  // running as, and this is the assertion that would fail first.
  const installed = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/package.json'), 'utf8'))
  assert.equal(installed.version, getDshRuntimeVersion())
})
