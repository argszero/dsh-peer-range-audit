/**
 * A declared dsh peer range is read by more than one reader, and they disagree.
 *
 * `@deepseek-ai/dsh-app-boot` judges every plugin's `@deepseek-ai/dsh-*` peer
 * before the tree mounts, and it asks semver with `{ includePrerelease: true }` —
 * so inside a profile a prerelease runtime satisfies a range that names a
 * prerelease floor, even when the prerelease's own `major.minor.patch` tuple does
 * not appear in the range. A plain semver reader refuses that same combination,
 * which is what npm's own resolver does.
 *
 * The divergence is one-way and *silent*: a range can be admitted by the gate at
 * the version a plugin actually declares it for, while the next npm install of a
 * checkout, or any other plain-semver consumer, refuses it. Nothing in the
 * project surfaces that, because the gate only ever answers yes/no about the
 * version it is running as.
 *
 * This plugin fills that gap with a read-only tool. It takes declared ranges —
 * either handed to it, or read from the plugins the current profile mounts — and
 * reports, for each one, the versions admitted by each reading, the divergence,
 * and whether the range's admission of the *running* version rests on the gate's
 * reading alone.
 *
 * ## What it deliberately does not do
 *
 * It does not propose a replacement range. The honest output of a set comparison
 * is the two sets; a synthesized range can be wider than the one it replaces and
 * still look like a fix, so an audit that quietly widens a compatibility claim is
 * worse than no audit. It also does not refuse, cancel, or rewrite anything: it
 * is a diagnostic, and a diagnostic that changes behaviour stops being one.
 *
 * ## Where the running version comes from
 *
 * `@deepseek-ai/dsh-tools` is a declared peer of this package and always present
 * where this plugin runs, and the dsh packages are released in lockstep — the 31
 * published versions of `dsh-tools`, `dsh-app-boot` and `dsh-agent` are the same
 * 31 strings — so its version stands in for the runtime's. The lookup goes
 * through the profile's own package resolver (`ctx.pluginPackages.packageOf`)
 * when that service is present, which is the resolution the profile itself uses,
 * and falls back to Node resolution from this module. When neither yields a
 * version, the tool says so and asks for `versions` or `runtimeVersion` rather
 * than guessing.
 *
 * @module @argszero/dsh-peer-range-audit
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { audit, rangesFromManifest, render, type DeclaredRange, type ReportContext } from './audit.ts'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, Settings } from './config.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'peer-range-audit'

/** The one service the tool needs: the registry it is registered on. */
export const inject = ['tools']

export type { Config, Settings } from './config.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export { audit, rangesFromManifest, render, runtimeLine, LIST_LIMIT } from './audit.ts'
export type {
  Audit, AuditOptions, DeclaredRange, RangeAudit, RangeKind, ReportContext, Verdict,
} from './audit.ts'
export { admits, isGatePeer, isPrerelease, isValidRange, isValidVersion, WORKSPACE_ALIASES } from './gate.ts'
export type { Reading } from './gate.ts'

/**
 * The package whose version stands in for the running dsh version.
 *
 * Named once here because three places depend on it agreeing: the profile
 * resolver lookup, the Node fallback, and the test that asserts the lockstep the
 * substitution rests on.
 */
export const RUNTIME_PROBE = '@deepseek-ai/dsh-tools'

/** The version this process is running as, and where it was read from. */
export interface RuntimeVersion {
  version: string | undefined
  source: string | undefined
}

/** The slice of `ctx.pluginPackages` this plugin uses, when that service is present. */
interface PackageLookup {
  packageOf(specifier: string, parentURL: string): unknown
}

/**
 * The profile's package resolver, or `undefined` when no profile mounted one.
 *
 * Read through `ctx.get` rather than declared in `inject` on purpose: this plugin
 * works without it (it falls back to Node resolution and to caller-supplied
 * versions), and an `inject` entry would hold the whole plugin pending in any
 * composition that has no profile resolver.
 * @param ctx - the plugin context.
 * @returns the lookup, or `undefined`.
 */
