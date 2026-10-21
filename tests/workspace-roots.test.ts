/**
 * Multi-root workspace prompt and `@alias/` routing.
 *
 * Two layers are covered: pure alias/prompt rendering, and the bridge
 * behavior — the section reaches the assembled system prompt, and a write
 * addressed as `@alias/…` executes inside the declared root while the
 * containment check still pre-approves it without a client round trip.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import {
  buildWorkspaceRoots,
  expandToolArguments,
  expandWorkspacePath,
  workspaceRootsPrompt,
} from '../src/features/workspace-roots.ts'
import { makeBridgeHarness, textResponse, toolCallResponse, type BridgeHarness } from './harness.ts'

/** Create one scratch directory and a helper for named child roots. */
async function scratch(): Promise<{ root: string; make: (name: string) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-plus-workspace-'))
  return {
    root,
    make: async (name) => {
      const path = join(root, name)
      await mkdir(path, { recursive: true })
      return path
    },
  }
}

/** Read the assembled system-prompt text the mock model received. */
function systemText(harness: BridgeHarness): string {
  const message = harness.adapter.requests[0]?.messages.find(candidate => candidate.role === 'system')
  const content = message?.content as unknown
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n')
}

test('builds deterministic sanitized aliases and resolves collisions by path order', () => {
  const first = buildWorkspaceRoots(['/repos/frontend', '/repos/backend', '/repos/a/web', '/repos/b/web'])
  const second = buildWorkspaceRoots(['/repos/b/web', '/repos/a/web', '/repos/backend', '/repos/frontend'])
  assert.deepEqual(first, second)
  assert.deepEqual(first.map(root => root.alias), ['web', 'web-2', 'backend', 'frontend'])
  assert.deepEqual(first.map(root => root.path), ['/repos/a/web', '/repos/b/web', '/repos/backend', '/repos/frontend'])

  assert.equal(buildWorkspaceRoots(['/repos/My Project'])[0]?.alias, 'my-project')
  assert.equal(buildWorkspaceRoots(['/'])[0]?.alias, 'root')
})

test('expands only declared alias prefixes and leaves other paths untouched', () => {
  const roots = buildWorkspaceRoots(['/repos/frontend', '/repos/backend'])
  assert.equal(expandWorkspacePath('@frontend/src/App.tsx', roots), '/repos/frontend/src/App.tsx')
  assert.equal(expandWorkspacePath('@frontend', roots), '/repos/frontend')
  assert.equal(expandWorkspacePath('@frontend/', roots), '/repos/frontend')
  assert.equal(expandWorkspacePath('@frontend/../shared/file.ts', roots), '/repos/shared/file.ts')
  assert.equal(expandWorkspacePath('@missing/src', roots), '@missing/src')
  assert.equal(expandWorkspacePath('src/@frontend/file.ts', roots), 'src/@frontend/file.ts')
  assert.equal(expandWorkspacePath('/absolute/file.ts', roots), '/absolute/file.ts')
  assert.equal(expandWorkspacePath('@frontend/src', []), '@frontend/src')
})

test('rewrites path-bearing arguments by copy without touching free text', () => {
  const roots = buildWorkspaceRoots(['/repos/frontend'])
  const args = { file_path: '@frontend/src/App.tsx', content: '@frontend/is text', path: '@frontend', workdir: '@frontend/sub' }
  const expanded = expandToolArguments(args, roots) as Record<string, unknown>
  assert.deepEqual(expanded, {
    file_path: '/repos/frontend/src/App.tsx',
    content: '@frontend/is text',
    path: '/repos/frontend',
    workdir: '/repos/frontend/sub',
  })
  const untouched = { file_path: '/already/absolute' }
  assert.equal(expandToolArguments(untouched, roots), untouched)
  assert.equal(expandToolArguments(null, roots), null)
  assert.deepEqual(expandToolArguments(['@frontend/a'], roots), ['@frontend/a'])
})

