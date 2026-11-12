/**
 * Standard model/reasoning config-option projection (PLAN.md M0–M1).
 *
 * Behavior ported from `packages/acp/acp/tests/model-control.spec.ts`: the
 * catalog is advisory, the exact route is validated before publication, and
 * the Agent owns the selection the control projects.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Model, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpPlusModelControl } from '../src/model-control.ts'

type Selection = { provider?: string; model?: string; reasoningEffort?: string }

/** Agent-owned selection double: only `select` mutates what `current` reads. */
function agentModel(initial?: ModelSelection): Model {
  let current = initial === undefined ? undefined : { ...initial }
  return {
    current: () => current,
    select: (selection: ModelSelection) => { current = { ...selection } },
  } as unknown as Model
}

/** Minimal LLM catalog/runtime double for pure standard-option tests. */
function llmRuntime(overrides: Partial<LlmRuntime> = {}): LlmRuntime {
  return {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: () => Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]),
    resolveCallConfig: (selection: Selection) => Promise.resolve({
      provider: selection.provider ?? 'mock',
      model: selection.model ?? 'mock',
      ...selection.reasoningEffort === undefined
        ? { reasoningEffort: ReasoningEffortId('high') }
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low', description: 'Less thought.' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }),
    ...overrides,
  } as unknown as LlmRuntime
}

test('represents an absent route and validates value types before mutation', async () => {
  const model = agentModel()
  const control = new AcpPlusModelControl(llmRuntime(), model)

  assert.equal(control.snapshot(), undefined)
  assert.deepEqual(await control.options(), [])
  await assert.rejects(control.set('model', false), /requires a select value/)
  await assert.rejects(control.set('model', 'missing'), /no model selection/)

  model.select({ provider: 'mock', model: 'mock' })
  assert.deepEqual(control.snapshot(), { provider: 'mock', model: 'mock' })
})

test('synthesizes an unlisted current route and exposes reasoning descriptions', async () => {
  const model = agentModel({ provider: 'private', model: 'unlisted' })
  const control = new AcpPlusModelControl(llmRuntime({ listProviders: () => [] }), model)

  const options = await control.options()
  const modelOption = options.find(option => option.id === 'model')
  const reasoning = options.find(option => option.id === 'reasoning_effort')
  assert.deepEqual(modelOption, {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["private","unlisted"]',
    options: [{ group: 'private', name: 'private', options: [{ value: '["private","unlisted"]', name: 'unlisted' }] }],
  })
  assert.deepEqual(reasoning, {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low', description: 'Less thought.' },
      { value: 'high', name: 'High' },
    ],
  })

  assert.deepEqual(control.snapshot(), { provider: 'private', model: 'unlisted' })
})

test('keeps the selected route when its provider catalog is temporarily unavailable', async () => {
  let listed = 0
  const control = new AcpPlusModelControl(llmRuntime({
    listModels: () => { listed += 1; return Promise.reject(new Error('catalog unavailable')) },
  }), agentModel({ provider: 'mock', model: 'mock' }))

  const options = await control.options()

  assert.equal(listed, 1)
  assert.deepEqual(options[0], {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["mock","mock"]',
    options: [{ group: 'mock', name: 'Mock', options: [{ value: '["mock","mock"]', name: 'mock' }] }],
  })
})

test('rejects an unadvertised reasoning effort and accepts a later valid change', async () => {
  const control = new AcpPlusModelControl(llmRuntime(), agentModel({ provider: 'mock', model: 'mock' }))

  await assert.rejects(control.set('reasoning_effort', 'extreme'), /unknown reasoning effort/)
  const options = await control.set('reasoning_effort', 'low')

  assert.equal(options.find(option => option.id === 'reasoning_effort')?.currentValue, 'low')
})

test('exposes and restores a provider-owned reasoning default', async () => {
  const runtime = llmRuntime({
    resolveCallConfig: (selection: Selection) => Promise.resolve({
      provider: selection.provider ?? 'mock',
      model: selection.model ?? 'mock',
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
      },
    }),
  })
  const model = agentModel({ provider: 'mock', model: 'mock' })
  const control = new AcpPlusModelControl(runtime, model)

  const initial = await control.options()
  assert.deepEqual(initial.find(option => option.id === 'reasoning_effort'), {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: '',
    options: [
      { value: '', name: 'Provider default' },
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  })
  await control.set('reasoning_effort', 'low')
  const restored = await control.set('reasoning_effort', '')

  assert.equal(restored.find(option => option.id === 'reasoning_effort')?.currentValue, '')
  assert.deepEqual(model.current(), { provider: 'mock', model: 'mock' })
})

test('groups the model option by provider and switches across groups', async () => {
  const runtime = llmRuntime({
    listProviders: () => [
      { id: 'alpha', name: 'Alpha Gateway' },
      { id: 'beta', name: 'Beta' },
    ],
    listModels: (provider: string) => Promise.resolve(provider === 'alpha'
      ? [
          { provider: 'alpha', id: 'a1', name: 'A One' },
          { provider: 'alpha', id: 'a2', name: 'A Two' },
        ]
      : [{ provider: 'beta', id: 'b1', name: 'B One' }]),
    resolveCallConfig: (selection: Selection) => Promise.resolve({
      provider: selection.provider ?? 'alpha',
      model: selection.model ?? 'a1',
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
    }),
  })
  const control = new AcpPlusModelControl(runtime, agentModel({ provider: 'alpha', model: 'a1' }))

  const [modelOption] = await control.options()
  assert.deepEqual(modelOption, {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: '["alpha","a1"]',
    options: [
      {
        group: 'alpha',
        name: 'Alpha Gateway',
        options: [
          { value: '["alpha","a1"]', name: 'A One' },
          { value: '["alpha","a2"]', name: 'A Two' },
        ],
      },
      {
        group: 'beta',
        name: 'Beta',
        options: [{ value: '["beta","b1"]', name: 'B One' }],
      },
    ],
  })

  const updated = await control.set('model', '["beta","b1"]')
  assert.equal(updated.find(option => option.id === 'model')?.currentValue, '["beta","b1"]')
  assert.deepEqual(control.snapshot(), { provider: 'beta', model: 'b1' })
})
