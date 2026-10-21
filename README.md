# dsh-acp-plus

An extended [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server
for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`),
packaged as an out-of-tree Cordis plugin and profile bundle.

It serves the standard ACP v1 surface and adds the capabilities the shipped
automation-only `@deepseek-ai/dsh-acp` bridge deliberately omits — transcript
replay, extra workspace roots (soft multi-root support), slash commands, plan
mode, form elicitation, and mid-turn steering — without changing the harness
core.

```sh
dsh --profile acp-plus
```

## Features

- **Standard ACP v1** — sessions (`new` / `list` / `resume` / `close`), prompts
  and cancellation, model and reasoning-effort config options, MCP servers
  (stdio and streamable HTTP), images, permissions, usage, and tool updates.
- **`session/load`** — reopen a persisted session, replay its transcript, and
  continue prompting across process restarts.
- **Additional directories** — declare extra workspace roots on a session;
  verified single-target writes inside them are pre-approved through the
  harness's existing sandbox escalation, while everything else still asks the
  client.
- **Multi-root workspace (soft support)** — until DSH grows a native
  multi-root policy, declared roots reach the model as one ordered
  system-prompt section with a root map, write boundaries, and optional
  `@alias/` routing (`@web/src/App.tsx` → `/repos/frontend/src/App.tsx`). The
  bridge expands the prefix in path-bearing tool arguments and reuses the same
  expansion for approval containment, so routing never widens the grant. See
  [Multi-root workspace](#multi-root-workspace-soft-support).
- **Agent presets** — select a DSH agent composition with
  `DSH_ACP_AGENT_PRESET`; the choice is recorded in the session and restored by
  `session/load` / `session/resume`.
- **Commands, modes, and permission presets** — publish the harness command
  list, execute `/name` without a model turn, and advertise `default` / `plan`
  modes. Plan mode and the mounted permission presets are also projected as
  ACP config options, because Zed 1.24.x ignores `modes` whenever config
  options are present.
- **Elicitation** — bridge `ask_user_question` to the standard ACP
  `elicitation/create` form when the client declares support.
- **Steering** — the `_session/steering` extension injects text into a live
  turn at its next step, and hands the text back when the turn already ended.
- **Default-model fallback** — with no provider/model in its own config, the
  bridge follows the composition's `agent-default-model` (the same default the
  dsh Web Models page writes).

## Multi-root workspace (soft support)

ACP models a multi-root workspace through the client-declared
`additionalDirectories` field. This bridge advertises and accepts that
capability, but **DSH does not yet provide a native multi-root workspace**: its
sandbox policy still has one `workspace-write` root (the session `cwd`). Until
upstream adds native multi-root support, this project supplies a **soft
support layer** instead of pretending the sandbox itself became multi-root:

1. **Protocol declaration** — the ACP client declares extra absolute roots on
   `session/new`, `session/load`, or `session/resume`; the bridge authorizes
   them with the same physical-identity rules as `cwd`.
2. **Sandbox authorization** — the standing sandbox mode is unchanged. Under
   `workspace-write`, a verified single-target `write` / `edit` under a
   declared root is pre-approved through the existing escalation; everything
   else still asks the client.
3. **Prompt routing** — one per-agent system-prompt section lists the roots,
   their write boundaries, and the `@alias/` convention, so the model can treat
   the roots as one logical workspace instead of only seeing the primary cwd.

This is deliberately **not** a native multi-root sandbox. In particular:

- Under `workspace-write`, declaring a root does not make it a persistent write
  allow-list; each `write` / `edit` remains a containment-checked, one-shot
  escalation.
- Under `workspace-write`, bash writes and paths outside every declared root
  still ask the client; a `read-only` session asks for every write.
- Root declarations are not persisted. `session/load` and `session/resume`
  must re-declare them and re-run authorization; a dropped root only narrows
  what is auto-approved.
- `@alias/` is a bridge convention, not an ACP standard. It is expanded only
  for the shipped file tools' top-level path arguments and `bash`'s `workdir`;
  bash command strings are not rewritten.
- This layer becomes unnecessary if DSH later exposes a native multi-root
  policy. The ACP capability and prompt section can then shrink to a thin
  description of the native behavior.

`additionalDirectoriesPrompt` controls the prompt half: `routing` (default)
lists roots and enables `@alias/`, `map` lists roots only and expects absolute
paths, and `off` injects nothing.

## Requirements

- Node.js >= 22
- DeepSeek Harness (`dsh`) with a model route configured. The plugin's
  `@deepseek-ai/dsh-*` peers are pinned to the running harness version
  (`^0.2.1-rc.1`).

## Install

From GitHub:

```sh
dsh plugin --profile acp-plus add github:AndPuQing/dsh-acp-plus
```

From a local checkout, choose **link** or **copy**.

Link — development mode; `node_modules/dsh-acp-plus` points at the checkout:

```sh
dsh plugin --profile acp-plus add .
```

Copy — an independent snapshot in the profile (recommended for a stable local
install):

```sh
dsh plugin --profile acp-plus remove dsh-acp-plus
dsh plugin --profile acp-plus add file:/absolute/path/to/dsh-acp-plus
```

`dsh plugin` forwards to pnpm in the profile directory. `add .` records a
`link:` dependency, while `file:` records a `file:` dependency; because the
profile uses `nodeLinker: hoisted`, pnpm installs the package contents as a
real directory rather than a symlink to the checkout. Check what is installed:

```sh
cat ~/.dsh/profiles/acp-plus/package.json
ls -ld ~/.dsh/profiles/acp-plus/node_modules/dsh-acp-plus
readlink -f ~/.dsh/profiles/acp-plus/node_modules/dsh-acp-plus
```

For a copy, `readlink -f` prints the profile path itself; for a link it prints
the checkout path.

The build output (`lib/`) is committed, so neither route runs a build script.
After changing source, run `npm run build` and commit `lib/` with the change.
For a **copy** install, refresh the profile snapshot after building:

```sh
dsh plugin --profile acp-plus remove dsh-acp-plus
dsh plugin --profile acp-plus add file:/absolute/path/to/dsh-acp-plus
```

For a fully self-contained artifact, pack a tarball and install that instead:

```sh
mkdir -p ~/.dsh/profiles/acp-plus/vendor
npm pack --pack-destination ~/.dsh/profiles/acp-plus/vendor
dsh plugin --profile acp-plus remove dsh-acp-plus
dsh plugin --profile acp-plus add file:./vendor/dsh-acp-plus-0.1.2.tgz
```

To replace the native bridge inside the shipped `acp` profile instead:

```sh
dsh --profile acp --patch ./overlay-on-native-acp.yml
```

## Usage

```sh
dsh --profile acp-plus
```

stdout carries only ACP JSON-RPC; diagnostics go to stderr. Connect any ACP
client to the process.

### Zed

Zed starts external agents through `agent_servers`. In a remote project the
agent runs on the remote Zed server, so the setting belongs in the remote
server settings (`zed: open server settings`, i.e. the remote
`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "dsh-acp-plus": {
      "type": "custom",
      "command": "/bin/sh",
      "args": ["-lc", "exec dsh --profile acp-plus"],
      "env": { "DSH_ACP_AGENT_PRESET": "standard" }
    }
  }
}
```

`sh -lc` picks up the login shell's PATH; an absolute `dsh` path works too.
`DSH_ACP_AGENT_PRESET` selects the Agent preset; omit it to keep the profile's
host composition. Reconnect the remote project and select `dsh-acp-plus` in the
agent picker.
The agent panel shows **Model**, **Reasoning effort**, **Mode**, and
**Permission** when the corresponding services are mounted. The bridge returns
them in the toolbar order **Permission → Mode → Reasoning effort → Model**.
`Mode` drives the same plan state as `session/set_mode`, and `Permission`
drives the same preset as the `/permission` command. Slash commands,
`session/load` replay, and `ask_user_question` (when the client declares form
elicitation) are available; client terminals are intentionally unsupported. Logs:
`~/.local/share/zed/logs/server-preview-*.log`.

Zed 1.24.x gives `configOptions` precedence over ACP `modes`: when an agent
returns both, the mode selector backed by `modes` is discarded. That is why the
bridge projects plan mode and permission presets into `configOptions` as well.

## Configuration

The profile patch configures the bridge row:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | string | `agent-default-model` | Provider route for new agents (e.g. `deepseek-official`). |
| `model` | string | `agent-default-model` | Exact model id (e.g. `deepseek-v4-flash`). |
| `sessionListPageSize` | integer >= 1 | `100` | Maximum sessions returned by one `session/list` page. |
| `enableSessionLoad` | boolean | `false` | Advertise and serve `session/load` transcript replay. |
| `enableAdditionalDirectories` | boolean | `false` | Accept `additionalDirectories` with containment-checked pre-approval. |
| `additionalDirectoriesPrompt` | `routing` / `map` / `off` | `routing` | `routing` lists roots and expands `@alias/` paths; `map` lists roots only (absolute paths); `off` injects nothing. |

The bridge also reads one environment variable:

| Variable | Default | Description |
| --- | --- | --- |
| `DSH_ACP_AGENT_PRESET` | unset | Agent preset for new ACP sessions; read once at startup and restored by `load` / `resume`. |

The shipped profile enables both `enableSessionLoad` and
`enableAdditionalDirectories`.

`additionalDirectoriesPrompt` only matters when roots are actually declared.
`routing` is not a write grant: it changes path spelling, and every `write` /
`edit` still goes through the containment-checked escalation described above.
Use `map` when you want the root map without any tool-layer path rewriting, or
`off` to leave the session's prompt and tools untouched.

Inspect the composed configuration and its schema:

```sh
dsh --profile acp-plus --dump-config
dsh --profile acp-plus --dump-config-schema
```

### Agent presets (`DSH_ACP_AGENT_PRESET`)

ACP has no standard agent-preset field, and Zed does not send one. The bridge
reads `DSH_ACP_AGENT_PRESET` once when the process starts and binds that preset
to every new ACP session. Pass it through Zed's `agent_servers.env`:

```json
{
  "agent_servers": {
    "dsh-acp-plus": {
      "type": "custom",
      "command": "/bin/sh",
      "args": ["-lc", "exec dsh --profile acp-plus"],
      "env": { "DSH_ACP_AGENT_PRESET": "standard" }
    }
  }
}
```

The same value works on the command line:

```sh
DSH_ACP_AGENT_PRESET=standard dsh --profile acp-plus
```

The shipped profile defines a `standard` preset whose `plugins` list is empty,
so it inherits the host composition. Add more
`@deepseek-ai/dsh-agent-preset` rows to the profile patch to define other
presets:

```yaml
- insert:
    - id: preset-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: review
        name: Review
        plugins:
          - name: '@deepseek-ai/dsh-tool-todo'
