/**
 * Session controls that ACP clients must see as configuration options.
 *
 * ACP has two overlapping ways to describe a session mode: the `modes`
 * response field and a `configOptions` entry with category `mode`. Zed 1.24.x
 * gives `configOptions` precedence and drops `modes` whenever any config
 * option is present, so a client that shows model and reasoning effort never
 * sees plan mode. The bridge therefore publishes plan mode in both places:
 * `modes` stays for clients that use it, and a `mode` config option makes it
 * visible to clients that only render config options.
 *
 * The same mechanism exposes the mounted permission-preset selector. It is a
 * control only: switching a preset still goes through the harness's existing
 * permission write path, exactly like the `/permission` command.
 *
 * @module dsh-acp-plus/features/session-options
 */

import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: declaration-merges `ctx.permissionPresets` and its projection.
import type {} from '@deepseek-ai/dsh-permission-presets'
// Type-only: declaration-merges `ctx.planMode`.
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_MODE_ID,
  PLAN_MODE_ID,
  setSessionMode,
} from './modes.ts'

/** Config-option id for the default/plan selector. */
export const SESSION_MODE_CONFIG_ID = 'mode'
/** Config-option id for the permission-preset selector. */
export const PERMISSION_CONFIG_ID = 'permission'

/** Reserved permission-preset identity for settings that match no preset. */
const CUSTOM_PRESET = 'custom'

/** Caller-correctable failure from an added session option. */
export class AcpPlusSessionOptionError extends Error {
  /** @param message - detail preserved on the wire as invalid params. */
  constructor(message: string) {
    super(message)
    this.name = 'AcpPlusSessionOptionError'
  }
}

/** The two stable plan-mode choices. */
const MODE_OPTIONS: readonly SessionConfigSelectOption[] = [
  {
    value: DEFAULT_MODE_ID,
    name: 'Default',
    description: 'Carry out the task directly.',
  },
  {
    value: PLAN_MODE_ID,
    name: 'Plan',
    description: 'Research and present a plan before making changes.',
  },
]

/**
 * Project plan mode as a config option.
 *
 * A pending selection is shown as the current value because the user just
 * chose it; the committed `plan/mode` event publishes the same value once the
 * next step accepts it.
 * @param ctx - plugin context carrying the optional plan-mode controller.
 * @param agent - session whose plan state is read.
 * @returns the option, or undefined when plan mode is not mounted.
 */
export function modeConfigOption(ctx: Context, agent: Agent): SessionConfigOption | undefined {
  const planMode = ctx.get('planMode')
  if (planMode === undefined) return undefined
  try {
    const state = planMode.get(agent)
    const active = state.pending === true ? !state.active : state.active
    return {
      id: SESSION_MODE_CONFIG_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: active ? PLAN_MODE_ID : DEFAULT_MODE_ID,
      options: MODE_OPTIONS.map(option => ({ ...option })),
    }
  } catch (_unavailablePlanState) {
    return undefined
  }
}

/**
 * Project the mounted permission-preset catalog as a config option.
 *
 * The option is omitted when no permission service or `permissions`
 * projection is available, so the wire never advertises a control the
 * session cannot honor.
 * @param ctx - plugin context carrying the optional permission service.
 * @param session - session whose current preset is read.
 * @returns the option, or undefined when permission presets are unavailable.
 */
export function permissionConfigOption(ctx: Context, session: Session): SessionConfigOption | undefined {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined) return undefined
  try {
    const current = presets.current(session)
    const options = presets.catalog().options.map(option => ({
      value: option.value,
      name: option.name,
      ...option.description === undefined ? {} : { description: option.description },
    }))
    // `custom` is a derived current value, not a switch target. Keep it
    // visible as the current selection but do not invent a preset for it.
    if (!options.some(option => option.value === current)) {
      options.push({
        value: current,
        name: current === CUSTOM_PRESET ? 'Custom' : current,
        ...current === CUSTOM_PRESET
          ? { description: 'The effective settings match no available preset.' }
          : {},
      })
    }
    return {
      id: PERMISSION_CONFIG_ID,
      name: 'Permission',
      // Custom categories are reserved for extensions unless prefixed with `_`.
      category: '_permission',
      type: 'select',
      currentValue: current,
      options,
    }
  } catch (_unavailablePermissionState) {
    return undefined
  }
}

/**
 * Additional config options for one Agent, in display order.
 * @param ctx - plugin context carrying the optional session services.
 * @param agent - receiving Agent.
 * @returns plan mode and permission options that are currently available.
 */
export function sessionConfigOptions(ctx: Context, agent: Agent): SessionConfigOption[] {
  return [
    modeConfigOption(ctx, agent),
    permissionConfigOption(ctx, agent.session),
  ].filter((option): option is SessionConfigOption => option !== undefined)
}

/**
 * Apply an added session option before model control sees it.
 * @param ctx - plugin context carrying the optional session services.
 * @param agent - receiving Agent.
 * @param configId - requested config-option id.
 * @param value - requested select value.
 * @returns true when this module owns the id and applied or rejected the value.
 * @throws {AcpPlusSessionOptionError} for an unknown permission preset.
 */
export function setSessionConfigOption(
  ctx: Context,
  agent: Agent,
  configId: string,
  value: string,
): boolean {
  if (configId === SESSION_MODE_CONFIG_ID) {
    // Reuse the exact mode path, including its unknown-id rejection.
    setSessionMode(ctx, agent, value)
    return true
  }
  if (configId !== PERMISSION_CONFIG_ID) return false
  const presets = ctx.get('permissionPresets')
  if (presets === undefined) return false
  // Selecting the derived current value is a no-op; it is not a preset.
  if (value === CUSTOM_PRESET) return true
  try {
    presets.set(agent.session, value)
  } catch (error: unknown) {
    throw new AcpPlusSessionOptionError(
      `unknown permission preset: ${value} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return true
}
