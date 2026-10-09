/**
 * The plugin as it is actually called: through the real tool registry, with the
 * real argument path, and with the profile services either present or absent.
 *
 * Three things are being pinned here that the pure suites cannot reach:
 *
 * 1. **The tool is registered under the name the description promises**, and one
 *    call reaches it. A definition that never gets registered is a plugin that
 *    does nothing however green its unit tests are.
 * 2. **The no-argument call works**, which is the one an agent inside a profile
 *    will make. It has to find the running version, report the profile scan as
 *    unavailable when the services are absent rather than crashing, and still
 *    produce a report.
 * 3. **The profile scan discloses its coverage.** The fabricated resolver answers
 *    for some names and not others on purpose, and the assertions are on the
 *    counts: rows seen, specifiers kept, packages resolved, ranges audited. A
 *    scan that silently audited two of six plugins would look exactly like one
 *    that audited all six, and that difference is what these arms exist to catch.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import * as plugin from '../lib/index.js'
import { resolveRequest } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'
import { call, logText, resultText, world } from './harness.mjs'
import { LADDER, MEASURED, RUNTIME } from './fixtures.mjs'

/**
 * A resolver answer shaped like `PluginPackage`, with the manifest the audit reads.
 * @param name - the package name.
 * @param peerDependencies - the manifest's peers.
 * @param version - the manifest version; the runtime probe reads its own package's here.
 */
function resolved(name, peerDependencies, version = '1.0.0') {
  const manifest = { name, version, peerDependencies }
  return { name, version, dir: `/nowhere/${name}`, manifestPath: `/nowhere/${name}/package.json`, manifest }
}

/** Loader rows for a set of specifiers, including one that is not a package at all. */
function rowsOf(specifiers) {
  return [
    ...specifiers.map(name => ({ options: { name } })),
    { options: { name: './local-file.js' } },
    { options: { name: 'cordis:include' } },
  ]
}

test('the plugin exports the identity the loader and the registry expect', () => {
  assert.equal(plugin.name, 'peer-range-audit')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(plugin.default.name, 'peer-range-audit')
  assert.equal(typeof plugin.apply, 'function')
})

test('the tool is registered and answers through the real registry', async () => {
  const harness = await world()
  const text = resultText(await call(harness, { requirements: [MEASURED[2].range], versions: [RUNTIME] }))
  assert.ok(text.startsWith('peer-range-audit:'), `the tool answered: ${text.slice(0, 80)}`)
  assert.ok(text.includes('1 declared dsh peer range(s)'), 'the report is the audit report')
  assert.ok(text.includes('1 version(s) tested'), 'the supplied ladder is what was tested')
  assert.equal(logText(harness.logged), '', 'a successful audit logs nothing')
})

test('manifests passed as arguments are audited the same way as bare ranges', async () => {
  const harness = await world()
  const text = resultText(await call(harness, {
    manifests: [{ name: 'some-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': MEASURED[2].range, react: '^18.0.0' } }],
    versions: [...LADDER],
  }))
  assert.ok(text.includes('some-plugin → @deepseek-ai/dsh-tools'), 'the owner is attributed')
  assert.ok(!text.includes('react'), 'a non-dsh peer is not audited')
  assert.ok(text.includes(`(${String(MEASURED[2].gate)}/31)`), 'the measured gate count is reproduced through the tool')
  assert.ok(text.includes(`(${String(MEASURED[2].plain)}/31)`), 'the measured plain count is reproduced through the tool')
})

test('a call with no arguments reports the missing profile services and still audits', async () => {
  const harness = await world()
  const text = resultText(await call(harness, {}))
  assert.ok(text.includes('profile scan unavailable'), 'the absent services are named rather than assumed')
  assert.ok(text.includes('`manifests`') && text.includes('`requirements`'), 'the reader is told what to pass instead')
  assert.ok(text.includes('ladder (1) from the running version'), 'the running version is the fallback ladder')
})

