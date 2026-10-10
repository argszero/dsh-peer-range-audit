# @argszero/dsh-peer-range-audit

A read-only tool that reports what a declared `@deepseek-ai/dsh-*` peer range
actually admits — under the two readers that decide it, which do not agree.

- **the profile gate** (`@deepseek-ai/dsh-app-boot`) reads semver with
  `includePrerelease`, so prereleases participate;
- **plain semver** — what npm's own resolver runs, and what a dev checkout or an
  out-of-profile install sees — admits a prerelease only through a comparator
  that names a prerelease for the *same* `major.minor.patch`.

The divergence is **one-way and silent**. A range can be satisfied inside a
profile and refused by the very next `npm install`, and nothing in the project
says so, because the gate only ever answers yes/no about the version it happens
to be running as.

## The problem

The gate's test is one line
(`packages/boot/app-boot/src/plugin-compatibility.ts`):

```ts
semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })
```

`includePrerelease` is the whole story. Under it, `^0.2.0` is satisfied by
`0.2.0-rc.2` — the range names no prerelease, but the reader lets prereleases of
any in-range tuple through anyway. Plain semver refuses `0.2.0-rc.2` for
`^0.2.0`, and so does npm:

```
$ npm install            # a checkout that declares @deepseek-ai/dsh-tools: ^0.2.0
npm error ERESOLVE unable to resolve dependency tree
```

So a plugin author who writes the range that looks right, tests it in a profile
where it works, and publishes it has shipped a package that a plain consumer
cannot install — and the failure surfaces somewhere else entirely.

Measured over the 31 published versions of `@deepseek-ai/dsh-agent`, against the
gate the project actually runs (`0.2.0-rc.2`):

| declared range | gate admits | plain admits | verdict |
|---|---:|---:|---|
| `^0.2.0` | 1 | 0 | gate-only |
| `^0.2.0-rc.2` | 2 | 1 | gate-only |
| `>=0.1.7-alpha.1 <0.2.0` | 6 | 4 | gate-only |
| `>=0.1.2 <0.2.0-0` | 12 | 0 | gate-only |
| `>=0.1.7-alpha.1 <0.2.0 \|\| >=0.2.0-rc.1 <0.2.0` | 6 | 6 | identical |

The direction is fixed and was measured, not assumed: over that ladder nothing
is admitted by plain semver and refused by the gate, and the gate admits
everything plain semver does and more. The divergence is therefore always
prereleases, and always in one direction.

## Install

```sh
npm install @argszero/dsh-peer-range-audit@0.1.1
```

Then mount it. The package ships a bundle patch
(`dsh.bundle.patch: ./cordis.patch.yml`), so a deployment that follows the
harness's bundle convention gets it by adding one entry:

```yaml
- insert:
    - id: peer-range-audit
      name: '@argszero/dsh-peer-range-audit'
```

Mounting it directly works the same way and takes the same config:

```ts
import audit from '@argszero/dsh-peer-range-audit'

ctx.plugin(audit, { versions: ['0.2.0-rc.2', '0.1.7-rc.2'] })
```

The declared peers are `@deepseek-ai/cordis` (`^4.0.2`) and
`@deepseek-ai/dsh-tools`:

```
>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.1
```

Verified against the `0.1.7-rc.2` and `0.2.0-rc.2` lines (`npm run
test:probe-lines` pins every harness package to one line and runs the suite
against it). The range is a union of one segment per line on purpose: each
segment names its line's prerelease floor, so plain semver admits it too. That
is the shape the tool points authors at, and this package holds itself to it —
`test/packaging.spec.mjs` asserts that no claimed line needs the gate reading.

## Usage

Inside a profile, with no arguments, it audits the dsh peer ranges of the
plugins that profile mounts:

```
peer_range_audit {}
```

Everything else is named explicitly:

```
peer_range_audit {
  "manifests": [ <a parsed package.json> ],
  "versions": ["0.2.0-rc.2", "0.2.1-alpha.1", "0.1.7-rc.2"]
}
```

- `requirements` — bare range strings, exactly as written.
- `manifests` — parsed `package.json` objects; every `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*` entry of each `peerDependencies` is audited.
- `versions` — the ladder to test, for example from
  `npm view @deepseek-ai/dsh-agent versions --json`. Defaults to the plugin's
  configured ladder, then to the running version alone.
- `runtimeVersion` — the running dsh version, when it cannot be read here. It is
  also what a `workspace:` alias resolves to.

