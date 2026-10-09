# Project starter

A small portal with invented sources, a registered data pack and an acceptance test. Use it to learn the project structure before connecting your own site.

## Copy and run

1. [Install Paqvilo](../../docs/getting-started.md#1-install) in an empty working folder.
2. Open `node_modules/paqvilo/examples/project/` in your editor or file explorer.
3. Copy `portal/`, `pack/`, `test/` and `paqvilo.config.yml` into your working folder.
4. Copy `gitignore.template` as `.gitignore`. Keep your existing `package.json`; the starter's manifest points at a toolkit checkout.

From your working folder's terminal:

```sh
npm pkg set "scripts.test=node --test test/*.test.mjs"
npm test
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site example --preset example-demo
```

The test checks anonymous and signed-in rendering with this project's data pack. **Alt+Shift+P** opens the browser panel; **Tweaks** selects a local persona and **Inspect** shows page dependencies. Close the browser or press **Ctrl+C** to stop the runtime started here.

## Adapt it to your site

Replace `portal/` with your export and add unpacked Solution roots for table and form metadata. Replace the catalogue's loopback environment URL before using Lense against your online site.

Keep your data pack, personas and acceptance tests in this project. Register the pack explicitly in the catalogue. Ignore `.paqvilo/`, `.env`, local configuration and browser storage.

[Project extensions](../../docs/project-extensions.md) | [Data-pack contract](../../mirage/docs/data-packs.md)
