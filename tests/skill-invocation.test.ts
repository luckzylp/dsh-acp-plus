/**
 * Skills over ACP: advertise user-invocable skills in the `/` list, and let the
 * existing `/name` gesture inject the instructions as an ordinary model turn.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { makeBridgeHarness, textResponse, waitFor } from './harness.ts'

test('advertises a user-invocable skill and injects it on /name', async () => {
  const harness = await makeBridgeHarness({ skills: true, filesystemTools: true, sandboxMode: 'workspace-write', script: [textResponse('done')] })
  try {
    harness.ctx.skills.register({
      name: 'demo-skill',
      description: 'Demo skill for the ACP command list.',
      content: 'DEMO SKILL INSTRUCTIONS',
      source: 'runtime',
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await waitFor(() => harness.updates.some(update =>
      update.sessionUpdate === 'available_commands_update'
      && update.availableCommands.some(command => command.name === 'demo-skill')))

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: '/demo-skill' }],
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(harness.adapter.requests.length, 1)
    const request = JSON.stringify(harness.adapter.requests[0]?.messages)
    assert.match(request, /DEMO SKILL INSTRUCTIONS/)
    assert.match(request, /skill_content/)
  } finally {
    await harness.dispose()
  }
})
