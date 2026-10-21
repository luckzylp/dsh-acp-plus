/**
 * Provider-profile extraction used to mirror the Web profile's model routes
 * into an ACP session. Pure helpers only: the importer is exercised against a
 * real profile in the manual ACP probe.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractProviderProfiles,
  normalizeSources,
  providerSourcePath,
} from '../src/provider-profiles.ts'

test('extracts llm-pi-ai providers from a profile patch list', () => {
  const document = [
    { id: 'hmr', disabled: false },
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          'web-gateway': { displayName: 'Web Gateway', models: [{ id: 'web-model' }] },
        },
      },
    },
  ]

  assert.deepEqual(extractProviderProfiles(document), {
    'web-gateway': { displayName: 'Web Gateway', models: [{ id: 'web-model' }] },
  })
})

test('extracts a settings.yaml llm-pi-ai section and a bare providers map', () => {
  const section = {
    'llm-pi-ai': {
      providers: { sensenova: { displayName: 'sensenova' } },
    },
  }
  assert.deepEqual(extractProviderProfiles(section), { sensenova: { displayName: 'sensenova' } })

  const bare = { providers: { atria: { displayName: 'atria' } } }
  assert.deepEqual(extractProviderProfiles(bare), { atria: { displayName: 'atria' } })
})

test('returns an empty map for documents without provider routes', () => {
  assert.deepEqual(extractProviderProfiles([]), {})
  assert.deepEqual(extractProviderProfiles({ id: 'llm-pi-ai', config: {} }), {})
  assert.deepEqual(extractProviderProfiles(undefined), {})
})

test('normalizes and resolves profile and file sources', () => {
  assert.deepEqual(normalizeSources(undefined), [])
  assert.deepEqual(normalizeSources('web'), ['web'])
  assert.deepEqual(normalizeSources(['web', 'desktop']), ['web', 'desktop'])
  assert.deepEqual(normalizeSources(['', 'web']), ['web'])

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home-provider-test'
  try {
    assert.equal(providerSourcePath('web'), '/tmp/dsh-home-provider-test/profiles/web/cordis.patch.yml')
    assert.equal(providerSourcePath('desktop'), '/tmp/dsh-home-provider-test/profiles/desktop/cordis.patch.yml')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(providerSourcePath('/abs/providers.yml'), '/abs/providers.yml')
})
