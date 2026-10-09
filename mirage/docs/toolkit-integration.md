# Lense integration

`paqvilo mirage init` builds a runtime project from the selected catalogue's portal export, dependency-ordered Solution roots, reference environments and explicit data packs. No reference is fetched during bootstrap. `dev` launches each selected local runtime and opens it in Lense's dedicated browser; `start`, `status` and `stop` manage only owned runtime sessions.

With `portals: all`, each site has a separate port, state and session cookie. `--site` selects the first open portal. Use `--portals selected` for a single runtime, especially with an explicit `--project` or `--portal`. Port/state/preset/Solution overrides apply to the selected site; other sites keep catalogue settings.

The panel's **Inspect** tab shows the current page's template chain, access rules, forms, views, tables, columns, snippets and settings. Permission explanations use this browser's session. Source items open their portal or Solution files in the configured editor. **Tweaks** signs this browser in or out, selects local enforcement/scenarios/presets and links to `_sim`. Identity is never taken from a global saved persona.

Mirage owns source watch/reload for local rendering. Inspect bootstrap/runtime diagnostics when a source is missing, a Solution cannot resolve a relationship, a pack does not match, or a managed dependency needs enrichment. Lifecycle files and logs stay under `.paqvilo/mirage`; browser and runtime discoveries are private. An attached browser is detached on shutdown, not closed.
