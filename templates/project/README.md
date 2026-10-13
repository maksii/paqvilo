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
2. Copy `.env.example` to `.env` if you need personal settings.
3. Run `npx paqvilo init --check` and resolve the marked catalogue, pack and fixture values.
4. Inspect each export: `npm run mirage -- inspect --site <site>`; then `npm run doctor -- --all`.
5. Run `npm run mirage:init` and `npm run mirage:dev` for local work. Use `npm run dev` for authorized live overlays.
6. Run `npm run validate` and `npx paqvilo init --check` before finishing.

See [workflows](docs/workflows.md) for the generated commands and [AGENTS.md](AGENTS.md) for boundaries. Toolkit documentation is available in `node_modules/paqvilo/docs/` and `node_modules/paqvilo/mirage/docs/` after installation.
