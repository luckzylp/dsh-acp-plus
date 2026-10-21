/**
 * Multi-root workspace prompt and `@alias/` path routing.
 *
 * ACP's `additionalDirectories` already authorizes the roots and pre-approves
 * verified single-target writes; this module adds the model-facing half:
 *
 * - one ordered system-prompt section with the root map and routing rules, so
 *   the model knows the whole workspace instead of only the primary `cwd`;
 * - a `tools/execute` wrapper that expands an `@alias/` prefix in the few
 *   path-bearing arguments the shipped file tools use. The DSH tools resolve
 *   relative paths against the session cwd and have no alias concept of their
 *   own, so prompt text alone would be a promise the tool layer cannot keep.
 *
 * The wrapper is registered on the Agent scope, so it only affects the ACP
 * session that declared the roots. `map` mode stays prompt-only; `off` leaves
 * the session completely unchanged apart from the existing authorization.
 *
 * @module dsh-acp-plus/features/workspace-roots
 */

import { basename, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

/** How much of the multi-root guidance a session receives. */
export type WorkspacePromptMode = 'routing' | 'map' | 'off'

/** One additional root as the prompt and routing layer see it. */
export interface WorkspaceRoot {
  /** Stable short name addressed as `@alias/`. */
  alias: string
  /** Canonical absolute directory. */
  path: string
}

/** System-prompt section name for the multi-root guidance. */
export const WORKSPACE_ROOTS_SECTION = 'acp-plus:workspace-roots'

/**
 * Prompt placement: after the file-reference section (900) and before the
 * first tool-guidance section (1000). A literal is allowed for external
 * contributions; no named slot exists for a deployment-owned workspace map.
 */
const WORKSPACE_ROOTS_ORDER = 950

/** Argument names that the shipped file tools and bash resolve as paths. */
export const PATH_ARGUMENT_KEYS: readonly string[] = ['file_path', 'path', 'workdir', 'cwd']

/** One `@alias/…` reference; the alias starts with an alphanumeric. */
const ALIAS_PATH = /^@([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/(.*))?$/s

/** Sandbox modes the prompt can describe, or undefined when unresolved. */
type WorkspaceMode = 'read-only' | 'workspace-write' | 'danger-full-access' | undefined

/** Derive a safe, readable alias base from one root's final path segment. */
function aliasBase(path: string): string {
  const base = basename(path)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .toLowerCase()
  return base.length === 0 ? 'root' : base
}

/**
 * Build deterministic aliases for a declared root set.
 *
 * Sorting by path keeps aliases stable when a client re-declares the same set
 * in a different order on `session/load` or `session/resume`; collisions get
 * a numeric suffix.
 * @param directories - canonical additional roots from authorization.
 * @returns roots sorted by path, each with a unique `@alias`.
 */
export function buildWorkspaceRoots(directories: readonly string[]): readonly WorkspaceRoot[] {
  const used = new Set<string>()
  return [...directories]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((path) => {
      const base = aliasBase(path)
      let alias = base
      for (let suffix = 2; used.has(alias); suffix += 1) alias = `${base}-${suffix}`
      used.add(alias)
      return { alias, path }
    })
}

/**
 * Expand one `@alias/…` reference to an absolute path.
 *
 * A string that does not name a declared alias is returned unchanged, so
 * ordinary `@`-prefixed filenames keep working. `..` segments resolve
 * normally; the result then goes through the same sandbox policy as any other
 * absolute path.
 * @param path - model-supplied path argument.
 * @param roots - aliases declared for this session.
 * @returns the expanded absolute path, or the original string.
 */
export function expandWorkspacePath(path: string, roots: readonly WorkspaceRoot[]): string {
  const match = ALIAS_PATH.exec(path)
  if (match === null) return path
  const root = roots.find(candidate => candidate.alias === match[1])
  if (root === undefined) return path
  const rest = match[2]
  return rest === undefined || rest.length === 0 ? root.path : resolve(root.path, rest)
}

/**
 * Rewrite path-bearing top-level arguments in place, by copy.
 * @param args - parsed tool arguments.
 * @param roots - aliases declared for this session.
 * @returns a replacement arguments object only when something expanded.
 */
export function expandToolArguments(args: unknown, roots: readonly WorkspaceRoot[]): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const source = args as Record<string, unknown>
  let next: Record<string, unknown> | undefined
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = source[key]
    if (typeof value !== 'string') continue
    const expanded = expandWorkspacePath(value, roots)
    if (expanded === value) continue
    next ??= { ...source }
    next[key] = expanded
  }
  return next ?? args
}

