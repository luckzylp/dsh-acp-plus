/**
 * User-invocable skills are advertised through the ACP command list so a client
 * can offer them in its `/` picker. Invocation itself stays a model prompt; the
 * skill consumer's `/name` gesture injects the instructions.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { availableCommands } from '../src/features/commands.ts'

/** Minimal agent shape read by the projection. */
const AGENT = { session: { header: { cwd: '/project' } } }

test('merges user-invocable skills after registered commands', async () => {
  const ctx = {
    get: (name: string) => name === 'commands'
      ? { list: () => [{ name: 'echo', description: 'Echo the input.', input: { hint: 'text' } }] }
      : name === 'skills'
        ? {
            list: async () => [
              { name: 'code-review', description: 'Review a change.', invocation: { userInvocable: true } },
              { name: 'internal-only', description: 'Hidden.', invocation: { userInvocable: false } },
              { name: 'echo', description: 'Duplicate.', invocation: { userInvocable: true } },
            ],
          }
        : undefined,
    logger: { warn: () => {} },
  } as unknown as Context

  assert.deepEqual(await availableCommands(ctx, AGENT as never), [
    { name: 'echo', description: 'Echo the input.', input: { hint: 'text' } },
    { name: 'code-review', description: 'Review a change.' },
  ])
})

test('publishes skills without a command registry and commands without skills', async () => {
  const skillOnly = {
    get: (name: string) => name === 'skills'
      ? { list: async () => [{ name: 'tdd', description: 'Test first.', invocation: { userInvocable: true } }] }
      : undefined,
    logger: { warn: () => {} },
  } as unknown as Context
  assert.deepEqual(await availableCommands(skillOnly, AGENT as never), [
    { name: 'tdd', description: 'Test first.' },
  ])

  const commandOnly = {
    get: (name: string) => name === 'commands'
      ? { list: () => [{ name: 'compact', description: 'Compact the session.' }] }
      : undefined,
    logger: { warn: () => {} },
  } as unknown as Context
  assert.deepEqual(await availableCommands(commandOnly, AGENT as never), [
    { name: 'compact', description: 'Compact the session.' },
  ])
})

test('keeps registered commands when skill discovery fails', async () => {
  const warnings: string[] = []
  const ctx = {
    get: (name: string) => name === 'commands'
      ? { list: () => [{ name: 'compact', description: 'Compact the session.' }] }
      : name === 'skills'
        ? { list: async () => { throw new Error('catalog offline') } }
        : undefined,
    logger: { warn: (message: string) => { warnings.push(message) } },
  } as unknown as Context

  assert.deepEqual(await availableCommands(ctx, AGENT as never), [
    { name: 'compact', description: 'Compact the session.' },
  ])
  assert.match(warnings[0] ?? '', /catalog offline/)
})