function packageLookup(ctx: Context): PackageLookup | undefined {
  const service = ctx.get('pluginPackages') as { packageOf?: unknown } | undefined
  if (service === undefined || typeof service.packageOf !== 'function') return undefined
  return service as unknown as PackageLookup
}

/** The `version` field of a parsed manifest, when it is a non-empty string. */
function versionOf(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const version = (manifest as { version?: unknown }).version
  return typeof version === 'string' && version.trim() !== '' ? version : undefined
}

/**
 * Read the running dsh version.
 *
 * Both paths are deliberately non-fatal: a diagnostic that cannot find the
 * version must say so and keep working, not refuse to load.
 * @param ctx - the plugin context.
 * @returns the version and the source it came from, either of which may be absent.
 */
export function runtimeVersion(ctx: Context): RuntimeVersion {
  const lookup = packageLookup(ctx)
  if (lookup !== undefined) {
    try {
      const found = lookup.packageOf(RUNTIME_PROBE, import.meta.url) as { manifest?: unknown, version?: unknown } | undefined
      const version = versionOf(found?.manifest) ?? (typeof found?.version === 'string' ? found.version : undefined)
      if (version !== undefined) return { version, source: `${RUNTIME_PROBE} as resolved by this profile` }
    } catch {
      // Fall through: the profile resolver refusing this name is a fact about the
      // profile, not a reason to give up on the version.
    }
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`${RUNTIME_PROBE}/package.json`), 'utf8'))
    const version = versionOf(manifest)
    if (version !== undefined) return { version, source: `${RUNTIME_PROBE}/package.json as resolved from this module` }
  } catch {
    // Neither path found it; the caller is told, and can pass `runtimeVersion`.
  }
  return { version: undefined, source: undefined }
}

/**
 * Whether a Loader row's name is a bare package specifier.
 *
 * Loader rows name plugins by package name, by relative path, by file URL, or by
 * a `cordis:` builtin; only the first kind has a manifest to audit.
 * @param specifier - the row's `options.name`.
 * @returns true when the name should be resolved as a package.
 */
export function isPackageSpecifier(specifier: string): boolean {
  if (specifier.trim() === '') return false
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('cordis:')) return false
  return !specifier.includes('://')
}

/** The result of reading the mounted plugins' ranges. */
export interface ProfileScan {
  ranges: DeclaredRange[]
  disclosure: string[]
}

/** List values for a disclosure line, bounded so one line cannot grow without limit. */
function shortList(values: readonly string[]): string {
  const shown = values.slice(0, 8)
  return values.length <= shown.length ? shown.join(', ') : `${shown.join(', ')} … (+${String(values.length - shown.length)} more)`
}

/**
 * Read the dsh peer ranges of the plugins this profile mounts.
 *
 * Coverage is the point of the returned disclosure: which rows were seen, which
 * names resolved to a package, and which were skipped. A profile scan that
 * silently audited three of twenty plugins would read exactly like one that
 * audited all twenty.
 * @param ctx - the plugin context.
 * @returns the ranges found, and the coverage lines to print beside them.
 */
export function profileScan(ctx: Context): ProfileScan {
  const loader = ctx.get('loader') as { entries?: unknown } | undefined
  const lookup = packageLookup(ctx)
  if (loader === undefined || typeof loader.entries !== 'function') {
    return { ranges: [], disclosure: ['profile scan unavailable: no Loader service in this composition — pass `manifests` or `requirements` instead'] }
  }
  if (lookup === undefined) {
    return { ranges: [], disclosure: ['profile scan unavailable: no `pluginPackages` service in this composition — pass `manifests` or `requirements` instead'] }
  }
  const rows = [...(loader.entries as () => Iterable<unknown>)()]
  const specifiers: string[] = []
  for (const row of rows) {
    const specifier = (row as { options?: { name?: unknown } } | null)?.options?.name
    if (typeof specifier !== 'string' || !isPackageSpecifier(specifier) || specifiers.includes(specifier)) continue
    specifiers.push(specifier)
  }
  const ranges: DeclaredRange[] = []
  const unresolved: string[] = []
  const withoutPeers: string[] = []
  let resolved = 0
  for (const specifier of specifiers) {
    let found: unknown
    try {
      found = lookup.packageOf(specifier, import.meta.url)
    } catch {
      found = undefined
    }
    if (found === undefined || found === null || typeof found !== 'object') {
      unresolved.push(specifier)
      continue
    }
    resolved += 1
    const pkg = found as { name?: unknown, manifest?: unknown }
    const owner = typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : specifier
    const declared = rangesFromManifest(pkg.manifest, owner)
    if (declared.length === 0) withoutPeers.push(owner)
    ranges.push(...declared)
  }
  const disclosure = [`profile scan: ${String(rows.length)} Loader row(s), ${String(specifiers.length)} distinct package specifier(s), `
    + `${String(resolved)} resolved to a package, ${String(ranges.length)} dsh peer range(s) audited`]
  if (withoutPeers.length > 0) disclosure.push(`resolved but declaring no dsh peer (nothing to audit): ${shortList(withoutPeers)}`)
  if (unresolved.length > 0) disclosure.push(`not resolved to a package (not judged by the gate either, so not audited): ${shortList(unresolved)}`)
  return { ranges, disclosure }
}

