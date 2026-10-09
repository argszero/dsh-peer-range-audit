/**
 * Shared fixtures for the suite.
 *
 * `LADDER` is the published version ladder of the dsh packages, recorded from
 * `npm view @deepseek-ai/dsh-tools versions --json` on 2026-10-09 — all 31
 * versions, of `dsh-tools`, `dsh-app-boot` and `dsh-agent` alike, because those
 * three sets are the same 31 strings. It is a checkpoint, not a live query: the
 * suite must give the same answer on a machine with no network, and a fixture
 * that silently grew would change what the assertions below mean.
 *
 * The five `MEASURED` rows are independent of this package. They were computed
 * in an earlier probe with a different implementation (the one behind
 * discussion #9194's reply) over the then-current ladder; that this suite
 * reproduces every number from a fixture is what makes the two implementations
 * evidence for each other rather than one program checking itself.
 *
 * @module test/fixtures
 */

/** Every published version of the dsh packages, recorded 2026-10-09. */
export const LADDER = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.3', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
  '0.1.3-alpha.2', '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
  '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1',
]

/** The version the profile in these tests is "running". */
export const RUNTIME = '0.2.0-rc.2'

/**
 * Ranges whose two admitted-set sizes were measured elsewhere, and the numbers
 * that measurement produced (`gate` / `plain` over {@link LADDER}).
 */
export const MEASURED = [
  { range: '^0.2.0', gate: 1, plain: 0 },
  { range: '^0.2.0-rc.2', gate: 2, plain: 1 },
  { range: '>=0.1.7-alpha.1 <0.2.0', gate: 6, plain: 4 },
  { range: '>=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.0', gate: 6, plain: 6 },
  { range: '>=0.1.2 <0.2.0-0', gate: 12, plain: 0 },
]

/**
 * A package.json with one dsh peer.
 * @param range - the declared range.
 * @param overrides - fields to merge over the base manifest.
 * @returns the manifest object.
 */
export function manifest(range, overrides = {}) {
  return {
    name: 'some-plugin',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-tools': range },
    ...overrides,
  }
}