test('renders a root map and honest write boundaries for each mode', () => {
  const roots = buildWorkspaceRoots(['/repos/frontend', '/repos/backend'])
  const routing = workspaceRootsPrompt('/repos/primary', roots, 'workspace-write', 'routing')
  assert.match(routing, /## Multi-root workspace/)
  assert.match(routing, /Current working directory: `\/repos\/primary`/)
  assert.match(routing, /\| `frontend` \| `\/repos\/frontend` \| read; write\/edit pre-approved \|/)
  assert.match(routing, /@(?:backend|frontend)\/relative\/path/)
  assert.match(routing, /not a blanket write grant/)
  assert.match(routing, /AGENTS\.md/)
  assert.match(routing, /These files are not injected automatically/)

  const map = workspaceRootsPrompt('/repos/primary', roots, 'workspace-write', 'map')
  assert.match(map, /\| Absolute path \| Access \|/)
  assert.match(map, /does not rewrite `@alias\/` prefixes/)
  assert.doesNotMatch(map, /@frontend\/relative\/path/)

  const readOnly = workspaceRootsPrompt('/repos/primary', roots, 'read-only', 'routing')
  assert.match(readOnly, /standing sandbox policy is `read-only`/)
  assert.match(readOnly, /still ask the client/)
})

test('injects the root map and routing rules into the system prompt', async () => {
  const { root, make } = await scratch()
  const extra = await make('extra')
  const harness = await makeBridgeHarness({
    script: [textResponse('ok')],
    config: { enableAdditionalDirectories: true },
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: [extra],
    })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hi' }] })

    const text = systemText(harness)
    assert.match(text, /## Multi-root workspace/)
    assert.match(text, new RegExp(`\\| \`extra\` \\| \`${extra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``))
    assert.match(text, /@extra\/relative\/path/)
    assert.match(text, /without a prefix, relative paths resolve against the current working directory/i)
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('injects nothing when the client declares no additional roots', async () => {
  const harness = await makeBridgeHarness({
    script: [textResponse('ok')],
    config: { enableAdditionalDirectories: true },
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    assert.doesNotMatch(systemText(harness), /Multi-root workspace/)
  } finally {
    await harness.dispose()
  }
})

test('map mode lists roots without advertising alias routing', async () => {
  const { root, make } = await scratch()
  const extra = await make('extra')
  const harness = await makeBridgeHarness({
    script: [textResponse('ok')],
    config: { enableAdditionalDirectories: true, additionalDirectoriesPrompt: 'map' },
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: [extra],
    })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    const text = systemText(harness)
    assert.match(text, /\| Absolute path \| Access \|/)
    assert.match(text, /does not rewrite `@alias\/` prefixes/)
    assert.doesNotMatch(text, /@extra\//)
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('routes @alias writes into the declared root and keeps the logged spelling', async () => {
  const { root, make } = await scratch()
  const extra = await make('extra')
  const harness = await makeBridgeHarness({
    sandboxMode: 'workspace-write',
    filesystemTools: true,
    config: { enableAdditionalDirectories: true },
    script: [
      toolCallResponse('write', 'call-alias', {
        file_path: '@extra/agent.txt',
        content: 'written through the alias',
        sandbox_permissions: 'danger-full-access',
        justification: 'The client pre-authorized this directory for the session.',
      }),
      textResponse('done'),
    ],
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: [extra],
    })
    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'write through the alias' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(await readFile(join(extra, 'agent.txt'), 'utf8'), 'written through the alias')
    assert.equal(harness.permissionRequests.length, 0)
    const call = harness.updates.find(update => update.sessionUpdate === 'tool_call')
    assert.equal((call as { rawInput?: { file_path?: string } } | undefined)?.rawInput?.file_path, '@extra/agent.txt')
    assert.ok(harness.updates.some(update =>
      update.sessionUpdate === 'tool_call_update' && update.status === 'completed'))
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps brace-containing root paths literal in prompt interpolation', async () => {
  const { root, make } = await scratch()
  const extra = await make('{{not_a_variable}}')
  const harness = await makeBridgeHarness({
    script: [textResponse('ok')],
    config: { enableAdditionalDirectories: true },
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: [extra],
    })
    await harness.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'hi' }] })
    assert.match(systemText(harness), /\{\{not_a_variable\}\}/)
  } finally {
    await harness.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
