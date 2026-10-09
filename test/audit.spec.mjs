/**
 * The audit engine: what each reading admits, what it says when they differ, and
 * what it refuses to say.
 *
 * The strongest test here is the least obvious one: `MEASURED` rows were produced
 * by a different implementation over the same ladder, and this suite recomputes
 * them from a recorded fixture. Two independent readings of the same rule
 * agreeing on five ranges is evidence; one implementation agreeing with itself
 * is not.
 *
 * The remaining arms are the distinctions the report makes in prose. Each one is
 * a claim a reader could act on, so each one is pinned:
 *
 * - a blank or unparsable range admits nothing and is named as such, rather than
 *   being reported as a divergence of two empty sets;
 * - a version semver cannot parse is listed, never dropped — a dropped typo would
 *   read as a range that admits nothing;
 * - `plain only` is empty in every row, which is the one-way law the report's
 *   header states;
 * - the running-version line distinguishes "both readings agree" from "admission
 *   rests on the gate's prerelease reading alone", because that second sentence
 *   is the whole point of the tool.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { audit, rangesFromManifest, render, LIST_LIMIT } from '../lib/audit.js'
import { admits, isGatePeer, isPrerelease, isValidRange } from '../lib/gate.js'
import { LADDER, MEASURED, RUNTIME, manifest } from './fixtures.mjs'

/** Audit one range over the recorded ladder. */
function auditOne(declared, versions = LADDER, runtimeVersion = RUNTIME) {
  return audit({ ranges: [{ owner: 'probe', declared }], versions, runtimeVersion }).ranges[0]
}

test('the recorded ladder is the fixture the numbers were measured on', () => {
  // A fixture that quietly shrank would make every count below meaningless.
  assert.equal(LADDER.length, 31)
  assert.ok(LADDER.includes('0.1.7-alpha.1') && LADDER.includes('0.2.1-alpha.1'))
})

test('the measured rows reproduce exactly, from a fixture, on this implementation', () => {
  for (const row of MEASURED) {
    const result = auditOne(row.range)
    assert.equal(result.gateAdmits.length, row.gate, `gate count for ${row.range}`)
    assert.equal(result.plainAdmits.length, row.plain, `plain count for ${row.range}`)
    assert.equal(result.gateOnly.length, row.gate - row.plain, `the divergence is the difference: ${row.range}`)
  }
})

test('the gate admits everything plain semver admits, over every measured range', () => {
  // The one-way law the report states. Asserted over the measured rows *and*
  // over the alias, so a change that made the readings cross over in some other
  // place cannot hide behind the rows that happen to agree.
  const ranges = [...MEASURED.map(row => row.range), 'workspace:^', '*', '>=0.1.0']
  for (const range of ranges) {
    const result = auditOne(range)
    assert.deepEqual(result.plainOnly, [], `plain-only members for ${range}: ${result.plainOnly.join(', ')}`)
  }
})

test('a prerelease runtime is admitted by the gate and refused by plain semver', () => {
  // Stated as a property of one version, so the reason for the divergence is
  // visible here rather than only inside a set size.
  const range = '>=0.1.7-alpha.1 <0.2.0'
  assert.equal(admits(RUNTIME, range, 'gate'), true)
  assert.equal(admits(RUNTIME, range, 'plain'), false)
  assert.equal(isPrerelease(RUNTIME), true)
})

test('the two readings agree when the range names the prerelease explicitly', () => {
  const row = MEASURED[3]
  const result = auditOne(row.range)
  assert.equal(result.identical, true)
  assert.equal(result.verdict, 'identical')
  assert.deepEqual([...result.gateAdmits].sort(), [...result.plainAdmits].sort())
})

test('a blank requirement is "empty", not a divergence of two empty sets', () => {
  const result = auditOne('')
  assert.equal(result.kind, 'empty')
  assert.equal(result.verdict, 'empty')
  assert.deepEqual(result.gateAdmits, [])
  assert.deepEqual(result.plainAdmits, [])
  assert.equal(result.identical, true)
})

test('an unparsable requirement is "invalid" and admits nothing', () => {
  assert.equal(isValidRange('not-a-range'), false)
  const result = auditOne('not-a-range')
  assert.equal(result.kind, 'invalid')
  assert.equal(result.verdict, 'invalid')
  assert.deepEqual(result.gateAdmits, [])
})

test('a workspace alias is reported as its own kind, resolved to the running version', () => {
  const result = auditOne('workspace:^')
  assert.equal(result.kind, 'workspace-alias')
  assert.equal(result.verdict, 'workspace-alias')
  assert.equal(result.requirement, RUNTIME)
  assert.deepEqual(result.gateAdmits, [RUNTIME])
  // semver cannot read the alias at all, which is what a plain consumer sees.
  assert.deepEqual(result.plainAdmits, [])
})

test('a workspace alias with no known running version resolves to nothing and says so', () => {
  // Called directly rather than through the helper: a default parameter would
  // turn the explicit `undefined` back into the fixture's runtime version.
  const result = audit({ ranges: [{ owner: 'probe', declared: 'workspace:~' }], versions: LADDER, runtimeVersion: undefined }).ranges[0]
  assert.equal(result.kind, 'workspace-alias')
  assert.equal(result.requirement, '')
  assert.deepEqual(result.gateAdmits, [])
  assert.equal(result.admitsRuntime, undefined)
})

