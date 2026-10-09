# Project starter

This directory is an invented portal project, not a builtin Paqvilo pack. Copy it into your own repository and rename `gitignore.template` to `.gitignore`. Point the `paqvilo` dependency at your installed distribution or local Paqvilo checkout, then install dependencies with `npm install --ignore-scripts`.

```sh
npm test
npx paqvilo mirage inspect --config ./paqvilo.config.yml --site example --json
npx paqvilo mirage dev --config ./paqvilo.config.yml --site example --preset example-demo
```

The catalogue's loopback reference is a placeholder. Replace it with your own authorized reference for Lense, and replace `portal/` with your exported sources. Add unpacked Solution roots for complete table/form metadata. Register your pack explicitly; do not install it inside Paqvilo. Commit synthetic acceptance criteria and generators here. Ignore `.paqvilo/`, `.env`, local catalogues, browser storage and business evidence.

`test/portal.test.mjs` imports public runtime/testing modules, explicitly registers this project's data pack and checks its own rendered page. `npm test` in the Paqvilo core never runs this project's test automatically.