/** Pick a Markdown code fence longer than any run inside the value. */
function codeSpan(value: string): string {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${value}${fence}`
}

/** Render one table cell without letting a pipe or newline split the table. */
function tableCell(value: string): string {
  return codeSpan(value.replace(/[\r\n\t]+/g, ' ').replace(/\|/g, '\\|'))
}

/** Describe writes for the root map's Access column. */
function accessLabel(mode: WorkspaceMode): string {
  switch (mode) {
    case 'workspace-write': return 'read; write/edit pre-approved'
    case 'read-only': return 'read-only'
    case 'danger-full-access': return 'read-write'
    default: return 'per session policy'
  }
}

/** Render the mode-specific write boundary that matches the bridge's behavior. */
function writesSection(mode: WorkspaceMode): string {
  switch (mode) {
    case 'read-only':
      return 'This session\'s standing sandbox policy is `read-only`. Reads and searches are allowed in every listed root; writes and mutating shell commands are not pre-approved anywhere and still ask the client. When a write target is ambiguous, ask instead of guessing.'
    case 'danger-full-access':
      return 'This session\'s standing sandbox policy is `danger-full-access`; the sandbox does not restrict writes to the listed roots. Prefer the root that owns the file, and do not treat that standing policy as permission to edit unrelated paths. When a write target is ambiguous, ask instead of guessing.'
    case 'workspace-write':
      return 'Write only to roots whose Access column permits writes. Additional roots are not a blanket write grant: under `workspace-write`, a `write` or `edit` inside a declared root still goes through one containment-checked escalation, and the bridge pre-approves it only when the resolved target is inside a declared root. On such a call, include `sandbox_permissions="danger-full-access"` and a one-sentence justification. Bash writes, paths outside every declared root, and every write in a `read-only` session still ask the client. When a write target is ambiguous, ask instead of guessing.'
    default:
      return 'The session\'s sandbox policy is resolved per call. Writes may still ask the client; only roots marked writable in the Access column are intended targets. When a write target is ambiguous, ask instead of guessing.'
  }
}

/** Render the root map table for the selected mode. */
function rootMap(roots: readonly WorkspaceRoot[], mode: WorkspaceMode, routing: boolean): string {
  if (!routing) {
    return [
      '| Absolute path | Access |',
      '|---------------|--------|',
      ...roots.map(root => `| ${tableCell(root.path)} | ${accessLabel(mode)} |`),
    ].join('\n')
  }
  return [
    '| Alias | Absolute path | Access |',
    '|-------|---------------|--------|',
    ...roots.map(root =>
      `| ${tableCell(root.alias)} | ${tableCell(root.path)} | ${accessLabel(mode)} |`),
  ].join('\n')
}

/** Render the path-routing rules, or the map-only addressing note. */
function routingSection(roots: readonly WorkspaceRoot[], routing: boolean): string {
  if (!routing) {
    return 'Use absolute paths for the additional roots. Relative paths resolve against the current working directory. This session does not rewrite `@alias/` prefixes.'
  }
  const example = roots[0]
  const lines = [
    'The shipped file tools (`read`, `read_image`, `write`, `edit`, `grep`, `glob`) and `bash` accept an `@alias/` prefix on their top-level path argument (`file_path`, `path`, `workdir`, or `cwd`). The bridge expands it before the tool runs.',
  ]
  if (example !== undefined) {
    lines.push('', `- \`@${example.alias}/relative/path\` resolves to \`${resolve(example.path, 'relative/path')}\`.`)
  }
  lines.push(
    '',
    'Without a prefix, relative paths resolve against the current working directory. Absolute paths work unchanged. Do not use `@alias/` inside a bash command string: only the `workdir` argument is expanded.',
  )
  return lines.join('\n')
}

