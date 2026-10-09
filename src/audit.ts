/**
 * The audit itself: what each reading admits, and where they disagree.
 *
 * The unit of the report is one *declared* dsh peer range, because that is the
 * unit the gate judges and the unit an author writes. For each one the audit
 * computes four sets over the version ladder it was given:
 *
 * - `gateAdmits` — admitted by the profile gate (prereleases participate),
 * - `plainAdmits` — admitted by plain semver (npm's resolver),
 * - `gateOnly` — the divergence, and in this family every member of it is a
 *   prerelease,
 * - `plainOnly` — admitted by plain semver and refused by the gate. Nothing
 *   produces this today: the gate's reading is a strict superset. It is computed
 *   and reported rather than assumed, so a range that did produce it would be
 *   visible instead of silently averaged away.
 *
 * Two rules the report keeps, both of them deliberate:
 *
 * 1. **It never proposes a range.** The honest output of a set comparison is the
 *    two sets; a synthesized replacement can be wider than the original and
 *    still look like a fix, and an audit that quietly widens a compatibility
 *    claim is worse than no audit.
 * 2. **It reports coverage.** The ladder is whatever the caller supplied, so an
 *    empty `plainAdmits` means "nothing *in this ladder* is admitted", never
 *    "nothing anywhere is". The counts are printed beside the sets for that
 *    reason.
 *
 * @module @argszero/dsh-peer-range-audit/audit
 */

import { admits, isGatePeer, isValidRange, isValidVersion, WORKSPACE_ALIASES } from './gate.ts'

/** One declared peer requirement, and which package wrote it. */
export interface DeclaredRange {
  /** The package that declares it, when the range came from a manifest. */
  owner: string | undefined
  /** The requirement exactly as declared. */
  declared: string
}

/** What kind of thing was declared. */
export type RangeKind = 'range' | 'workspace-alias' | 'empty' | 'invalid'

/** The one-line judgement for a declared range. */
export type Verdict =
  /** Both readings admit exactly the same versions. */
  | 'identical'
  /** They differ, and every version in the difference is a prerelease. */
  | 'gate-only'
  /** Plain semver admits something the gate refuses: expected never, reported if seen. */
  | 'contradiction'
  /** A `workspace:` alias: the gate resolves it to the running version; semver cannot read it. */
  | 'workspace-alias'
  /** The declaration is blank. */
  | 'empty'
  /** Semver cannot read the declaration. */
  | 'invalid'

/** The audit of one declared range. */
export interface RangeAudit {
  owner: string | undefined
  declared: string
  /** The requirement the gate actually tests (a `workspace:` alias resolved to the running version). */
  requirement: string
  kind: RangeKind
  gateAdmits: readonly string[]
  plainAdmits: readonly string[]
  gateOnly: readonly string[]
  plainOnly: readonly string[]
  /** Whether the two admitted sets are the same set. */
  identical: boolean
  verdict: Verdict
  /** Whether each reading admits the running runtime version, when one is known. */
  admitsRuntime: { gate: boolean, plain: boolean } | undefined
  /** Whether the range's admission of the running version rests on the gate's reading alone. */
  runtimeOnlyUnderGate: boolean
}

/** The whole audit. */
export interface Audit {
  runtimeVersion: string | undefined
  versions: readonly string[]
  /** Versions in the ladder semver cannot parse; they admit nothing and are named. */
  invalidVersions: readonly string[]
  ranges: readonly RangeAudit[]
}

/** How many versions of a set the rendered report lists before summarizing. */
export const LIST_LIMIT = 12

/** The options the audit runs with. */
export interface AuditOptions {
  ranges: readonly DeclaredRange[]
  versions: readonly string[]
  runtimeVersion: string | undefined
}

/**
 * Audit one declared range over one version ladder.
 * @param entry - the declared range and its owner.
 * @param versions - the versions to test, in report order.
 * @param runtimeVersion - the running version, used for `workspace:` aliases.
 * @returns the per-range audit.
 */
