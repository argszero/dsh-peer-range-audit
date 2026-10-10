/**
 * The integration harness: a REAL cordis context, the REAL `ToolRuntime` from
 * `@deepseek-ai/dsh-tools`, and the plugin mounted on it.
 *
 * Nothing about the seam is simulated. The tool is registered on the real
 * registry and called through `ctx.tools.execute()`, which is the registry's own
 * public entry point — so the argument coercion, the result normalization and the
 * `output.render` projection under test are the shipped ones, not a paraphrase.
 *
 * Two services are *fabricated*, and only two: `loader` and `pluginPackages`.
 * They are fabricated because a real profile needs a real Loader and a real
 * package resolution table, and because the thing worth testing is what the
 * plugin does with their answers — including refusing to guess when they are
 * absent. Every fabricated answer is a manifest read from a literal in the test,
 * and the spec asserts which specifiers were asked for, so a fake cannot quietly
 * answer a different question than the plugin asked.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

/** The neutral signal every fabricated call carries. */
export const SIGNAL = new AbortController().signal

/**
 * Mount a real context with a real tool registry, and by default this plugin.
 * @param spec - `plugin: false` mounts everything except the plugin (the control
 *   arm); `config` is the plugin's configuration; `rows` fabricates the Loader's
 *   entries; `packages` fabricates the profile's package resolution.
 * @returns the context, the specifiers the plugin asked the resolver about, and the captured log.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  const queried = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  if (spec.packages !== undefined) {
    ctx.provide('pluginPackages', {
      packageOf(specifier, parentURL) {
        queried.push({ specifier, parentURL })
        return spec.packages[specifier]
      },
    })
  }
  if (spec.rows !== undefined) ctx.provide('loader', { entries: () => spec.rows })

  if (spec.plugin !== false) {
    // `plugin` is this module's namespace; a loader entry mounts its **default**
    // export (`exports.default ?? exports`), and the two differ by the `Config` key.
    // `plugin: 'default'` mounts the object a profile entry actually reaches — see
    // test/mount.spec.mjs for the defect that difference hides.
    await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
  }
  return { ctx, queried, logged }
}

/**
 * Call the tool through the real registry.
 * @param harness - a harness from {@link world}.
 * @param args - the tool arguments.
 * @param name - the tool name to call (defaults to this plugin's tool).
 * @returns the normalized tool result.
 */
export function call(harness, args = {}, name = 'peer_range_audit') {
  return harness.ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(`call-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
  })
}

/** The text of a result's first content block. */
export function resultText(result) {
  const block = result.content?.[0]
  return block?.type === 'text' ? block.text : ''
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}
