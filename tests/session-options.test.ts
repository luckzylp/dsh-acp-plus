/**
 * Session controls exposed as ACP config options.
 *
 * Zed 1.24.x ignores the `modes` response field whenever `configOptions` is
 * present, so plan mode and the permission-preset selector must also be
 * projected as config options. These tests lock both directions: the option
 * state and the `session/set_config_option` mutation.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROTOCOL_VERSION, type SessionConfigOption } from '@agentclientprotocol/sdk'
import { DEFAULT_MODE_ID, PLAN_MODE_ID } from '../src/features/modes.ts'
import { makeBridgeHarness, waitFor } from './harness.ts'

const CWD = process.cwd()

/** Find one select option by id and narrow its union shape. */
function selectOption(
  options: readonly SessionConfigOption[] | null | undefined,
  id: string,
): (SessionConfigOption & { type: 'select'; currentValue: string; options: unknown }) | undefined {
  const option = options?.find(candidate => candidate.id === id)
  return option?.type === 'select' ? option : undefined
}

/** Extract flat select values from an option state. */
function values(option: SessionConfigOption & { type: 'select'; options: unknown }): string[] {
  const options = option.options
  if (!Array.isArray(options)) return []
  return options.map(entry => {
    if (typeof entry !== 'object' || entry === null) return ''
    if ('value' in entry) return String((entry as { value: unknown }).value)
    const group = entry as { options?: Array<{ value: unknown }> }
    return group.options?.map(member => String(member.value)).join(',') ?? ''
  }).flatMap(value => value.split(',')).filter(Boolean)
}

test('projects plan mode as a config option for clients that ignore modes', async () => {
  const harness = await makeBridgeHarness({ planMode: true })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    assert.equal(created.modes?.currentModeId, DEFAULT_MODE_ID)
    const initial = selectOption(created.configOptions, 'mode')
    assert.ok(initial, 'the mode config option must be advertised')
    assert.equal(initial.category, 'mode')
    assert.equal(initial.currentValue, DEFAULT_MODE_ID)
    assert.deepEqual(values(initial), [DEFAULT_MODE_ID, PLAN_MODE_ID])

    const updated = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'mode',
      value: PLAN_MODE_ID,
    })
    assert.equal(selectOption(updated.configOptions, 'mode')?.currentValue, PLAN_MODE_ID)
    await waitFor(() => harness.updates.some(update =>
      update.sessionUpdate === 'config_option_update'
      && selectOption(update.configOptions, 'mode')?.currentValue === PLAN_MODE_ID))

    await assert.rejects(Promise.resolve(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'mode',
      value: 'turbo',
    })), /unknown session mode/)
  } finally {
    await harness.dispose()
  }
})

test('omits the mode config option when plan mode is not mounted', async () => {
  const harness = await makeBridgeHarness()
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    assert.equal(selectOption(created.configOptions, 'mode'), undefined)
    assert.equal(created.modes, undefined)
  } finally {
    await harness.dispose()
  }
})

test('projects the permission preset as a selectable config option', async () => {
  const harness = await makeBridgeHarness({ permissionPresets: true })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })

    const initial = selectOption(created.configOptions, 'permission')
    assert.ok(initial, 'the permission config option must be advertised')
    assert.equal(initial.category, '_permission')
    assert.equal(initial.currentValue, 'workspace-write')
    assert.deepEqual(values(initial), ['workspace-write', 'danger-full-access'])

    const updated = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'permission',
      value: 'danger-full-access',
    })
    assert.equal(selectOption(updated.configOptions, 'permission')?.currentValue, 'danger-full-access')
    assert.deepEqual(harness.permissionPresets.setCalls, ['danger-full-access'])

    await assert.rejects(Promise.resolve(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'permission',
      value: 'not-a-preset',
    })), /unknown permission preset/)
  } finally {
    await harness.dispose()
  }
})

test('shows the derived custom permission value without inventing a switch target', async () => {
  const harness = await makeBridgeHarness({
    permissionPresets: { current: 'custom', options: [{ value: 'workspace-write', name: 'Workspace write' }] },
  })
  try {
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: CWD, mcpServers: [] })
    const initial = selectOption(created.configOptions, 'permission')
    assert.ok(initial, 'the permission config option must be advertised')
    assert.equal(initial.currentValue, 'custom')
    assert.ok(values(initial).includes('custom'))

    const updated = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'permission',
      value: 'custom',
    })
    assert.equal(selectOption(updated.configOptions, 'permission')?.currentValue, 'custom')
    assert.deepEqual(harness.permissionPresets.setCalls, [])
  } finally {
    await harness.dispose()
  }
})
