/**
 * Skills over ACP: external skills are advertised as `/skills:<name>` so they
 * are distinguishable from agent commands. The prefixed form keeps the
 * original user text and injects the same `<skill_content>` context as the
 * bare `/name` gesture.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, waitFor } from './harness.ts'

/** Build a harness with one user-invocable runtime skill. */
async function skillHarness(): Promise<Awaited<ReturnType<typeof makeBridgeHarness>>> {
  const harness = await makeBridgeHarness({
    skills: true,
    filesystemTools: true,
    sandboxMode: 'workspace-write',
    script: [textResponse('done')],
  })
  harness.ctx.skills.register({
    name: 'demo-skill',
    description: 'Demo skill for the ACP command list.',
    content: 'DEMO SKILL INSTRUCTIONS',
    source: 'runtime',
  })
  return harness
}

test('advertises a skill as /skills:<name> and injects it for the prefixed form', async () => {
  const harness = await skillHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await waitFor(() => harness.updates.some(update =>
      update.sessionUpdate === 'available_commands_update'
      && update.availableCommands.some(command => command.name === 'skills:demo-skill')))

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/skills:demo-skill' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.adapter.requests.length, 1)
    const request = JSON.stringify(harness.adapter.requests[0]?.messages)
    assert.match(request, /\/skills:demo-skill/)
    assert.match(request, /DEMO SKILL INSTRUCTIONS/)
    assert.match(request, /skill_content/)
  } finally {
    await harness.dispose()
  }
})

test('keeps the bare /name fallback working without advertising it', async () => {
  const harness = await skillHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/demo-skill' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.adapter.requests.length, 1)
    const request = JSON.stringify(harness.adapter.requests[0]?.messages)
    assert.match(request, /DEMO SKILL INSTRUCTIONS/)
    assert.doesNotMatch(request, /\/skills:demo-skill/)
  } finally {
    await harness.dispose()
  }
})
