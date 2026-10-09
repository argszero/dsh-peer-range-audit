/**
 * The two readings of one declared dsh peer range.
 *
 * A `peerDependencies` entry naming `@deepseek-ai/dsh-*` is checked by more than
 * one reader, and they do not agree:
 *
 * 1. **The profile gate.** `@deepseek-ai/dsh-app-boot` judges every dsh peer of
 *    every plugin row before the tree mounts, and it calls semver with
 *    `{ includePrerelease: true }` — a prerelease runtime satisfies a range that
 *    names a prerelease *floor* even when the prerelease's own `major.minor.patch`
 *    tuple does not appear in the range.
 * 2. **Plain semver.** Default semver — what npm's own resolver runs, and what a
 *    dev checkout or an out-of-profile install sees — refuses that same
 *    combination, because a prerelease version is admitted only by a comparator
 *    carrying a prerelease for the *same* tuple.
 *
 * The divergence is one-way, and this module is where that is expressed. The
 * gate admits everything plain semver admits and more; a range can therefore be
 * *silently* satisfied inside a profile while a plain reader refuses it.
 *
 * [`admits`](./gate.ts) mirrors `packages/boot/app-boot/src/plugin-compatibility.ts`
 * (`evaluatePluginCompatibility`, the `semver.satisfies(runtimeVersion,
 * requirement, { includePrerelease: true })` call) — including its three
 * conventions: only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are judged,
 * the three `workspace:` spellings resolve to the running runtime version, and a
 * blank or unparsable requirement admits nothing. The mirror is not asserted to
 * be equal, it is *measured* to be equal: `test/gate-equivalence.spec.mjs`
 * imports the gate itself and compares the two over a matrix of versions and
 * ranges.
 *
 * @module @argszero/dsh-peer-range-audit/gate
 */

import semver from 'semver'

/** The `workspace:` spellings the gate resolves to the running runtime version. */
export const WORKSPACE_ALIASES: readonly string[] = ['workspace:^', 'workspace:~', 'workspace:*']

/**
 * Whether the gate judges this peer name at all.
 * @param name - a `peerDependencies` key.
 * @returns true for `@deepseek-ai/dsh` and everything under `@deepseek-ai/dsh-`.
 */
export function isGatePeer(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/** How a requirement is read: the gate's reading, or plain semver's. */
export type Reading = 'gate' | 'plain'

/**
 * Whether `version` satisfies `requirement` under one reading.
 *
 * An unparsable `requirement` admits nothing rather than throwing, because that
 * is what the gate does: `semver.satisfies` returns `false` for a range it
 * cannot read, and the gate reports the peer as incompatible.
 * @param version - the dsh runtime version being tested.
 * @param requirement - the requirement after {@link WORKSPACE_ALIASES} resolution.
 * @param reading - `gate` adds `includePrerelease`; `plain` uses semver's defaults.
 * @returns whether the version is admitted.
 */
export function admits(version: string, requirement: string, reading: Reading): boolean {
  if (requirement.trim() === '') return false
  return semver.satisfies(version, requirement, reading === 'gate' ? { includePrerelease: true } : {})
}

/**
 * Whether semver can read a range at all.
 * @param requirement - the candidate range.
 * @returns true when `semver.validRange` accepts it.
 */
export function isValidRange(requirement: string): boolean {
  return semver.validRange(requirement) !== null
}

/**
 * Whether a string is a semantic version.
 * @param version - the candidate version.
 * @returns true when `semver.valid` accepts it.
 */
export function isValidVersion(version: string): boolean {
  return semver.valid(version) !== null
}

/**
 * Whether the version is a prerelease, e.g. `0.2.0-rc.2`.
 *
 * Named rather than inlined because it is the one property every divergence in
 * this family has in common: the gate and plain semver disagree only here.
 * @param version - a semantic version.
 * @returns true when semver parses a prerelease component.
 */
export function isPrerelease(version: string): boolean {
  const parsed = semver.parse(version)
  return parsed !== null && parsed.prerelease.length > 0
}
