/**
 * Pure helpers for reading `llm-pi-ai` provider profiles from dsh
 * configuration documents.
 *
 * @module dsh-acp-plus/provider-profiles
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Provider route profiles keyed by provider id. */
export type ProviderProfiles = Record<string, unknown>

/** Normalize the public `from` field into an ordered source list. */
export function normalizeSources(from: string | string[] | undefined): string[] {
  if (from === undefined) return []
  return (Array.isArray(from) ? from : [from]).filter(source => source.length > 0)
}

/**
 * Resolve a profile name (under `$DSH_HOME/profiles/<name>/cordis.patch.yml`)
 * or an explicit YAML/JSON file path.
 */
export function providerSourcePath(source: string): string {
  if (isAbsolute(source)) return source
  if (source.includes('/') || /\.(?:ya?ml|json)$/i.test(source)) return resolve(source)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', source, 'cordis.patch.yml')
}

/**
 * Extract `llm-pi-ai` providers from a profile patch list, a `settings.yaml`
 * section, or a document that already carries a `providers` map.
 */
export function extractProviderProfiles(document: unknown): ProviderProfiles {
  if (Array.isArray(document)) {
    for (const row of document) {
      if (!isRecord(row) || row.id !== 'llm-pi-ai' && row.name !== '@deepseek-ai/dsh-llm-pi-ai') continue
      const config = isRecord(row.config) ? row.config : undefined
      if (config !== undefined && isRecord(config.providers)) return config.providers
    }
    return {}
  }
  if (!isRecord(document)) return {}
  const section = document['llm-pi-ai']
  if (isRecord(section)) {
    const config = isRecord(section.config) ? section.config : section
    if (isRecord(config.providers)) return config.providers
  }
  return isRecord(document.providers) ? document.providers : {}
}

/** Whether a value is a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
