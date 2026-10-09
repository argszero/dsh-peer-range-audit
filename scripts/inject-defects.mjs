/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * the harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first; a
 * mutation that is never written to `lib/` is a mutation the suite cannot see. A
 * mutation that does not compile is reported separately as TYPEFAIL, because it
 * never reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped: one
 * distinction it exists to make, removed one line at a time. The arms are not
 * "does the test file import the module" — each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a claim the package makes
 * that nothing checks. The two the package would be *worthless* without are the
 * first arm (the gate's reading losing `includePrerelease`, which collapses the
 * whole comparison to one reader) and the report arm (the report no longer
 * saying that it refuses to synthesize a range).
 *
 * One distinction deliberately has **no** arm here: suppressing the `plain only`
 * set. It is reported by the tool rather than assumed away, but no range in this
 * family can make it non-empty — the gate's reading is a measured strict
 * superset — so the mutant changes no observable output and a SILENT result
 * would say nothing about the suite. The law itself is asserted directly, over
 * every measured range, in `test/audit.spec.mjs`.
 *
 * ```sh
 * node scripts/inject-defects.mjs                  # every arm
 * node scripts/inject-defects.mjs --filter=policy  # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The whole reason the plugin exists: without `includePrerelease` the two
    // readings are the same reading, and every report says "identical".
    name: 'gate: the gate reading loses includePrerelease, so both columns agree',
    file: 'src/gate.ts',
    edits: [["reading === 'gate' ? { includePrerelease: true } : {}", '{}']],
  },
  {
    // The gate judges `@deepseek-ai/dsh` / `dsh-*` peers. Widened to the whole
    // scope, the report would describe peers the gate never looks at.
    name: 'gate: every @deepseek-ai/ package is treated as a gate peer',
    file: 'src/gate.ts',
    edits: [["return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')",
      "return name.startsWith('@deepseek-ai/')"]],
  },
  {
    // A range semver cannot read admits nothing; the gate reports the peer as
    // incompatible. Saying every string is a range turns an unparsable
    // declaration into a silently empty audit.
    name: 'gate: an unparsable requirement is reported as a readable range',
    file: 'src/gate.ts',
    edits: [["export function isValidRange(requirement: string): boolean {\n  return semver.validRange(requirement) !== null\n}",
      "export function isValidRange(requirement: string): boolean {\n  return requirement.trim() !== ''\n}"]],
  },
  {
    // A `workspace:` alias is what the gate resolves to the running version.
    // Read as its own text, semver cannot parse it and the row reports nothing.
    name: 'audit: a workspace alias is not resolved to the running version',
    file: 'src/audit.ts',
    edits: [['const requirement = alias ? (runtimeVersion ?? \'\') : declared', 'const requirement = declared']],
  },
  {
    // Dropping an unparsable version makes a typo in the caller's ladder look
    // like a disagreement between the two readings.
    name: 'audit: a version semver cannot parse is dropped instead of listed',
    file: 'src/audit.ts',
    edits: [['else if (!invalidVersions.includes(version)) invalidVersions.push(version)',
      'else if (!invalidVersions.includes(version)) void version']],
  },
  {
    // The ladder is what the caller supplied; deduplicating it is what makes the
    // counts mean "versions", not "entries".
    name: 'audit: the ladder is not deduplicated',
    file: 'src/audit.ts',
    edits: [['    if (versions.includes(version)) continue', '    if (false) continue']],
  },
  {
    // The one line that tells a mounted plugin author whether their row is there
    // only because the gate reads prereleases.
    name: 'audit: the gate-only runtime admission is never flagged',
    file: 'src/audit.ts',
    edits: [['  const runtimeOnlyUnderGate = runtimeAdmits !== undefined\n    && runtimeAdmits.gate && !runtimeAdmits.plain',
      '  const runtimeOnlyUnderGate = false']],
  },
  {
    // The argument exists so a caller can pin the audit to a version it knows,
    // and it is documented as overriding what the profile resolution says.
    name: 'index: the runtimeVersion argument is ignored in favour of the resolved one',
    file: 'src/index.ts',
    edits: [['  const running = supplied ?? discovered.version', '  const running = discovered.version']],
  },
  {
    // `tool: false` is the whole point of mounting a diagnostic without putting
    // it on every agent's tool list.
    name: 'config: tool: false is ignored and the tool is registered anyway',
    file: 'src/config.ts',
    edits: [['    tool: boolean(config.tool, defaultConfig.tool),', '    tool: true,']],
  },
  {
    // The README makes this promise; the report is where a reader meets it.
    name: 'render: the report stops stating the no-synthesis boundary',
    file: 'src/audit.ts',
    edits: [["lines.push(' - This tool reports the two admitted sets. It does not propose a replacement range: a synthesized range can be wider than the one '",
      "lines.push(' - This tool reports the two admitted sets. A synthesized range can be wider than the one '"]],
  },
  {
    // The coverage line is the difference between "three plugins were audited"
    // and "three of twenty were audited and it read the same".
    name: 'index: the profile scan stops disclosing the names it could not resolve',
    file: 'src/index.ts',
    edits: [["  if (unresolved.length > 0) disclosure.push(`not resolved to a package (not judged by the gate either, so not audited): ${shortList(unresolved)}`)",
      '  void unresolved']],
  },
  {
    // The configured ladder is the only way a deployment gets a standing answer
    // for calls that name none, instead of the running version alone.
    name: 'index: the configured ladder is never used',
    file: 'src/index.ts',
    edits: [['  if (ladder.length === 0 && settings.versions.length > 0) {', '  if (false && settings.versions.length > 0) {']],
  },
  {
    // Both bounds exist because the report is text a model reads. Silent
    // truncation is the failure mode: the tool must say how many it dropped.
    name: 'index: the version bound is applied without saying so',
    file: 'src/index.ts',
    edits: [["    disclosure.push(`ladder truncated to ${String(settings.maxVersions)} of ${String(ladder.length)} requested version(s)`)",
      '    void settings.maxVersions']],
  },
  {
    name: 'index: the requirement bound is applied without saying so',
    file: 'src/index.ts',
    edits: [["    disclosure.push(`${String(declared.length - explicit.length)} declared range(s) not audited (maxRequirements = ${String(settings.maxRequirements)})`)",
      '    void settings.maxRequirements']],
  },
  {
    // The tool description is the only thing a model reads before deciding to
    // call: the boundary has to be there, not only in the report.
    name: 'index: the tool description stops naming the no-synthesis boundary',
    file: 'src/index.ts',
    edits: [["It reports the two admitted sets and never proposes a replacement range.",
      'It reports the two admitted sets.']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a reader can leave the
 * suite spinning over a ladder this package will never bound, and a mutant that
 * never terminates is a mutant the suite cannot report on. It is killed here
 * and counted as caught, which is what it is — the suite never reaches its
 * assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
