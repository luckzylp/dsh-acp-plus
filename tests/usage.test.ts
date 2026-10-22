/**
 * Context-window usage over ACP. A turn can end without a provider usage
 * sample (and compaction changes occupancy outside an assistant message), so
 * the bridge must republish the meter reading after the turn and after a
 * command instead of relying only on assistant/message usage.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { makeBridgeHarness, waitFor } from './harness.ts'

/** A completed assistant response that carries no provider usage chunk. */
const NO_USAGE_RESPONSE: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('publishes a context reading after a turn without provider usage', async () => {
  const harness = await makeBridgeHarness({ script: [NO_USAGE_RESPONSE] })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    const result = await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'finish without usage' }],
    })
    assert.equal(result.stopReason, 'end_turn')

    await waitFor(() => harness.updates.some(update => update.sessionUpdate === 'usage_update'))
    const usage = harness.updates.find(update => update.sessionUpdate === 'usage_update')
    assert.equal(usage?.sessionUpdate, 'usage_update')
    assert.equal((usage as { size?: number }).size, 1_024)
  } finally {
    await harness.dispose()
  }
})
