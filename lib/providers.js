// src/providers.ts
import { readFileSync } from "node:fs";
import Schema from "@deepseek-ai/schemastery";
import { parse } from "yaml";

// src/provider-profiles.ts
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
function normalizeSources(from) {
  if (from === void 0) return [];
  return (Array.isArray(from) ? from : [from]).filter((source) => source.length > 0);
}
function providerSourcePath(source) {
  if (isAbsolute(source)) return source;
  if (source.includes("/") || /\.(?:ya?ml|json)$/i.test(source)) return resolve(source);
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "profiles", source, "cordis.patch.yml");
}
function extractProviderProfiles(document) {
  if (Array.isArray(document)) {
    for (const row of document) {
      if (!isRecord(row) || row.id !== "llm-pi-ai" && row.name !== "@deepseek-ai/dsh-llm-pi-ai") continue;
      const config = isRecord(row.config) ? row.config : void 0;
      if (config !== void 0 && isRecord(config.providers)) return config.providers;
    }
    return {};
  }
  if (!isRecord(document)) return {};
  const section = document["llm-pi-ai"];
  if (isRecord(section)) {
    const config = isRecord(section.config) ? section.config : section;
    if (isRecord(config.providers)) return config.providers;
  }
  return isRecord(document.providers) ? document.providers : {};
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractDefaultSelection(document) {
  if (Array.isArray(document)) {
    for (const row of document) {
      if (!isRecord(row)) continue;
      if (row.id !== "agent-default-model" && row.name !== "@deepseek-ai/dsh-agent-default-model") continue;
      return defaultSelectionFrom(isRecord(row.config) ? row.config : void 0);
    }
    return void 0;
  }
  if (!isRecord(document)) return void 0;
  const section = document["agent-default-model"];
  if (!isRecord(section)) return void 0;
  return defaultSelectionFrom(isRecord(section.config) ? section.config : section);
}
function defaultSelectionFrom(config) {
  if (config === void 0) return void 0;
  const { provider, model, reasoningEffort } = config;
  if (typeof provider !== "string" || provider.length === 0) return void 0;
  if (typeof model !== "string" || model.length === 0) return void 0;
  return {
    provider,
    model,
    ...typeof reasoningEffort !== "string" || reasoningEffort.length === 0 ? {} : { reasoningEffort }
  };
}

// src/providers.ts
var name = "acp-plus-providers";
var inject = ["llm"];
var ACP_PLUS_PROVIDERS_SERVICE = "acpPlusProviders";
var Config = Schema.object({
  from: Schema.union([Schema.string(), Schema.array(Schema.string())]).description("Profiles or YAML/JSON files to read llm-pi-ai provider routes from."),
  providers: Schema.dict(Schema.any()).description("Inline llm-pi-ai provider profiles; keys override imported routes.")
});
function apply(ctx, config) {
  const state = { ready: Promise.resolve() };
  ctx.provide(ACP_PLUS_PROVIDERS_SERVICE, state);
  state.ready = importProviders(ctx, config, state);
}
async function importProviders(ctx, config, state) {
  const explicit = isRecord(config.providers) ? config.providers : {};
  const imported = {};
  let defaultSelection;
  for (const source of normalizeSources(config.from)) {
    const file = providerSourcePath(source);
    try {
      const document = parse(readFileSync(file, "utf8"));
      const selection = extractDefaultSelection(document);
      if (selection !== void 0) defaultSelection = selection;
      const providers2 = extractProviderProfiles(document);
      if (Object.keys(providers2).length === 0) {
        ctx.logger.warn(`acp-plus-providers: no llm-pi-ai providers in ${file}`);
        continue;
      }
      Object.assign(imported, providers2);
    } catch (error) {
      ctx.logger.warn(`acp-plus-providers: cannot read ${file}: ${String(error)}`);
    }
  }
  state.defaultSelection = defaultSelection;
  const providers = { ...imported, ...explicit };
  if (Object.keys(providers).length === 0) return;
  const loader = ctx.loader;
  const entry = loader === void 0 ? void 0 : [...loader.entries()].find((item) => item.id === "llm-pi-ai" || item.options.name === "@deepseek-ai/dsh-llm-pi-ai");
  if (entry === void 0) {
    ctx.logger.warn("acp-plus-providers: llm-pi-ai is not mounted; imported provider routes were ignored");
    return;
  }
  const current = isRecord(entry.options.config) ? entry.options.config : {};
  const existing = isRecord(current.providers) ? current.providers : {};
  await entry.update({ config: { ...current, providers: { ...existing, ...providers } } });
}
export {
  ACP_PLUS_PROVIDERS_SERVICE,
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=providers.js.map