/**
 * Render the complete multi-root section.
 * @param cwd - the session's current working directory.
 * @param roots - additional roots with aliases.
 * @param mode - resolved sandbox mode, when available.
 * @param promptMode - `routing` adds the alias syntax; `map` only lists roots.
 * @returns the Markdown section text.
 */
export function workspaceRootsPrompt(
  cwd: string,
  roots: readonly WorkspaceRoot[],
  mode: WorkspaceMode,
  promptMode: Exclude<WorkspacePromptMode, 'off'>,
): string {
  const routing = promptMode === 'routing'
  return [
    '## Multi-root workspace',
    'This session operates across its primary working directory plus the additional roots in the root map. Treat them as one logical workspace; no listed root is subordinate to another.',
    `Current working directory: ${codeSpan(cwd)}`,
    '### Root map',
    rootMap(roots, mode, routing),
    '### Path routing',
    routingSection(roots, routing),
    '### When to use which root',
    [
      '- If the user names a project, component, or file that clearly belongs to one root, route there directly.',
      '- If the target is ambiguous, ask the user which root before writing.',
      '- Before editing a root for the first time in a session, read that root\'s `AGENTS.md` or `CLAUDE.md` if present. If absent, fall back to the default root\'s file. Do not infer one root\'s conventions from another without checking. These files are not injected automatically.',
    ].join('\n'),
    '### Writes and scope',
    writesSection(mode),
  ].join('\n\n')
}

/** Resolve the session's standing sandbox mode without failing prompt assembly. */
function sandboxMode(ctx: Context, agent: Agent): WorkspaceMode {
  try {
    return ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode
  } catch (_unresolvablePolicy) {
    return undefined
  }
}

/**
 * Publish the multi-root guidance and, in `routing` mode, expand `@alias/`
 * arguments for this Agent only.
 * @param agentCtx - unpublished Agent scope that owns both contributions.
 * @param agent - the Agent whose session policy and cwd supply the details.
 * @param directories - canonical additional roots from authorization.
 * @param promptMode - deployment's prompt mode.
 * @returns aliases for approval containment; empty when nothing was registered.
 */
export function registerWorkspaceRoots(
  agentCtx: Context,
  agent: Agent,
  directories: readonly string[],
  promptMode: WorkspacePromptMode,
): readonly WorkspaceRoot[] {
  if (directories.length === 0 || promptMode === 'off') return []
  const roots = buildWorkspaceRoots(directories)
  const systemPrompt = agentCtx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: WORKSPACE_ROOTS_SECTION,
      order: WORKSPACE_ROOTS_ORDER,
      // Paths may contain `{{…}}`; never let prompt interpolation reinterpret them.
      interpolate: false,
      text: () => {
        // The model can `cd`; reuse the committed working directory rather
        // than pinning the original session header.
        const cwd = agentCtx.get('workingDirectory')?.get(agent.session)
          ?? agent.session.header.cwd
          ?? process.cwd()
        return workspaceRootsPrompt(cwd, roots, sandboxMode(agentCtx, agent), promptMode)
      },
    })
  }
  if (promptMode === 'routing') {
    agentCtx.on('tools/execute', (exec, next) => {
      const expanded = expandToolArguments(exec.arguments, roots)
      if (expanded !== exec.arguments) {
        // The registry freezes only the parsed arguments object, not the
        // execution record; replacing the field is the around-dispatch view.
        // The durable `tool/call` event keeps the model's original spelling.
        Object.assign(exec, { arguments: expanded })
      }
      return next()
    })
  }
  return promptMode === 'routing' ? roots : []
}
