/**
 * Agent presets selected by `DSH_ACP_AGENT_PRESET`.
 *
 * ACP has no standard preset field and Zed does not send one, so the bridge
 * reads the environment inherited from `agent_servers.env`. These tests lock
 * the opt-in behavior: no env means the host composition, an env id binds a
 * preset to new sessions, and resume re-mounts the persisted preset.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AGENT_PRESET_ENV, agentPresetFromEnvironment } from '../src/features/agent-presets.ts'
import { makeBridgeHarness } from './harness.ts'

const CWD = process.cwd()

/** Set the preset environment for one test and always restore it. */
async function withPresetEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[AGENT_PRESET_ENV]
  if (value === undefined) delete process.env[AGENT_PRESET_ENV]
  else process.env[AGENT_PRESET_ENV] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[AGENT_PRESET_ENV]
    else process.env[AGENT_PRESET_ENV] = previous
  }
}

/** Start a session and return its durable header preset. */
async function createSession(harness: Awaited<ReturnType<typeof makeBridgeHarness>>): Promise<string | undefined> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
  return harness.ctx.sessions.get(brandString<SessionId>(created.sessionId))?.header.agentPreset
}

test('reads a trimmed preset id from the environment and treats blank as unset', () => {
  assert.equal(agentPresetFromEnvironment({ [AGENT_PRESET_ENV]: '  review  ' } as NodeJS.ProcessEnv), 'review')
  assert.equal(agentPresetFromEnvironment({ [AGENT_PRESET_ENV]: '   ' } as NodeJS.ProcessEnv), undefined)
  assert.equal(agentPresetFromEnvironment({} as NodeJS.ProcessEnv), undefined)
})

test('binds the environment preset to a new session', async () => {
  await withPresetEnv('review', async () => {
    const harness = await makeBridgeHarness({
      agentPresets: { presets: [{ id: 'standard' }, { id: 'review' }], default: 'standard' },
    })
    try {
      assert.equal(await createSession(harness), 'review')
      assert.deepEqual(harness.agentPresets.resolved, ['review'])
      assert.deepEqual(harness.agentPresets.mounted, ['review'])
    } finally {
      await harness.dispose()
    }
  })
})

test('keeps the host composition when the environment is unset', async () => {
  await withPresetEnv(undefined, async () => {
    const harness = await makeBridgeHarness({
      agentPresets: { presets: [{ id: 'standard' }, { id: 'review' }], default: 'standard' },
    })
    try {
      assert.equal(await createSession(harness), undefined)
      assert.deepEqual(harness.agentPresets.resolved, [])
      assert.deepEqual(harness.agentPresets.mounted, [])
    } finally {
      await harness.dispose()
    }
  })
})

test('rejects an environment preset when no registry is mounted', async () => {
  await withPresetEnv('standard', async () => {
    const harness = await makeBridgeHarness()
    try {
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await assert.rejects(Promise.resolve(harness.client.newSession({ cwd: CWD, mcpServers: [] })),
        /agent-preset-registry is not mounted/)
    } finally {
      await harness.dispose()
    }
  })
})

test('rejects an unknown or broken environment preset', async () => {
  await withPresetEnv('missing', async () => {
    const harness = await makeBridgeHarness({ agentPresets: true })
    try {
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await assert.rejects(Promise.resolve(harness.client.newSession({ cwd: CWD, mcpServers: [] })),
        /is unavailable/)
    } finally {
      await harness.dispose()
    }
  })

  await withPresetEnv('broken', async () => {
    const harness = await makeBridgeHarness({
      agentPresets: { presets: [{ id: 'broken', broken: 'missing dependency' }] },
    })
    try {
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await assert.rejects(Promise.resolve(harness.client.newSession({ cwd: CWD, mcpServers: [] })),
        /missing dependency/)
    } finally {
      await harness.dispose()
    }
  })
})

test('re-mounts the persisted preset when a session resumes', async () => {
  await withPresetEnv('review', async () => {
    const harness = await makeBridgeHarness({
      agentPresets: { presets: [{ id: 'standard' }, { id: 'review' }], default: 'standard' },
    })
    try {
      await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
      const sessionId = brandString<SessionId>(created.sessionId)
      assert.equal(harness.ctx.sessions.get(sessionId)?.header.agentPreset, 'review')
      await harness.client.closeSession({ sessionId })

      // Resume uses the durable header, not the current environment.
      process.env[AGENT_PRESET_ENV] = 'standard'
      const resumed = await harness.client.resumeSession({ sessionId, cwd: CWD, mcpServers: [] })
      assert.ok(Array.isArray(resumed.configOptions))
      assert.equal(harness.ctx.sessions.get(sessionId)?.header.agentPreset, 'review')
      assert.deepEqual(harness.agentPresets.mounted, ['review', 'review'])
    } finally {
      await harness.dispose()
    }
  })
})
