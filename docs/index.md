# Documentation

Paqvilo provides local-first, pro-code tools for Microsoft Power Pages. Start with [getting started](getting-started.md) for Node.js and npm setup, a working local example and your own exported site.

| Task | Guide |
| --- | --- |
| Install and open your first portal | [Getting started](getting-started.md) |
| Generate an empty consumer project and refresh editor paths | [Project scaffold](project-scaffold.md) |
| Configure a project in the local setup workspace | [Project setup](setup.md) |
| Explore the populated sample and its sources | [Demo guide](demo.md) |
| Compare supported workflows and their limits | [Coverage](coverage.md) |
| Answer common setup and workflow questions | [FAQ](faq.md) |
| Compare with Fiddler and DevTools overrides | [Workflow comparison](../README.md#beyond-fiddler-and-devtools-overrides) |
| Preview local changes on a live portal | [Lense](lense.md) |
| Render exported pages locally | [Mirage](../mirage/README.md) |
| Set sources, environments and browser choices | [Configuration](configuration.md) |
| Add personas, datasets and acceptance tests | [Project starter](../examples/project/README.md), [extensions](project-extensions.md) |
| Integrate tests or other tools | [Public API](public-api.md) |
| Provision project-owned Dataverse schema and data | [Dataverse tooling](dataverse-provisioning.md) |
| Upgrade or test a branch build | [Release notes](release-notes.md), [preview packages](branch-packages.md) |
| Use the browser agent API | [Lense automation](lense.md#automation-and-evidence) |
| Compare Mirage with a live portal on native components | [Native component baseline](baseline.md) |
| Understand support and project boundaries | [Architecture](architecture.md) |
| Contribute to the toolkit | [Contributing](../CONTRIBUTING.md) |
| Maintain releases, security checks and hosting | [Repository maintenance](repository-admin.md) |

## Runtime reference

The [Mirage reference](../mirage/docs/README.md) covers source imports, Liquid, FetchXML, Web API, forms, lists, permissions and parity evidence.

## Example reference designs

The separate [Company Operations regression project](../examples/company-operations/README.md) demonstrates deep permission paths, synthetic datasets and plugin observations. Its [data model](design/company-operations-demo.md), [permission harness](design/power-pages-permission-test-harness.md) and [plugin laboratory](design/dataverse-plugin-observation.md) are project specifications. Follow their installation and qualification prerequisites before using them against an authorized environment.

## Command notation

Run commands from your portal project. `npx --no-install paqvilo` uses its installed toolkit. References shorten this to `paqvilo`; keep the local prefix in your terminal. From a toolkit checkout, use `node bin/paqvilo.mjs`.