/** Read an argument as a list of non-empty strings, dropping anything else. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

/** The text returned when the tool cannot test anything, with the reason. */
export function cannotTest(reason: string): string {
  return `peer_range_audit: cannot test anything — ${reason}\n\n`
    + 'Supply a version ladder with `versions` (for example from `npm view @deepseek-ai/dsh-agent versions --json`), '
    + 'or a single `runtimeVersion`. The ladder is the set of versions the two readings are compared over; '
    + 'the running one is used automatically when it can be read.'
}

/** The tool arguments, as the registry hands them over. */
export interface AuditRequest {
  requirements?: unknown
  manifests?: unknown
  versions?: unknown
  runtimeVersion?: unknown
}

/** Everything about one call that is decided before anything is read from the profile. */
export interface ResolvedRequest {
  /** The ranges the caller named, already bounded. */
  explicit: DeclaredRange[]
  /** The running version and where it came from. */
  running: string | undefined
  runningSource: string | undefined
  /** The ladder to test, already bounded; empty when nothing could be supplied. */
  ladder: string[]
  /** What the ladder is, for the report's disclosure. */
  ladderSource: string
  /** Coverage lines produced while resolving: truncation, and an unknown running version. */
  disclosure: string[]
}

/**
 * Resolve a call's arguments against the configuration and the discovered
 * running version.
 *
 * Split out of the tool body so the precedence rules are testable without a
 * registry, a Loader, or a profile: which ladder wins (argument, then setting,
 * then the running version), what happens when nothing supplies one, and how the
 * two bounds report what they dropped.
 * @param args - the tool arguments.
 * @param settings - the resolved configuration.
 * @param discovered - the running version and its source.
 * @returns the resolved request.
 */
export function resolveRequest(args: AuditRequest, settings: Settings, discovered: RuntimeVersion): ResolvedRequest {
  const declared: DeclaredRange[] = []
  for (const requirement of stringList(args.requirements)) declared.push({ owner: 'declared requirement', declared: requirement })
  for (const manifest of Array.isArray(args.manifests) ? args.manifests : []) declared.push(...rangesFromManifest(manifest, undefined))

  const explicit = declared.length > settings.maxRequirements ? declared.slice(0, settings.maxRequirements) : declared
  const disclosure: string[] = []

  const supplied = typeof args.runtimeVersion === 'string' && args.runtimeVersion.trim() !== '' ? args.runtimeVersion.trim() : undefined
  const running = supplied ?? discovered.version
  const runningSource = supplied === undefined ? discovered.source : 'the runtimeVersion argument'

  let ladder = stringList(args.versions)
  let ladderSource = 'the versions argument'
  if (ladder.length === 0 && settings.versions.length > 0) {
    ladder = [...settings.versions]
    ladderSource = 'the versions setting'
  }
  if (ladder.length === 0 && running !== undefined) {
    ladder = [running]
    ladderSource = 'the running version'
  }
  if (ladder.length > settings.maxVersions) {
    disclosure.push(`ladder truncated to ${String(settings.maxVersions)} of ${String(ladder.length)} requested version(s)`)
    ladder = ladder.slice(0, settings.maxVersions)
  }
  if (declared.length > explicit.length) {
    disclosure.push(`${String(declared.length - explicit.length)} declared range(s) not audited (maxRequirements = ${String(settings.maxRequirements)})`)
  }
  if (ladder.length > 0) disclosure.push(`ladder (${String(ladder.length)}) from ${ladderSource}`)
  if (running === undefined) disclosure.push('running version unknown: `workspace:` aliases resolve to nothing and the runtime line is omitted')

  return { explicit, running, runningSource, ladder, ladderSource, disclosure }
}

