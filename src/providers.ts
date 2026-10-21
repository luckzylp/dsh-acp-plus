/**
 * Activate `llm-pi-ai` routes from another dsh profile's provider settings.
 *
 * Provider routes are composition state: a profile only sees the `llm-pi-ai`
 * profiles in its own patch. The desktop app's Models page writes those
 * profiles into the desktop profile's `cordis.patch.yml`, so an ACP profile
 * starting from a different composition would otherwise show only its own
 * routes. This row reads the named profiles' `llm-pi-ai` blocks at startup and
 * applies their providers to the mounted adapter, without copying secrets or
 * touching the ACP profile's on-disk configuration.
 *
 * @module dsh-acp-plus/providers
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { parse } from 'yaml'
import {
  extractProviderProfiles,
  isRecord,
  normalizeSources,
  providerSourcePath,
  type ProviderProfiles,
} from './provider-profiles.ts'

/** Stable Cordis plugin name. */
export const name = 'acp-plus-providers'

/** The adapter whose dormant routes this row activates. */
export const inject = ['llm']

/** Readiness service consumed by the ACP bridge before serving a session. */
export const ACP_PLUS_PROVIDERS_SERVICE = 'acpPlusProviders'

/** Readiness state published even while the provider import is still running. */
export interface AcpPlusProvidersState {
  ready: Promise<void>
}

/** Deployment configuration for provider import. */
export interface AcpPlusProvidersConfig {
  /**
   * Profile names (resolved under `$DSH_HOME/profiles/<name>/cordis.patch.yml`)
   * or explicit YAML/JSON files to read `llm-pi-ai` providers from.
   */
  from?: string | string[]
  /** Inline provider profiles; keys here override imported keys. */
  providers?: ProviderProfiles
}

/** Schemastery schema validating the fields above. */
export const Config: Schema<AcpPlusProvidersConfig> = Schema.object({
  from: Schema.union([Schema.string(), Schema.array(Schema.string())])
    .description('Profiles or YAML/JSON files to read llm-pi-ai provider routes from.'),
  providers: Schema.dict(Schema.any())
    .description('Inline llm-pi-ai provider profiles; keys override imported routes.'),
})

interface LoaderEntry {
  id: string
  options: { name?: string; config?: unknown }
  update(options: { config: unknown }, create?: boolean, force?: boolean): Promise<void>
}

interface LoaderLike {
  entries(): Iterable<LoaderEntry>
}

/** Start the import and publish its readiness before any session is served. */
export function apply(ctx: Context, config: AcpPlusProvidersConfig): void {
  const ready = importProviders(ctx, config)
  ctx.provide(ACP_PLUS_PROVIDERS_SERVICE, { ready } satisfies AcpPlusProvidersState)
}

/** Read configured provider routes and activate them on the mounted adapter. */
async function importProviders(ctx: Context, config: AcpPlusProvidersConfig): Promise<void> {
  const explicit = isRecord(config.providers) ? config.providers : {}
  const imported: ProviderProfiles = {}
  for (const source of normalizeSources(config.from)) {
    const file = providerSourcePath(source)
    try {
      const document: unknown = parse(readFileSync(file, 'utf8'))
      const providers = extractProviderProfiles(document)
      if (Object.keys(providers).length === 0) {
        ctx.logger.warn(`acp-plus-providers: no llm-pi-ai providers in ${file}`)
        continue
      }
      Object.assign(imported, providers)
    } catch (error: unknown) {
      ctx.logger.warn(`acp-plus-providers: cannot read ${file}: ${String(error)}`)
    }
  }
  const providers: ProviderProfiles = { ...imported, ...explicit }
  if (Object.keys(providers).length === 0) return

  const loader = (ctx as Context & { loader?: LoaderLike }).loader
  const entry = loader === undefined
    ? undefined
    : [...loader.entries()].find(item => item.id === 'llm-pi-ai' || item.options.name === '@deepseek-ai/dsh-llm-pi-ai')
  if (entry === undefined) {
    ctx.logger.warn('acp-plus-providers: llm-pi-ai is not mounted; imported provider routes were ignored')
    return
  }
  const current = isRecord(entry.options.config) ? entry.options.config : {}
  const existing = isRecord(current.providers) ? current.providers : {}
  // Volatile provider config is committed into the running adapter; no write
  // reaches the ACP profile, and a later start reruns this import.
  await entry.update({ config: { ...current, providers: { ...existing, ...providers } } })
}
