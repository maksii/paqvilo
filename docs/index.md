# Documentation

Paqvilo provides local-first, pro-code tools for Microsoft Power Pages. Start with [getting started](getting-started.md) for Node.js and npm setup, a working local example and your own exported site.

| Task | Guide |
| --- | --- |
| Install and open your first portal | [Getting started](getting-started.md) |
| Explore the populated sample and its sources | [Demo guide](demo.md) |
| Compare supported workflows and their limits | [Coverage](coverage.md) |
| Answer common setup and workflow questions | [FAQ](faq.md) |
| Compare with Fiddler and DevTools overrides | [Workflow comparison](../README.md#beyond-fiddler-and-devtools-overrides) |
| Preview local changes on a live portal | [Lense](lense.md) |
| Render exported pages locally | [Mirage](../mirage/README.md) |
| Set sources, environments and browser choices | [Configuration](configuration.md) |
| Add personas, datasets and acceptance tests | [Project starter](../examples/project/README.md), [extensions](project-extensions.md) |
| Use the browser agent API | [Lense automation](lense.md#automation-and-evidence) |
| Understand support and project boundaries | [Architecture](architecture.md) |
| Contribute to the toolkit | [Contributing](../CONTRIBUTING.md) |

## Runtime reference

The [Mirage reference](../mirage/docs/README.md) covers source imports, Liquid, FetchXML, Web API, forms, lists, permissions and parity evidence.

## Command notation

Run commands from your portal project. `npx --no-install paqvilo` uses its installed toolkit. References shorten this to `paqvilo`; keep the local prefix in your terminal. From a toolkit checkout, use `node bin/paqvilo.mjs`.