/**
 * The read-only audit tool.
 * @param ctx - the plugin context, for the running version and the profile scan.
 * @param settings - the resolved configuration.
 * @returns the tool definition.
 */
function auditTool(ctx: Context, settings: Settings) {
  return defineTool({
    name: 'peer_range_audit',
    description: 'Report which dsh runtime versions a declared @deepseek-ai/dsh-* peer range admits, under the two readers that decide it: '
      + 'the profile compatibility gate (semver with includePrerelease, so prereleases participate) and plain semver (what npm\'s own resolver does). '
      + 'Use it when writing or reviewing a plugin\'s peerDependencies, or to see which plugins mounted in this profile are admitted only because '
      + 'the gate reads prereleases. Called with no arguments inside a profile it audits the mounted plugins; pass `manifests` (package.json objects) '
      + 'or `requirements` (bare ranges) for anything else, and `versions` (e.g. from `npm view @deepseek-ai/dsh-agent versions --json`) to test a '
      + 'ladder instead of the running version alone. It reports the two admitted sets and never proposes a replacement range.',
    parameters: {
      requirements: {
        type: 'array',
        items: { type: 'string' },
        description: 'Declared dsh peer ranges to audit, exactly as written (e.g. ">=0.1.7-alpha.1 <0.2.0", "^0.2.0", "workspace:^").',
      },
      manifests: {
        type: 'array',
        items: { type: 'json' },
        description: 'Parsed package.json objects; every @deepseek-ai/dsh / @deepseek-ai/dsh-* entry of each peerDependencies is audited. '
          + 'Anything without dsh peers contributes nothing.',
      },
      versions: {
        type: 'array',
        items: { type: 'string' },
        description: 'The dsh runtime versions to test, e.g. from `npm view @deepseek-ai/dsh-agent versions --json`. '
          + 'Defaults to the plugin\'s configured ladder, then to the running version alone.',
      },
      runtimeVersion: {
        type: 'string',
        description: 'The running dsh version, when it cannot be read from this profile. It is also the version a `workspace:` alias resolves to.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const resolved = resolveRequest(args, settings, runtimeVersion(ctx))
      const disclosure = [...resolved.disclosure]
      const scanned = resolved.explicit.length === 0
        ? profileScan(ctx)
        : { ranges: [] as DeclaredRange[], disclosure: [] as string[] }
      disclosure.push(...scanned.disclosure)
      const audited = [...resolved.explicit, ...scanned.ranges]
      if (resolved.ladder.length === 0) {
        return cannotTest('no version ladder was supplied and the running dsh version could not be read')
      }
      const result = audit({ ranges: audited, versions: resolved.ladder, runtimeVersion: resolved.running })
      const context: ReportContext = {
        runtimeSource: resolved.running === undefined ? undefined : resolved.runningSource,
        disclosure,
      }
      return render(result, context)
    },
  })
}

/**
 * Mount the audit tool.
 *
 * Both mount spellings are supported: `ctx.plugin(moduleNamespace)` has Cordis
 * fill the exported `Config` defaults, while `ctx.plugin({ name, inject, apply })`
 * passes `undefined` — so the default has to be here, not only in the schema.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (!settings.tool) return
  ctx.effect(() => {
    const dispose = ctx.tools.register(auditTool(ctx, settings))
    return () => dispose()
  }, 'peer-range-audit: register the peer_range_audit tool')
}

export default { name, inject, apply, Config: defaultConfig }
