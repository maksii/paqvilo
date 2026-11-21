# Paqvilo: Power Pages and Dataverse local development

[![CI](https://github.com/maksii/paqvilo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/maksii/paqvilo/actions/workflows/ci.yml)
[![Security](https://github.com/maksii/paqvilo/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/maksii/paqvilo/actions/workflows/security.yml)
[![npm version](https://img.shields.io/npm/v/paqvilo)](https://www.npmjs.com/package/paqvilo)
[![Node.js](https://img.shields.io/node/v/paqvilo)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/paqvilo)](https://github.com/maksii/paqvilo/blob/main/LICENSE)
[![Pages](https://github.com/maksii/paqvilo/actions/workflows/pages.yml/badge.svg?branch=main)](https://paqvilo.dev/)

[Website](https://paqvilo.dev/) · [Guide](https://paqvilo.dev/guide.html) ·
[Documentation](https://github.com/maksii/paqvilo/blob/main/docs/index.md) ·
[Discussions](https://github.com/maksii/paqvilo/discussions)

Paqvilo is an open-source toolkit for developing Microsoft Power Pages, Dataverse and other Power Platform
customizations on your own machine. It reads the portal and Solution sources you already export with the Power Platform
CLI and gives you two ways to see a change without deploying it:

- **Mirage, a local simulator.** Run your exported Power Pages site locally, with local Liquid rendering, simulated
  Dataverse data, web roles, table permissions and test personas. It also runs a local Dataverse Web API, plug-in steps,
  cloud flows, model-driven and canvas apps, and PCF components. It works on local state by default; live reads, live
  writes and trusted project code are explicit opt-ins.
- **Lense, a live preview.** Opens your deployed portal in a dedicated browser and serves your local JavaScript, CSS,
  images and literal markup edits in place of the deployed ones. Saved stylesheets usually swap in place; other changes
  reload the affected tabs.

![Paqvilo architecture: project-owned exports feed Lense browser overlays on a live portal or Mirage local rendering
with simulated data.](https://raw.githubusercontent.com/maksii/paqvilo/main/docs/assets/overview.svg)

## What you can do locally

| You want to                                            | With Paqvilo                                                                                                                                                                                                                        | Guide                                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run a Power Pages site without a portal                | Mirage renders Liquid templates, snippets, basic and multistep forms, lists and languages from your export, with local sign-in, web roles and table permissions                                                                     | [Mirage](https://github.com/maksii/paqvilo/blob/main/mirage/README.md)                                                                                                   |
| Preview a JavaScript or CSS change on the real portal  | Lense overlays local files on the live site, shows what applied and what still needs deployment, and shows the source that owns a selected element (or the candidates when the export cannot identify it)                           | [Lense](https://github.com/maksii/paqvilo/blob/main/docs/lense.md)                                                                                                       |
| Test code against a Dataverse Web API                  | An opt-in local organization: OData CRUD, `$metadata`, `$batch`, FetchXML, security roles and OAuth app registrations, checked against Microsoft's ServiceClient and MSAL (they need the documented TLS and port settings)          | [Dataverse API](https://github.com/maksii/paqvilo/blob/main/mirage/docs/dataverse-api.md)                                                                                |
| Debug a Dataverse plug-in without the Plug-in Profiler | Solution plug-in steps run in a local pipeline as mocks or JavaScript models; on Windows, with the Dataverse SDK assemblies installed, the original .NET Framework assembly runs and the VS Code debugger attaches                  | [Plug-ins](https://github.com/maksii/paqvilo/blob/main/mirage/docs/dataverse-plugins.md)                                                                                 |
| Work on a model-driven app                             | Exported apps open locally with sitemaps, views, grids and main forms; once you enable `modelDriven.trustedExtensions`, form scripts and ribbon commands run against a bounded `Xrm` / `formContext` API                            | [Model-driven apps](https://github.com/maksii/paqvilo/blob/main/mirage/docs/model-driven-apps.md)                                                                        |
| Test a PCF code component with real bindings           | Standard field components are hosted on local portal pages, portal form fields and model-driven forms, bound to local records                                                                                                       | [Code components](https://github.com/maksii/paqvilo/blob/main/mirage/docs/code-components.md)                                                                            |
| Run a Power Automate cloud flow                        | A local interpreter executes exported flows (Power Pages, HTTP, recurrence and Dataverse row triggers; control actions, variables, expressions); Dataverse actions run on local data, other connectors use local providers or mocks | [Operations](https://github.com/maksii/paqvilo/blob/main/mirage/docs/operations.md)                                                                                      |
| Run canvas apps and Power Apps code apps               | A local player evaluates canvas Power Fx on local data; a bridge with a Vite plug-in answers a code app's context and Dataverse calls                                                                                               | [Canvas apps](https://github.com/maksii/paqvilo/blob/main/mirage/docs/canvas-apps.md), [code apps](https://github.com/maksii/paqvilo/blob/main/mirage/docs/code-apps.md) |
| Automate checks in CI or with an AI coding agent       | Node testing helpers, `--json` output from the inspection, audit and status commands, offline static analysis (`paqvilo analyze`) and a bounded browser API for agents                                                              | [Public API](https://github.com/maksii/paqvilo/blob/main/docs/public-api.md), [CLI](https://github.com/maksii/paqvilo/blob/main/docs/cli.md)                             |

The [coverage guide](https://github.com/maksii/paqvilo/blob/main/docs/coverage.md) compares Lense and Mirage area by
area, and the [step-by-step guide](https://paqvilo.dev/guide.html) shows each workflow with recordings.

## Try it

Install [Node.js](https://nodejs.org/en/download) 26.13.1 or later in the 26.x line and have Edge installed (with Chrome
only, add `--browser chrome` to the last command). Then, in an empty folder:

```sh
npm init -y
npm install --save-dev paqvilo
npx --no-install paqvilo mirage demo
```

The demo needs no Power Pages account. It copies an editable sample portal into `paqvilo-example/`, loads invented
records and opens a development browser on a free local port: native forms and lists, a Power Pages Web API workspace,
PCF field components, plug-in steps and a cloud flow. Edit a portal source under `paqvilo-example/` and the page
follows. Press **Alt+Shift+P** for Inspect and persona controls; close the browser or press **Ctrl+C** to stop. The
[demo walkthrough](https://github.com/maksii/paqvilo/blob/main/docs/demo.md) covers what to try and the VS Code
(`--scaffold`) workflow.

## Use your own site

```sh
npx paqvilo@^0.9.8 init ./my-portals   # empty project; installs nothing
cd my-portals
npm run setup        # install the toolkit and check the browser
npm run configure    # point the project at your export in the local /_setup/ workspace
npm run mirage:dev   # Mirage: render locally
npm run dev          # Lense: overlay on the configured live environment
```

[Getting started](https://github.com/maksii/paqvilo/blob/main/docs/getting-started.md) explains where your export goes
and the first run of each workflow. `npx --no-install paqvilo --help` lists the command groups; append `--help` to any
command for its options.

## Scope

- **A simulation, not an emulator.** Mirage implements selected Power Pages and Dataverse contracts and reports what it
  does not support. A passing local scenario is not platform parity: validate important scenarios in a real environment
  before release.
- **No cloud connectors.** Flows, canvas apps and code apps never call a real cloud connector locally. Dataverse actions
  run on local data; other connectors need a local provider, a project handler or a mock.
- **Some features are opt-in or platform-bound.** The Dataverse API endpoint needs configuration, model-driven scripts,
  ribbon commands and PCF need `modelDriven.trustedExtensions`, original .NET plug-in assemblies run on Windows only
  with the Dataverse SDK assemblies installed, and React (virtual) PCF controls are not hosted on portal pages.
- **Lense works on a live portal.** Liquid and Dataverse still run online, and browser actions change live data.
- **No deployment.** Paqvilo does not download, upload or deploy a site; that stays with the
  [Power Platform CLI](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages). The separate
  [`paqvilo dataverse`](https://github.com/maksii/paqvilo/blob/main/docs/dataverse-provisioning.md) commands provision
  project-owned schema and data in an environment you administer.

Paqvilo supports standard and enhanced portal exports and imports `.powerpages-site` code-site exports (without SPA
build tooling). It runs on Windows and Linux.

## Documentation

- [Documentation index](https://github.com/maksii/paqvilo/blob/main/docs/index.md) and
  [FAQ](https://github.com/maksii/paqvilo/blob/main/docs/faq.md)
- [Mirage reference](https://github.com/maksii/paqvilo/blob/main/mirage/docs/README.md): every simulated area and its
  limits
- [Configuration](https://github.com/maksii/paqvilo/blob/main/docs/configuration.md) and
  [project extensions](https://github.com/maksii/paqvilo/blob/main/docs/project-extensions.md)
- [CONTRIBUTING](https://github.com/maksii/paqvilo/blob/main/CONTRIBUTING.md) and
  [Discussions](https://github.com/maksii/paqvilo/discussions); report vulnerabilities as the
  [security policy](https://github.com/maksii/paqvilo/blob/main/SECURITY.md) describes

> **Microsoft notice:** Paqvilo is independent and is not affiliated with, sponsored or endorsed by Microsoft.
> Microsoft, Dataverse, Power Pages, Power Platform and other Microsoft names referenced here are trademarks of the
> Microsoft group of companies ([guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks)).
> Other trademarks belong to their respective owners.

## License

Paqvilo (PAC, Virtual and Local) is licensed under [GNU AGPLv3](https://github.com/maksii/paqvilo/blob/main/LICENSE),
with third-party notices in [NOTICE](https://github.com/maksii/paqvilo/blob/main/NOTICE). Your independent portal
sources keep their own licensing.

**Why AGPLv3?** To keep shared improvements open. Paqvilo is for local development and testing, not for replacing Power
Pages or Dataverse or bypassing Microsoft licensing; users must comply with applicable Microsoft terms.

**Will it stay free?** Yes. Paqvilo will remain free of charge for the community; its current baseline functionality and
core features will not move behind a paywall.

**Commercial, company or customer use?** Yes, free of charge, including internal development and paid customer services.
Microsoft licensing costs remain separate.

**Must I publish my portal or business data?** No, developing or testing independent portals with Paqvilo does not
require this. Incorporating Paqvilo code can bring software under AGPLv3.

**When do conditions apply?** Mainly when you:

- **Distribute Paqvilo:** preserve its license, notices and recipients' rights; provide corresponding source as
  required. Modified versions must identify changes and remain under AGPLv3.
- **Modify Paqvilo and let others use its interface or API remotely** (colleagues or customers over LAN, VPN or
  internet): prominently offer free access to the running version's complete corresponding source, including changes and
  required build/install/run scripts, for example through a **Source** download link. Waiting for requests is
  insufficient ([section 13](https://www.gnu.org/licenses/agpl-3.0.html#section13)). Solely personal local use does not
  trigger this requirement.
- **Distribute a combined program incorporating Paqvilo code:** the covered work must use AGPLv3; independent tools used
  alongside it keep their licenses.

Summary only; [LICENSE](LICENSE) governs. See the [GNU license FAQ](https://www.gnu.org/licenses/gpl-faq.en.html).