function auditRange(entry: DeclaredRange, versions: readonly string[], runtimeVersion: string | undefined): RangeAudit {
  const declared = entry.declared
  const alias = WORKSPACE_ALIASES.includes(declared)
  // The gate resolves an alias to the running version; a plain reader sees the
  // alias itself, which semver cannot parse.
  const requirement = alias ? (runtimeVersion ?? '') : declared
  const parsable = isValidRange(requirement)
  const kind: RangeKind = alias ? 'workspace-alias'
    : declared.trim() === '' ? 'empty'
      : parsable ? 'range' : 'invalid'

  const gateAdmits = kind === 'empty' || kind === 'invalid' || (alias && requirement === '')
    ? []
    : versions.filter(version => admits(version, requirement, 'gate'))
  // A blank requirement admits nothing under both readings, so the empty case
  // short-circuits rather than being reported as a divergence of `[]` vs `[]`.
  const plainAdmits = kind === 'empty' || kind === 'invalid'
    ? []
    : alias ? [] : versions.filter(version => admits(version, declared, 'plain'))

  const gateSet = new Set(gateAdmits)
  const plainSet = new Set(plainAdmits)
  const gateOnly = gateAdmits.filter(version => !plainSet.has(version))
  const plainOnly = plainAdmits.filter(version => !gateSet.has(version))
  const identical = gateOnly.length === 0 && plainOnly.length === 0

  const verdict: Verdict = kind === 'empty' ? 'empty'
    : kind === 'invalid' ? 'invalid'
      : kind === 'workspace-alias' ? 'workspace-alias'
        : plainOnly.length > 0 ? 'contradiction'
          : gateOnly.length > 0 ? 'gate-only' : 'identical'

  const runtimeAdmits = runtimeVersion === undefined ? undefined : {
    gate: admits(runtimeVersion, requirement, 'gate'),
    plain: admits(runtimeVersion, declared, 'plain'),
  }
  const runtimeOnlyUnderGate = runtimeAdmits !== undefined
    && runtimeAdmits.gate && !runtimeAdmits.plain

  return {
    owner: entry.owner,
    declared,
    requirement,
    kind,
    gateAdmits,
    plainAdmits,
    gateOnly,
    plainOnly,
    identical,
    verdict,
    admitsRuntime: runtimeAdmits,
    runtimeOnlyUnderGate,
  }
}

/**
 * Audit every declared range over the ladder.
 *
 * The ladder is deduplicated in the caller's order and invalid versions are kept
 * in the report rather than dropped: a version semver cannot parse admits
 * nothing under either reading, and a set that omitted it would look like a
 * disagreement that is really a typo.
 * @param options - the ranges, the ladder and the running version.
 * @returns the audit.
 */
export function audit(options: AuditOptions): Audit {
  const versions: string[] = []
  const invalidVersions: string[] = []
  for (const version of options.versions) {
    if (versions.includes(version)) continue
    if (isValidVersion(version)) versions.push(version)
    else if (!invalidVersions.includes(version)) invalidVersions.push(version)
  }
  return {
    runtimeVersion: options.runtimeVersion,
    versions,
    invalidVersions,
    ranges: options.ranges.map(entry => auditRange(entry, versions, options.runtimeVersion)),
  }
}

/**
 * The dsh peer ranges one parsed `package.json` declares.
 *
 * Read through the gate's own name filter rather than a looser one, so the
 * report cannot describe a peer the gate never looks at.
 * @param manifest - a parsed manifest, or anything else the caller supplied.
 * @param owner - the package name to attribute the ranges to.
 * @returns one entry per declared dsh peer range, or an empty list.
 */
export function rangesFromManifest(manifest: unknown, owner: string | undefined): DeclaredRange[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return []
  const peers = (manifest as { peerDependencies?: unknown }).peerDependencies
  if (typeof peers !== 'object' || peers === null || Array.isArray(peers)) return []
  const name = owner ?? (typeof (manifest as { name?: unknown }).name === 'string'
    ? (manifest as { name: string }).name
    : undefined)
  const ranges: DeclaredRange[] = []
  for (const [peer, range] of Object.entries(peers as Record<string, unknown>)) {
    if (!isGatePeer(peer)) continue
    // The gate throws on a non-string range; the audit reports the declaration
    // as unreadable instead of refusing the whole report over it.
    ranges.push({ owner: name === undefined ? peer : `${name} → ${peer}`, declared: typeof range === 'string' ? range : '' })
  }
  return ranges
}

/** List at most {@link LIST_LIMIT} versions, summarizing the rest. */
function list(versions: readonly string[]): string {
  if (versions.length === 0) return '(none)'
  const shown = versions.slice(0, LIST_LIMIT).join(', ')
  return versions.length <= LIST_LIMIT ? shown : `${shown} … (+${String(versions.length - LIST_LIMIT)} more)`
}

/** The context lines the report carries but cannot compute. */
export interface ReportContext {
  /** Where the running version was read from, when one was. */
  runtimeSource: string | undefined
  /** Coverage lines: what was scanned, what was skipped and why. */
  disclosure: readonly string[]
}

/**
 * Render the audit as the text a model reads.
 *
 * The two readings are named and their rule is stated once at the top, because
 * the whole value of the report is that the reader can see *why* the sets
 * differ — a bare `false` beside a range teaches nothing.
 * @param result - the audit.
 * @param context - the runtime source and the coverage disclosure.
 * @returns the report text.
 */