A report looks like this:

```
peer-range-audit: 1 declared dsh peer range(s), 31 version(s) tested, running version 0.2.0-rc.2 (read from @deepseek-ai/dsh-tools as resolved by this profile)

  gate  = the profile compatibility gate (packages/boot/app-boot/src/plugin-compatibility.ts): semver with includePrerelease, so prereleases participate.
  plain = default semver, which is what npm's own resolver does: a prerelease is admitted only by a comparator naming a prerelease for the same major.minor.patch.

[1] third-party-plugin → @deepseek-ai/dsh-tools — range
    declared    : >=0.1.7-alpha.1 <0.2.0
    gate admits : 0.1.7-alpha.1, 0.1.7-alpha.2, 0.1.7-rc.1, 0.1.7-rc.2, 0.2.0-rc.1, 0.2.0-rc.2 (6/31)
    plain admits: 0.1.7-alpha.1, 0.1.7-alpha.2, 0.1.7-rc.1, 0.1.7-rc.2 (4/31)
    gate only   : 0.2.0-rc.1, 0.2.0-rc.2  <- prereleases: the gate reads them, plain semver does not
    plain only  : (none)
    verdict     : gate-only — the readings differ, and only over prereleases; a plain consumer (npm, a dev checkout) refuses what the gate admits
    runtime     : runtime 0.2.0-rc.2: gate admits, plain refuses — admission of the running version rests on the gate's prerelease reading alone

Summary: 0 range(s) read identically, 1 diverge between the two readings.
```

The `runtime` line is the one that matters for a plugin already mounted: it says
whether the row is there because the gate reads prereleases, and would therefore
disappear for anyone installing it outside a profile.

## What it deliberately does not do

- **It never proposes a replacement range.** The honest output of a set
  comparison is the two sets. A synthesized range can be wider than the one it
  replaces and still look like a fix; an audit that quietly widens a
  compatibility claim is worse than no audit.
- **It never refuses, cancels or rewrites anything.** It is a diagnostic, and a
  diagnostic that changes behaviour stops being one. Nothing is logged as a
  refusal, a change or an error.
- **It reports its coverage.** The ladder is whatever the caller supplied, so
  "nothing is admitted" always means "nothing *in this ladder*". Counts are
  printed beside every set, and a profile scan says which rows it saw, which
  names resolved to a package, and which did not.

## Config

| key | default | meaning |
|---|---|---|
| `tool` | `true` | register the `peer_range_audit` tool |
| `versions` | `[]` | default ladder for calls that name none |
| `maxVersions` | `200` | bound on the tested ladder |
| `maxRequirements` | `50` | bound on the ranges audited in one call |

Both bounds truncate **loudly**: the report says how many were dropped. With
`tool: false` the plugin mounts and registers nothing.

## Where the running version comes from

`@deepseek-ai/dsh-tools` is a declared peer of this package and is always present
where the plugin runs, and the dsh packages are released in lockstep — the 31
published versions of `dsh-tools`, `dsh-app-boot` and `dsh-agent` are the same 31
strings — so its version stands in for the runtime's. The lookup goes through the
profile's own resolver (`ctx.pluginPackages.packageOf`) when that service is
present, and falls back to Node resolution from this module. When neither yields
a version, the tool says so and asks for `versions` or `runtimeVersion` rather
than guessing.

## Which reading decides

Inside a profile, the reader that decides is the gate — and pnpm, the profile's
installer, agrees with it (measured: `pnpm install` on the same range is clean;
`npm install` raises `ERESOLVE`). The `plain` column describes npm's resolver, a
dev checkout, or an out-of-profile install, which is where the gate's answer does
not travel.

## Notes

- Zero changes to the sandbox, the tool pipeline or any approval path: it
  registers one read-only tool.
- `semver` is a runtime dependency rather than a peer: a diagnostic that cannot
  parse a requirement because its parser was never installed is not a
  diagnostic.
- `src/gate.ts` mirrors the gate's predicate, including its three conventions
  (only `@deepseek-ai/dsh` / `dsh-*` peers are judged, the three `workspace:`
  spellings resolve to the running version, and a blank or unparsable
  requirement admits nothing). The mirror is not asserted to be equal, it is
  *measured* to be equal: `test/gate-equivalence.spec.mjs` imports the gate
  itself and compares the two over a matrix of versions and ranges.