test('the running version is read from the real installed dsh-tools package', async () => {
  const harness = await world()
  const text = resultText(await call(harness, {}))
  // The substitution the tool rests on, observed end to end: this is the version
  // the suite's own tree ships, read through the documented probe.
  assert.ok(text.includes(`running version ${getDshRuntimeVersion()}`), `expected the installed version in: ${text.split('\n')[0]}`)
  assert.ok(text.includes('@deepseek-ai/dsh-tools'), 'the source of the version is named')
})

test('the runtimeVersion argument overrides what the profile resolution would say', async () => {
  const harness = await world()
  const text = resultText(await call(harness, { runtimeVersion: '0.1.7-rc.2', versions: ['0.1.7-rc.2', RUNTIME] }))
  assert.ok(text.includes('running version 0.1.7-rc.2'), 'the caller\'s version is used')
  assert.ok(text.includes('(read from the runtimeVersion argument)'), 'and its source is named honestly')
})

test('the profile scan audits the mounted plugins and discloses its coverage', async () => {
  const thirdParty = 'third-party-plugin'
  const fragile = 'fragile-plugin'
  const harness = await world({
    rows: rowsOf(['@deepseek-ai/dsh-tools', thirdParty, fragile, 'ghost-package']),
    packages: {
      // The runtime probe reads this one, so it carries the version the profile
      // would really be running — the fixture's, not a placeholder.
      '@deepseek-ai/dsh-tools': resolved('@deepseek-ai/dsh-tools', { '@deepseek-ai/cordis': '^4.0.2' }, RUNTIME),
      // `^0.2.0`: gate-only, and it does not admit the running version at all.
      [thirdParty]: resolved(thirdParty, { '@deepseek-ai/dsh-tools': MEASURED[0].range }),
      // The fragile shape: admitted here only because the gate reads prereleases.
      [fragile]: resolved(fragile, { '@deepseek-ai/dsh-tools': MEASURED[2].range }),
    },
  })
  const text = resultText(await call(harness, { versions: [...LADDER] }))

  const asked = harness.queried.map(entry => entry.specifier)
  // One lookup per row, plus one for the running version — the same name can be
  // both a row and the runtime probe, and both questions are asked.
  assert.deepEqual(
    [...new Set(asked)].sort(),
    ['@deepseek-ai/dsh-tools', 'ghost-package', fragile, thirdParty].sort(),
    'every package specifier was asked about, and nothing else was',
  )
  assert.equal(asked.filter(name => name === '@deepseek-ai/dsh-tools').length, 2,
    'the runtime probe asks about dsh-tools once in addition to its Loader row')
  assert.ok(harness.queried.every(entry => typeof entry.parentURL === 'string'), 'a resolution base was supplied for each lookup')

  assert.ok(text.includes('profile scan: 6 Loader row(s), 4 distinct package specifier(s), 3 resolved to a package, 2 dsh peer range(s) audited'),
    `the coverage line is exact: ${text.split('\n').find(line => line.includes('profile scan'))}`)
  assert.ok(text.includes('resolved but declaring no dsh peer'), 'a package with no dsh peers is disclosed, not silently skipped')
  assert.ok(text.includes('not resolved to a package'), 'an unresolvable name is disclosed')
  assert.ok(text.includes(thirdParty) && text.includes(fragile), 'both declaring plugins appear')
  assert.ok(text.includes('rests on the gate\'s prerelease reading alone'), 'the fragile range is called out')
  assert.ok(text.includes('2 range(s) read identically') || text.includes('diverge between the two readings'), 'the summary is present')
})

test('the run is read-only: nothing is logged as a refusal, a change or an error', async () => {
  const harness = await world({
    rows: rowsOf(['fragile-plugin']),
    packages: { 'fragile-plugin': resolved('fragile-plugin', { '@deepseek-ai/dsh-tools': MEASURED[2].range }) },
  })
  await call(harness, { versions: [RUNTIME] })
  assert.equal(logText(harness.logged), '', 'the plugin never logs, refuses or mutates during an audit')
})