export function render(result: Audit, context: ReportContext): string {
  const lines: string[] = []
  const divergent = result.ranges.filter(range => !range.identical).length
  lines.push(`peer-range-audit: ${String(result.ranges.length)} declared dsh peer range(s), `
    + `${String(result.versions.length)} version(s) tested, `
    + `running version ${result.runtimeVersion ?? 'unknown'}`
    + `${context.runtimeSource === undefined ? '' : ` (read from ${context.runtimeSource})`}`)
  lines.push('')
  lines.push('  gate  = the profile compatibility gate (packages/boot/app-boot/src/plugin-compatibility.ts): semver with includePrerelease, so prereleases participate.')
  lines.push('  plain = default semver, which is what npm\'s own resolver does: a prerelease is admitted only by a comparator naming a prerelease for the same major.minor.patch.')
  if (result.ranges.length === 0) {
    lines.push('')
    lines.push('No dsh peer range was found to audit. Pass `requirements` (bare ranges) or `manifests` (package.json objects), '
      + 'or call it with neither inside a profile to audit the plugins that profile mounts.')
  }
  for (const [index, range] of result.ranges.entries()) {
    lines.push('')
    lines.push(`[${String(index + 1)}] ${range.owner ?? 'declared'} — ${range.kind}`)
    lines.push(`    declared    : ${range.declared === '' ? '(blank)' : range.declared}`)
    if (range.kind === 'workspace-alias') {
      lines.push(`    requirement : ${range.requirement === '' ? '(running version unknown, so the alias resolves to nothing)' : `= ${range.requirement} (the running version)`}`)
    }
    lines.push(`    gate admits : ${list(range.gateAdmits)} (${String(range.gateAdmits.length)}/${String(result.versions.length)})`)
    lines.push(`    plain admits: ${list(range.plainAdmits)} (${String(range.plainAdmits.length)}/${String(result.versions.length)})`)
    lines.push(`    gate only   : ${list(range.gateOnly)}${range.gateOnly.length === 0 ? '' : '  <- prereleases: the gate reads them, plain semver does not'}`)
    lines.push(`    plain only  : ${list(range.plainOnly)}${range.plainOnly.length === 0 ? '' : '  <- unexpected: the gate admits everything plain semver admits'}`)
    lines.push(`    verdict     : ${verdictText(range)}`)
    if (result.runtimeVersion !== undefined) {
      const line = runtimeLine(range, result.runtimeVersion)
      if (line !== undefined) lines.push(`    runtime     : ${line}`)
    }
  }
  lines.push('')
  if (result.invalidVersions.length > 0) {
    lines.push(`Versions not parsable as semver (they admit nothing under either reading, and are not a divergence): ${result.invalidVersions.join(', ')}`)
  }
  lines.push(`Summary: ${String(result.ranges.length - divergent)} range(s) read identically, ${String(divergent)} diverge between the two readings.`)
  lines.push('')
  lines.push('Notes:')
  lines.push(' - The gate reads prereleases; plain semver does not. That is the whole divergence in this family, and it is one-way: '
    + 'no version is admitted by plain semver and refused by the gate. A non-empty "plain only" is reported rather than hidden.')
  lines.push(' - This tool reports the two admitted sets. It does not propose a replacement range: a synthesized range can be wider than the one '
    + 'it replaces and still look like a fix, and widening a compatibility claim silently is worse than showing the disagreement.')
  lines.push(' - The ladder is what was supplied, so "nothing is admitted" always means "nothing in this ladder". Read the counts, not the empty sets.')
  lines.push(' - Inside a profile, the reader that decides is the gate (and pnpm, which agrees with it); the plain column describes npm\'s resolver, '
    + 'a dev checkout, or an out-of-profile install.')
  for (const line of context.disclosure) lines.push(` - ${line}`)
  return lines.join('\n')
}

/** The one-line judgement for a range, in the terms the report has just defined. */
function verdictText(range: RangeAudit): string {
  switch (range.verdict) {
    case 'identical':
      return 'identical — both readings admit the same versions here'
    case 'gate-only':
      return 'gate-only — the readings differ, and only over prereleases; a plain consumer (npm, a dev checkout) refuses what the gate admits'
    case 'contradiction':
      return 'contradiction — plain semver admits versions the gate refuses; the gate was believed to be a strict superset, so this is worth reporting'
    case 'workspace-alias':
      return `workspace alias — the gate reads it as ${range.requirement === '' ? 'nothing (the running version is unknown)' : `the exact running version (${range.requirement})`}; `
        + 'semver cannot parse it at all, so a plain reader refuses everything (pnpm rewrites it at pack time, so a published tarball must not still carry it)'
    case 'empty':
      return 'empty — a blank requirement admits nothing; the gate reports the peer as incompatible'
    case 'invalid':
      return 'invalid — semver cannot read this range, so the gate reports the peer as incompatible and admits nothing'
  }
}

/**
 * The line that says whether the running version itself is admitted, in the
 * terms that matter for the plugin actually mounted here.
 * @param range - a per-range audit with a known running version.
 * @returns the line, or `undefined` when no running version is known.
 */
export function runtimeLine(range: RangeAudit, runtimeVersion: string): string | undefined {
  if (range.admitsRuntime === undefined) return undefined
  const { gate, plain } = range.admitsRuntime
  const head = `runtime ${runtimeVersion}: gate ${gate ? 'admits' : 'REFUSES'}, plain ${plain ? 'admits' : 'refuses'}`
  if (range.runtimeOnlyUnderGate) {
    return `${head} — admission of the running version rests on the gate's prerelease reading alone`
  }
  if (!gate) {
    return `${head} — a plugin declaring this range would not be admitted at the running version; an exact-version exemption is the only thing that lets such a row mount`
  }
  return `${head} — both readings agree on the running version`
}
