/**
 * Configuration, normalized once at mount.
 *
 * There are three knobs, and each answers a question an operator asks when a
 * read-only diagnostic is mounted into a deployment:
 *
 * - **`tool`** — is the tool registered at all? It is a tool on every agent's
 *   tool list, so a deployment that wants the audit available by mounting and
 *   not by asking can turn it off and keep the plugin mounted.
 * - **`versions`** — the version ladder to test when a call does not name one.
 *   Without it the audit tests the running version alone, which answers "is this
 *   plugin's range satisfied here" but not "what else does this range admit"; a
 *   deployment that pins a ladder gets the second answer for every call.
 * - **`maxVersions` / `maxRequirements`** — the output is a text report the model
 *   reads, so both lists are bounded. Truncation is refused loudly rather than
 *   silently: the tool says how many were dropped.
 *
 * There is deliberately no mode that rewrites or refuses anything: this plugin
 * only reports. A range is a claim about versions nobody ran, and the honest
 * machine answer is the two admitted sets, not a new range.
 *
 * @module @argszero/dsh-peer-range-audit/config
 */

/** The plugin configuration as a user writes it. */
export interface Config {
  /** Register the `peer_range_audit` tool (default `true`). */
  readonly tool?: boolean
  /** Default version ladder for calls that name none. */
  readonly versions?: readonly string[]
  /** Inclusive bound on the tested ladder (default 200). */
  readonly maxVersions?: number
  /** Inclusive bound on the declared ranges audited in one call (default 50). */
  readonly maxRequirements?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly tool: boolean
  readonly versions: readonly string[]
  readonly maxVersions: number
  readonly maxRequirements: number
}

/**
 * The reference defaults: the value behind every absent knob.
 *
 * Deliberately **not** exported as the plugin's `Config`. Cordis validates a
 * mounted plugin's `Config` through `Config['~standard'].validate`, and a plain
 * defaults object has no `~standard`, so exporting one there makes the mount
 * throw before `apply` runs. The entry point exports `{ name, inject, apply }`
 * with no `Config`, and these defaults arrive through `apply(ctx, config = {})`.
 */
export const defaultConfig: Required<Config> = {
  tool: true,
  versions: [],
  maxVersions: 200,
  maxRequirements: 50,
}

/** Read a boolean, falling back for anything that is not one. */
function boolean(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a positive integer, falling back when the value is absent or unusable. */
function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** Read a list of non-empty strings, dropping anything else and deduplicating in order. */
function strings(value: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback
  const seen: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || seen.includes(trimmed)) continue
    seen.push(trimmed)
  }
  return seen
}

/**
 * Resolve a user configuration into the settings the plugin runs with.
 * @param config - the configuration as mounted, possibly empty.
 * @returns every setting, with defaults applied.
 */
export function normalizeConfig(config: Config): Settings {
  return {
    tool: boolean(config.tool, defaultConfig.tool),
    versions: strings(config.versions, defaultConfig.versions),
    maxVersions: positiveInteger(config.maxVersions, defaultConfig.maxVersions),
    maxRequirements: positiveInteger(config.maxRequirements, defaultConfig.maxRequirements),
  }
}
