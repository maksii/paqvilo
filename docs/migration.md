# Migration to Paqvilo

| Previous name/interface | Current name/interface |
| --- | --- |
| `ema-pp-local`, `pp-local` | `paqvilo` |
| `pp-local dev`, other overlay commands | `paqvilo lense dev`, `paqvilo lense <command>` |
| `pp-local companion dev` | `paqvilo mirage dev` |
| `src/` | `lense/` |
| `companion/` | `mirage/` |
| `PP_LOCAL_*` | `PAQVILO_*` |
| `pp-local.config.yml`, `.local.yml` | `paqvilo.config.yml`, `paqvilo.config.local.yml` |
| `.pp-local/` | `.paqvilo/` |
| `sites.<id>.companion`, `defaults.companion` | `sites.<id>.mirage`, `defaults.mirage` |

The public binary requires a product name. Update scripts to `paqvilo lense …` or `paqvilo mirage …`. Source-checkout equivalents are `node bin/paqvilo.mjs lense …` and `node bin/paqvilo.mjs mirage …`. Mirage direct tools remain available through `paqvilo mirage serve|inspect|data|presets` and the named inventory/parity/report tools.

Rename personal variables and catalogue keys; old names are not implicit aliases. Use an explicit `--config` for your project's catalogue. Your own project owns source roots, environment URLs and observed settings. The bundled catalogue is now a generic example.

Project data packs and business regression suites are external. Register each pack with `mirage.dataPacks` or project `dataPacks`; do not place it inside the installed toolkit. Import helpers through `paqvilo/mirage/*` and `paqvilo/lense/*` exports and run project tests separately. Stored preset descriptors require the corresponding registered pack when loading a state.

Local state has not been bulk-copied. Old browser storage, cookies, evidence and discovery files remain ignored. Agent discovery includes process identity and absolute paths and must not be blindly moved or edited. Start fresh sessions after updating configuration; sign in using the intended identity. Reuse a local simulation state with an explicit `--state` after registering its original project packs. Its business schema and record IDs do not change.

Existing Git history still contains removed project content. The reviewed current tree and npm package exclude it; publish a clean public repository rather than the private history if needed. Repository folder names and remote URLs are local/hosting choices and are not changed by the package rename.
