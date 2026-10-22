/**
 * `/skills:<name>` activation over ACP.
 *
 * External skills are advertised under a namespaced command so the `/` menu
 * distinguishes them from agent commands. The namespaced form cannot use the
 * skill consumer's bare `/name` gesture, so this listener injects the same
 * canonical `<skill_content>` context for the prefixed token. The original
 * user text stays in the transcript; only the model receives the extra
 * instructions.
 *
 * @module dsh-acp-plus/features/skill-activation
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Prefix that separates skill commands from agent commands in the `/` menu. */
export const SKILL_COMMAND_PREFIX = 'skills:'

/** A user-invocable skill definition loaded from the registry. */
interface SkillDefinition {
  readonly name: string
  readonly content: string
  readonly provider: string
  readonly invocation: { readonly userInvocable: boolean }
  readonly resourceBase?:
    | { readonly kind: 'directory'; readonly path: string }
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'opaque'; readonly description: string }
}

interface SkillRegistry {
  get(name: string, options: { cwd?: string; scope?: unknown; signal?: AbortSignal }): Promise<SkillDefinition | undefined>
}

interface WorkingDirectory {
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

/** The public command name for one skill. */
export function skillCommandName(name: string): string {
  return `${SKILL_COMMAND_PREFIX}${name}`
}

/**
 * `/skills:<name>` tokens in claimed user messages, first-seen order.
 * The name grammar matches DSH skill names, and the token must be
 * whitespace-bounded so file paths and URLs do not become activations.
 */
export function prefixedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  const pattern = /(^|\s)\/skills:([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      pattern.lastIndex = 0
      for (const match of block.text.matchAll(pattern)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}

/**
 * Build the skill-invocation context messages one step should append.
 * Unknown names and user-disabled skills are ignored so the original prompt
 * still reaches the model unchanged.
 * @param ctx - context carrying the optional skill and working-directory services.
 * @param agent - exact receiving agent, used as the skill scope.
 * @param messages - claimed messages for this step.
 * @param signal - step cancellation.
 * @returns messages to append after the model's normal step input.
 */
export async function prefixedSkillMessages(
  ctx: Context,
  agent: Agent,
  messages: readonly UserMessage[],
  signal: AbortSignal,
): Promise<UserMessage[]> {
  const names = prefixedSkillNames(messages)
  if (names.length === 0) return []
  const skills = ctx.get('skills' as never) as SkillRegistry | undefined
  if (skills === undefined) return []
  const workingDirectory = ctx.get('workingDirectory' as never) as WorkingDirectory | undefined
  const cwd = workingDirectory === undefined
    ? agent.session.header.cwd
    : await workingDirectory.ensure(agent, signal)
  const injected: UserMessage[] = []
  for (const name of names) {
    let skill: SkillDefinition | undefined
    try {
      skill = await skills.get(name, { cwd, scope: agent, signal })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      ctx.logger.warn(`acp-plus: skill lookup failed for ${name}: ${String(error)}`)
      continue
    }
    signal.throwIfAborted()
    if (skill === undefined || !skill.invocation.userInvocable) continue
    injected.push(createUserMessage({
      content: [{ type: 'text', text: renderSkillContent(skill) }],
      source: { kind: 'skill-invocation', name, form: 'instructions' },
    }))
  }
  return injected
}

/** Canonical model-facing skill rendering, shared shape with the `skill` tool. */
function renderSkillContent(skill: SkillDefinition): string {
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint(skill),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Provider-specific resource guidance inside the skill envelope. */
function resourceHint(skill: SkillDefinition): string[] {
  const base = skill.resourceBase
  if (base === undefined) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  }
  switch (base.kind) {
    case 'directory':
      return [
        `Base directory for this skill: ${escapeText(base.path)}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      ]
    case 'url':
      return [
        `Base URL for this skill: ${escapeText(base.url)}`,
        'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
      ]
    case 'opaque':
      return [
        `Resources for this skill: ${escapeText(base.description)}`,
        'Load referenced resources only as needed.',
      ]
  }
}

/** Escape a skill name inside the opening attribute. */
function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** Escape model-facing prose inside skill markup. */
function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