test('tool: false mounts the plugin without registering anything', async () => {
  const harness = await world({ config: { tool: false } })
  assert.equal(harness.ctx.tools.get('peer_range_audit'), undefined, 'the tool is not in the registry when it is switched off')
})

test('a configured ladder is used when the call names none', async () => {
  const harness = await world({ config: { versions: ['0.1.7-rc.2', RUNTIME] } })
  const text = resultText(await call(harness, { requirements: [MEASURED[2].range] }))
  assert.ok(text.includes('ladder (2) from the versions setting'), 'the setting supplies the ladder')
  // Over this two-version ladder the range admits both, where over the full
  // published ladder it admits the six the fixture records.
  assert.ok(text.includes('(2/2)'), 'the configured ladder is the one tested')
})

test('the two bounds truncate loudly', async () => {
  const harness = await world({ config: { maxVersions: 2, maxRequirements: 1 } })
  const text = resultText(await call(harness, {
    requirements: [MEASURED[2].range, MEASURED[0].range],
    versions: ['0.1.7-rc.2', RUNTIME, '0.1.6-alpha.2'],
  }))
  assert.ok(text.includes('ladder truncated to 2 of 3 requested version(s)'), 'the dropped versions are counted')
  assert.ok(text.includes('1 declared range(s) not audited (maxRequirements = 1)'), 'the dropped ranges are counted')
})

test('a call that can test nothing says so and how to fix it', async () => {
  // The only way to reach this through the real tool is to have no ladder and no
  // running version, so it is pinned on the pure resolution instead — including
  // the precedence that produces it.
  const settings = normalizeConfig({})
  const nothing = resolveRequest({}, settings, { version: undefined, source: undefined })
  assert.deepEqual(nothing.ladder, [])
  assert.equal(nothing.running, undefined)
  assert.ok(nothing.disclosure.some(line => line.includes('running version unknown')))

  const configured = resolveRequest({}, { ...settings, versions: ['0.1.0'] }, { version: undefined, source: undefined })
  assert.deepEqual(configured.ladder, ['0.1.0'])
  assert.equal(configured.ladderSource, 'the versions setting')

  const fromArgument = resolveRequest({ versions: [RUNTIME] }, { ...settings, versions: ['0.1.0'] }, { version: '0.2.0', source: 'a probe' })
  assert.deepEqual(fromArgument.ladder, [RUNTIME], 'the argument wins over the setting')

  const fromRunning = resolveRequest({}, settings, { version: '0.2.0', source: 'a probe' })
  assert.deepEqual(fromRunning.ladder, ['0.2.0'])
  assert.equal(fromRunning.ladderSource, 'the running version')
})

test('resolveRequest keeps the caller\'s range order and attributes bare ranges', () => {
  const resolvedRequest = resolveRequest(
    { requirements: [MEASURED[0].range, MEASURED[2].range] },
    normalizeConfig({}),
    { version: RUNTIME, source: 'a probe' },
  )
  assert.deepEqual(resolvedRequest.explicit.map(range => range.declared), [MEASURED[0].range, MEASURED[2].range])
  assert.ok(resolvedRequest.explicit.every(range => range.owner === 'declared requirement'))
})

test('the registered description names the two readers and the no-synthesis boundary', async () => {
  // The description is the only thing a model reads before it decides to call,
  // so the two readings have to be named there and not only in the report.
  const harness = await world()
  const definition = harness.ctx.tools.get('peer_range_audit')
  assert.ok(definition !== undefined, 'the tool is in the registry under the documented name')
  assert.ok(definition.description.includes('includePrerelease'), 'the gate reading is named')
  assert.ok(definition.description.includes('never proposes a replacement range'), 'the boundary is named')
})