```

Preset choice is creation-time data: it is recorded in the session header, and
`session/load` / `session/resume` re-mount that persisted preset instead of
re-reading the environment. A live session cannot switch presets. With the
variable unset, ACP sessions keep the host composition and mount no preset.
The variable is read at startup, so restart the agent connection or start a new
chat after changing it.

### Models and credentials

`provider` / `model` are optional. When unset, the bridge follows
`agent-default-model` — the default model service the dsh Web Models page
writes — so a deployment configures its model once and every entry point
follows.

Provider routes are **composition state**, not session state. A dsh profile
starts from its own bundle set and its own `cordis.patch.yml`, so a route added
through the Web Models page belongs to the Web profile and is not inherited by
`acp-plus`. The bridge can only list routes registered in the running profile;
it does not invent providers.

Mount the same `llm-pi-ai` profiles in the ACP profile to make their models
selectable. Either add the block to
`$DSH_HOME/profiles/acp-plus/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      my-gateway:
        displayName: My Gateway
        apiKeyEnv: MY_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        models:
          - id: model-a
            name: Model A
            contextWindow: 262144
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: my-gateway
    model: model-a
```

or move the same rows to the home-level `$DSH_HOME/cordis.patch.yml` so every
profile shares one provider list. The home patch is applied last, so it
replaces, rather than merges with, a profile's `llm-pi-ai` config; include every
route you want there. A DSH patch also replaces the whole `config` object of
the row it targets: overriding the `acp-plus` row requires restating
`sessionListPageSize`, `enableSessionLoad`, and `enableAdditionalDirectories`.
Configuring only the model does not touch that row.

The ACP `model` option is a grouped select: one group per registered provider,
labelled with that provider's display name, and one option per model. Zed
renders those group names as separators in its model picker. The selected route
is validated with `resolveCallConfig` before it is published.

API keys are home-level and shared by every profile
(`$DSH_HOME/.credentials.yaml`, written by the Web Models page or supplied
through the launch environment). `llm-pi-ai` resolves each route's `apiKeyEnv`
while listing models; a missing or unusable credential makes that route return
an empty catalog, so its group is omitted from the picker even though the route
is registered. If a provider you configured is missing, check the credential
reference and that the process running the ACP agent can read
`$DSH_HOME/.credentials.yaml`.

## Relationship to the native bridge

The shipped `@deepseek-ai/dsh-acp` is automation-only by design. This project
keeps its protocol semantics and extends them:

| Capability | `@deepseek-ai/dsh-acp` | `dsh-acp-plus` |
| --- | --- | --- |
| Sessions, prompts, cancel, MCP, images, config options | yes | yes (parity) |
| `session/resume`, `session/list`, `session/close` | yes | yes |
| `session/load` transcript replay | no | yes |
| `additionalDirectories` | no | yes |
| Commands, modes, permission presets | no | yes |
| Agent preset selection | no | yes (`DSH_ACP_AGENT_PRESET`) |
| Form elicitation | no | yes |
| `_session/steering` | no | yes |

## Compatibility

- Standard ACP v1 plus the advertised session capabilities and the
  `_session/steering` extension; clients that do not know an extension ignore
  it.
- All `@deepseek-ai/dsh-*` peers are pinned to `^0.2.1-rc.1` and checked by
  dsh's plugin preflight. On a different harness version, grant the
  exact-version exemption the diagnostic describes
  (`dsh plugin allow-version <name>@<version>`).

## Development

```sh
npm run build          # esbuild -> lib/ (rebuild and commit after source changes)
npm run check          # tsc, project files only
npm test               # keyless: esbuild-bundled tests -> node --test
npm run release:check  # build + manifest, profile, and peer checks
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the repository layout, hard
constraints, and how the bridge tracks the native implementation.

## License

MIT. Portions are derived from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
Copyright (c) 2026 DeepSeek, used under the MIT License.
