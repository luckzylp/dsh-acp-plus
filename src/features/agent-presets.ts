/**
 * Agent presets selected by the ACP process environment.
 *
 * ACP has no standard agent-preset field, and Zed does not send one. Zed's
 * `agent_servers.env` is inherited by the spawned `dsh`, so the bridge reads
 * `DSH_ACP_AGENT_PRESET` once at mount and binds that preset to every new ACP
 * session. The choice is creation-time data: `session/load` and
 * `session/resume` re-mount the preset persisted in the session header.
 *
 * A preset is a DSH composition (`ctx.agentPresets`), not a sandbox. The
 * environment variable only chooses a roster entry; the profile still owns
 * which presets exist and what each one mounts.
 *
 * @module dsh-acp-plus/features/agent-presets
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: declaration-merges `ctx.agentPresets`.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Environment variable read once when the bridge mounts. */
export const AGENT_PRESET_ENV = 'DSH_ACP_AGENT_PRESET'

/** Caller-correctable agent-preset failure. */
export class AcpPlusAgentPresetError extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message: string) {
    super(message)
    this.name = 'AcpPlusAgentPresetError'
  }
}

/**
 * Read the requested preset from a process environment.
 * @param env - environment map, defaulting to the live process environment.
 * @returns the trimmed preset id, or undefined when unset or blank.
 */
export function agentPresetFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[AGENT_PRESET_ENV]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * Resolve an explicitly requested preset against the mounted roster.
 * @param ctx - plugin context carrying the optional preset registry.
 * @param id - requested preset id, or undefined to preserve the host composition.
 * @returns the canonical preset id, or undefined when none was requested.
 * @throws {AcpPlusAgentPresetError} when no registry is mounted or the id is unusable.
 */
export async function resolveAgentPreset(
  ctx: Context,
  id: string | undefined,
): Promise<string | undefined> {
  if (id === undefined) return undefined
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    throw new AcpPlusAgentPresetError(
      `${AGENT_PRESET_ENV} requests agent preset "${id}", but @deepseek-ai/dsh-agent-preset-registry is not mounted`,
    )
  }
  try {
    const preset = await presets.resolve(id)
    if (preset.broken !== undefined) {
      throw new AcpPlusAgentPresetError(`agent preset "${id}" is unavailable: ${preset.broken}`)
    }
    return preset.id
  } catch (error: unknown) {
    if (error instanceof AcpPlusAgentPresetError) throw error
    throw new AcpPlusAgentPresetError(
      `agent preset "${id}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Bind one unpublished Agent to a resolved preset revision.
 * @param ctx - plugin context carrying the preset registry.
 * @param agentCtx - Agent scope from the setup callback.
 * @param id - canonical preset id.
 * @throws {AcpPlusAgentPresetError} when the registry is missing or mounting fails.
 */
export async function mountAgentPreset(
  ctx: Context,
  agentCtx: Context,
  id: string,
): Promise<void> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    throw new AcpPlusAgentPresetError(
      `agent preset "${id}" cannot be mounted: @deepseek-ai/dsh-agent-preset-registry is not mounted`,
    )
  }
  try {
    await presets.mount(agentCtx, id)
  } catch (error: unknown) {
    throw new AcpPlusAgentPresetError(
      `agent preset "${id}" could not be mounted: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
