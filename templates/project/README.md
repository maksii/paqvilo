# {{name}}

This project owns portal sources, catalogue settings, data packs and acceptance tests. Paqvilo provides Lense for live source overlays and Mirage for local rendering with simulated data. Complete the marked values before using a real portal.

| Path | Owns | Committed? |
| --- | --- | --- |
| `paqvilo.config.yml` | Shared sites, environments and source paths | Yes |
| `.env.example` | Personal settings template | Yes |
| `.env`, `paqvilo.config.local.yml` | Personal choices and overrides | No |
| `sources/` or an external checkout | Portal exports and unpacked Solutions | Project decision |
| `support/`, `pack/` or `packs/` | Bound runtime, project data and rules | Yes |
| `test-browser/` | Local fixtures and project acceptance tests | Yes |
| `tools/test-browser.mjs` | Browser-test file discovery and runner | Yes |
| `.vscode/` | Tasks and browser debugger launches, when enabled | Yes |
| `*.code-workspace` | Resolved paths for this checkout | No |
| `.paqvilo/` | State, logs, browser profiles and evidence | No |

## Next steps

1. Run `npm run setup`. This installs dependencies, checks browser readiness and refreshes editor paths when enabled.
2. Run `npm run configure` to connect exports and environments in the local setup workspace. Select the personal layer for ignored overrides; `.env` is optional.
3. Run `npx paqvilo init --check` and resolve the marked catalogue, pack and fixture values.
4. Inspect each export: `npm run mirage -- inspect --site <site>`; then `npm run doctor -- --all`.
5. Run `npm run mirage:init` and `npm run mirage:dev` for local work. Use `npm run dev` for authorized live overlays.
6. Run `npm run validate` and `npx paqvilo init --check` before finishing.

See [workflows](docs/workflows.md) for this project's commands, [AGENTS.md](AGENTS.md) for agent instructions, and the maintained [setup]({{docs}}docs/getting-started.md), [configuration]({{docs}}docs/configuration.md), [Lense]({{docs}}docs/lense.md) and [Mirage]({{docs}}mirage/README.md) guides. The installed CLI and bundled documentation describe the installed version when online docs differ.