test('a version semver cannot parse is listed, not dropped', () => {
  const result = audit({ ranges: [], versions: [...LADDER, 'v1.2', 'latest'], runtimeVersion: RUNTIME })
  assert.deepEqual(result.invalidVersions, ['v1.2', 'latest'])
  assert.equal(result.versions.length, LADDER.length)
})

test('the ladder is deduplicated in the caller\'s order', () => {
  const result = audit({ ranges: [], versions: ['0.2.0-rc.2', '0.1.7-rc.2', '0.2.0-rc.2'], runtimeVersion: RUNTIME })
  assert.deepEqual(result.versions, ['0.2.0-rc.2', '0.1.7-rc.2'])
})

test('the running-version line names the gate-only case, and only that case', () => {
  const fragile = auditOne('>=0.1.7-alpha.1 <0.2.0')
  assert.equal(fragile.runtimeOnlyUnderGate, true)
  assert.deepEqual(fragile.admitsRuntime, { gate: true, plain: false })

  const agreed = auditOne('>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.0')
  assert.equal(agreed.runtimeOnlyUnderGate, false)
  assert.deepEqual(agreed.admitsRuntime, { gate: true, plain: true })

  const refused = auditOne('^0.2.0')
  assert.deepEqual(refused.admitsRuntime, { gate: false, plain: false })
})

test('ranges read out of a manifest are the ones the gate judges, and only those', () => {
  const ranges = rangesFromManifest({
    name: 'some-plugin',
    peerDependencies: {
      '@deepseek-ai/dsh-tools': '^0.2.0',
      '@deepseek-ai/dsh': '^0.2.0',
      '@deepseek-ai/dsh-agent': 'workspace:^',
      '@deepseek-ai/cordis': '^4.0.2',
      react: '^18.0.0',
      'dsh-something': '^1.0.0',
    },
  }, undefined)
  assert.deepEqual(ranges.map(range => range.declared), ['^0.2.0', '^0.2.0', 'workspace:^'])
  assert.ok(ranges.every(range => range.owner.startsWith('some-plugin → @deepseek-ai/dsh')))
  assert.equal(isGatePeer('@deepseek-ai/dsh-tools'), true)
  assert.equal(isGatePeer('@deepseek-ai/dsh'), true)
  assert.equal(isGatePeer('@deepseek-ai/cordis'), false)
  assert.equal(isGatePeer('dsh-tools'), false)
})

test('a non-string peer range is reported as unreadable rather than throwing', () => {
  const ranges = rangesFromManifest({ name: 'p', peerDependencies: { '@deepseek-ai/dsh-tools': { nested: true } } }, undefined)
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].declared, '')
  const result = audit({ ranges, versions: LADDER, runtimeVersion: RUNTIME }).ranges[0]
  assert.equal(result.kind, 'empty')
})

test('anything that is not a manifest contributes nothing', () => {
  for (const value of [undefined, null, 42, 'package.json', [], { name: 'p' }, { peerDependencies: [] }]) {
    assert.deepEqual(rangesFromManifest(value, undefined), [], `for ${JSON.stringify(value)}`)
  }
})

test('the rendered report discloses the coverage and the ladder', () => {
  const result = audit({ ranges: [{ owner: 'probe', declared: MEASURED[2].range }], versions: LADDER, runtimeVersion: RUNTIME })
  const text = render(result, { runtimeSource: 'a fixture', disclosure: ['ladder (31) from the versions argument'] })
  assert.ok(text.includes('31 version(s) tested'), 'the tested count is stated')
  assert.ok(text.includes('ladder (31) from the versions argument'), 'the disclosure lines are printed verbatim')
  assert.ok(text.includes('(read from a fixture)'), 'the runtime source is named')
  assert.ok(text.includes('never proposes') || text.includes('does not propose'), 'the no-synthesis boundary is stated')
  assert.ok(text.includes('rests on the gate\'s prerelease reading alone'), 'the fragile runtime is called out')
})

test('a long admitted set is summarized rather than printed whole', () => {
  const result = audit({ ranges: [{ owner: 'probe', declared: '*' }], versions: LADDER, runtimeVersion: RUNTIME })
  assert.ok(result.ranges[0].gateAdmits.length > LIST_LIMIT, 'the fixture must exceed the display limit for this to test anything')
  const text = render(result, { runtimeSource: 'a fixture', disclosure: [] })
  assert.ok(text.includes(`(+${result.ranges[0].gateAdmits.length - LIST_LIMIT} more)`), 'the omitted count is printed')
})

test('an empty report says how to give it something to audit', () => {
  const text = render(audit({ ranges: [], versions: LADDER, runtimeVersion: RUNTIME }), { runtimeSource: undefined, disclosure: [] })
  assert.ok(text.includes('No dsh peer range was found'), 'an empty call explains itself')
  assert.ok(text.includes('requirements') && text.includes('manifests'), 'the two explicit ways in are named')
})

test('a manifest with dsh peers is audited through the same path as a bare range', () => {
  const fromManifest = audit({ ranges: rangesFromManifest(manifest(MEASURED[2].range), undefined), versions: LADDER, runtimeVersion: RUNTIME })
  const fromRange = audit({ ranges: [{ owner: 'x', declared: MEASURED[2].range }], versions: LADDER, runtimeVersion: RUNTIME })
  assert.deepEqual(fromManifest.ranges[0].gateAdmits, fromRange.ranges[0].gateAdmits)
  assert.deepEqual(fromManifest.ranges[0].verdict, fromRange.ranges[0].verdict)
})
