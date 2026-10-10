# Configuration

Your catalogue connects the toolkit to your sources and environments. Keep it in your portal project so the same configuration works with an installed package or a separate toolkit checkout. If this is your first setup, follow [getting started](getting-started.md).

Pass `--config /path/to/your-project/paqvilo.config.yml`. Without it the toolkit uses the working directory's `paqvilo.config.yml` when present, otherwise its bundled example catalogue. The bundled example URL is an inert placeholder and must be replaced before connecting to a live portal.

CLI choices override shell `PAQVILO_*` variables, then `.env` next to the selected catalogue, then `paqvilo.config.local.yml`, then the shared catalogue. The local catalogue and `.env` must be ignored in your project. Use `paqvilo lense list --settings` for supported settings and their resolved origins. Unknown settings fail rather than silently changing behavior.

```yaml
sourceRoot: ./sources
defaultSite: customer
portals: selected
sites:
  customer:
    source: customer-portal
    defaultEnv: sandbox
    environments:
      sandbox: https://your-portal.example.test
      production: { url: https://production.example.test, caution: true }
    mirage:
      port: 8787
      solutionRoots: [../solutions/Core, ../solutions/Extension]
      dataPacks:
        - { id: customer-demo, module: ./pack/pack.mjs }
      preset: customer-demo
```

`sourceRoot` resolves from the catalogue directory. `source` and `solutionRoots` resolve from that root. `--repo` overrides `sourceRoot` and resolves from the invoking working directory. `mirage.project` and data-pack modules resolve from the catalogue directory. A generated Mirage project records its own relative inputs. Explicit `--source` selects an exported portal directly.

Live Lense **Inspect** also reads `mirage.solutionRoots` or the matching portal's sources in `mirage.project`. No local runtime or data-pack code is started for inspection. Without Solution sources, portal dependencies remain inspectable and missing form/view/field definitions are reported explicitly.

Use `portals: all` to support every configured target in one browser. Origins activate on visit, and `--site` selects the first portal. Each Mirage site has its own port and state; choose distinct ports or `0` for a free one. `--portals selected` limits lifecycle operations to one site. `--port`, `--state`, `--preset` and repeated `--solution-root` overrides apply to the selected site.

Mirage projects use `version: 2`, `primaryPortal`, `portals`, `solutions`, `references` and `dataPacks`. Each portal specifies `{ id, path, origin?, solutions?, reference?, deploymentProfile?, observed?, dataModel? }`; Solutions specify `{ id, path }`; references specify `{ id, origin, default? }`. Paths are project-relative and every portal gets isolated state. References provide explicit selection context and never authorize network reads or writes. Solution sets are layered in dependency order; `solutionOrder: explicit` preserves a deliberately ordered list.

An `observed` mapping records only behavior not available from exports. Supported fields include login-path, Web API and response-header conventions; validation requires an evidence reference. Use your site's own captured evidence. Never copy another organisation's observations merely because both sites use Power Pages.

`PAQVILO_REPO`, `PAQVILO_SITE`, `PAQVILO_ENV`, `PAQVILO_BROWSER`, `PAQVILO_PROFILE`, `PAQVILO_SCOPE` and `PAQVILO_BASELINE` cover common personal choices. A named browser profile is a separate toolkit identity. Existing profiles require explicit user-data root and child directory; attached CDP browsers remain user-owned. Toolkit-managed state is under `.paqvilo/`, with `--state`, `--output` and profile settings for explicit locations.

The default catalogue is the working directory's `paqvilo.config.yml` when present. State, runtime discovery, logs and generated Mirage project files live in `.paqvilo/` beside that catalogue. A standalone `--project` uses its own directory. `mirage status` and `mirage stop` use the same project scope; supply `--config` or `--project` when running from another directory. The installed toolkit contains reusable code only. Direct Mirage commands also support `--state-dir` to select the state/discovery directory explicitly.
