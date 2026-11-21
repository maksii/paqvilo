# Documentation

Commands in these guides are written as `paqvilo …`. In a project, run them as `npx --no-install paqvilo …` (the
installed copy); in a toolkit checkout, as `node bin/paqvilo.mjs …`.

| Task                                                                      | Guide                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Install, try the demo and connect your own export                         | [Getting started](getting-started.md)                                                          |
| Explore the populated demo and its VS Code workflow                       | [Demo](demo.md)                                                                                |
| Generate an empty consumer project, check readiness, refresh editor files | [Project scaffold](project-scaffold.md)                                                        |
| Configure a project in the browser (`paqvilo setup`)                      | [Setup workspace](setup.md)                                                                    |
| Set sources, environments, browsers and several sites                     | [Configuration](configuration.md)                                                              |
| Command help, quoting, paths, JSON output and exit codes                  | [CLI](cli.md)                                                                                  |
| Fix a failed install, demo or first run                                   | [Troubleshooting](getting-started.md#troubleshooting), [FAQ](faq.md)                           |
| Preview local changes on a live portal                                    | [Lense](lense.md)                                                                              |
| Render exported pages locally; every Mirage runtime contract              | [Mirage](../mirage/README.md), [Mirage reference](../mirage/docs/README.md)                    |
| Choose a workflow and check what is supported                             | [Coverage](coverage.md), [FAQ](faq.md)                                                         |
| Understand components, data flows and the project boundary                | [Architecture](architecture.md)                                                                |
| Add personas, data packs, handlers and project tests                      | [Project extensions](project-extensions.md), [demo project](../examples/project/README.md)     |
| Use the toolkit from tests or scripts                                     | [Public API](public-api.md)                                                                    |
| Review sources offline (`analyze`, Doctor advice)                         | [Static analysis](static-analysis.md)                                                          |
| Inspect or overlay model-driven app sources                               | [Model-driven actions](model-driven-actions.md)                                                |
| Provision project-owned Dataverse schema and data                         | [Dataverse provisioning](dataverse-provisioning.md)                                            |
| Compare Mirage with a live portal on native components                    | [Native component baseline](baseline.md)                                                       |
| Upgrade, or test a branch build                                           | [Release notes](release-notes.md), [preview packages](branch-packages.md)                      |
| Contribute to the toolkit                                                 | [Contributing](../CONTRIBUTING.md), [test kinds](test-kinds.md), [code review](code-review.md) |
| Maintain releases, dependencies, security checks and hosting              | [Repository maintenance](repository-admin.md), [dependency upgrades](dependency-upgrades.md)   |
| Projects that informed toolkit features                                   | [Kudos](kudos.md)                                                                              |

The separate [Company Operations project](../examples/company-operations/README.md) is a synthetic regression project
for deep permission paths and plug-in observations; its specifications are the
[data model](design/company-operations-demo.md), [permission harness](design/power-pages-permission-test-harness.md) and
[plug-in laboratory](design/dataverse-plugin-observation.md).
