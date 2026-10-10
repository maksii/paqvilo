# Paqvilo

[![CI](https://github.com/maksii/paqvilo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/maksii/paqvilo/actions/workflows/ci.yml)
[![Security](https://github.com/maksii/paqvilo/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/maksii/paqvilo/actions/workflows/security.yml)
[![npm version](https://img.shields.io/npm/v/paqvilo)](https://www.npmjs.com/package/paqvilo)
[![Node.js](https://img.shields.io/node/v/paqvilo)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/paqvilo)](https://github.com/maksii/paqvilo/blob/main/LICENSE)
[![Pages](https://github.com/maksii/paqvilo/actions/workflows/pages.yml/badge.svg?branch=main)](https://maksii.github.io/paqvilo/)

[Website](https://maksii.github.io/paqvilo/) · [Discussions](https://github.com/maksii/paqvilo/discussions)

### Power Pages development. Unbound.

**A local-first, pro-code development toolkit for Microsoft Power Pages.** Preview local changes on live sites with **Lense**. Run exported pages on your machine with **Mirage**, using Liquid and simulated Dataverse.

![Paqvilo architecture: project-owned exports feed Lense browser overlays on a live portal or Mirage local rendering with simulated data.](https://raw.githubusercontent.com/maksii/paqvilo/main/docs/assets/overview.svg)

[Getting started](https://github.com/maksii/paqvilo/blob/main/docs/getting-started.md) | [Documentation](https://github.com/maksii/paqvilo/blob/main/docs/index.md) | [Coverage](https://github.com/maksii/paqvilo/blob/main/docs/coverage.md) | [FAQ](https://github.com/maksii/paqvilo/blob/main/docs/faq.md) | [npm package](https://www.npmjs.com/package/paqvilo)

## Choose your workflow

| | Lense | Mirage |
| --- | --- | --- |
| Use it to | Preview JavaScript, CSS, images and supported literal HTML edits without uploading each change | Develop independently with local rendering, identities and test data |
| How it works | Overlays local sources in a dedicated browser; Liquid and Dataverse stay online | Renders exported sources locally; simulates Dataverse, forms, lists and permissions |
| Inspect and compare | **Inspect** traces page sources, components and exported access rules; **Online / Local** compares responses | **Inspect** for page dependencies, **Tweaks** for identity and scenarios, `/_sim/` for administration |
| Learn more | <a href="https://github.com/maksii/paqvilo/blob/main/docs/lense.md"><img src="https://raw.githubusercontent.com/maksii/paqvilo/main/docs/assets/lense-icon.png" width="96" alt="Read the Lense guide"></a> | <a href="https://github.com/maksii/paqvilo/blob/main/mirage/README.md"><img src="https://raw.githubusercontent.com/maksii/paqvilo/main/docs/assets/mirage-icon.png" width="96" alt="Read the Mirage guide"></a> |

Mirage also gives automated tests and coding agents a local runtime with controlled data. Keep your scenarios and acceptance tests in your own project.

## Beyond Fiddler and DevTools overrides

Paqvilo is a Power Pages-specific alternative for developers who need source mapping, live reload and local portal simulation alongside resource overrides.

| Existing workflow | What it provides | What Paqvilo adds |
| --- | --- | --- |
| [Fiddler Classic AutoResponder](https://www.telerik.com/fiddler/fiddler-classic/documentation/knowledge-base/autoresponder) / [Fiddler Everywhere rules](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/rules-presets/modify-traffic/modify-reponse-body) | Request matching, local file responses and response modification | Power Pages export mapping, Git baseline comparisons and refresh on source saves |
| [Chrome DevTools Local Overrides](https://developer.chrome.com/docs/devtools/overrides) / [Edge Overrides](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/javascript/overrides) | Replace browser resources with local copies | Portal record and field identity, supported inline edits and integrated Online / Local comparison |
| [Power Platform CLI and VS Code](https://learn.microsoft.com/en-us/power-pages/configure/developer-overview) | Source editing and portal download/upload | A local Liquid and Dataverse simulation for independent development and repeatable tests |

Use Lense for live portal previews and Mirage for isolated local environments. DevTools and Fiddler remain useful for general browser and HTTP debugging.

## Try a local portal

No Power Pages account or portal export is needed for this example.

**1. Install [Node.js](https://nodejs.org/en/download), version 22 or later.** It includes npm, which downloads the toolkit. Open a terminal in VS Code using **Terminal > New Terminal**, or use Command Prompt.

**2. Create a working folder and install Paqvilo.** Enter these commands one line at a time:

```sh
mkdir paqvilo-demo
cd paqvilo-demo
npm init -y
npm install --save-dev paqvilo
```

**3. Open the demo.** `npx` runs the installed toolkit:

```sh
npx --no-install paqvilo mirage demo
```

The command copies an editable portal into `paqvilo-example/`, loads sample records and opens a dedicated development browser on a free local port. Keep the terminal open. Close the browser or press **Ctrl+C** to stop.

Sign in as **Alex Example 01** and open **Web API > Arcwell Services**. Compare native forms, a custom Web API workspace and 14 PCF editors using the same accounts, contacts, notes and attachments. Press **Alt+Shift+P** for Inspect and persona controls.

The [demo walkthrough](https://github.com/maksii/paqvilo/blob/main/docs/demo.md) covers CRUD, lookups, permissions, Liquid components, plugin rules, server logic and flow simulation. It also explains the PAC exports, editable Solution/PCF/C# sources and deployment archives.

Prefer VS Code? Add `--scaffold`, open the generated workspace and use **F5**. The [prepared editor workflow](https://github.com/maksii/paqvilo/blob/main/docs/demo.md#prefer-vs-code-tasks) includes tasks, browser debugging and Inspect source links.

## Use your own site

Start with an existing Power Pages export. [Getting started](https://github.com/maksii/paqvilo/blob/main/docs/getting-started.md#2-connect-your-site) explains where to place it, how to create your configuration, and how to open the integrated browser.

```sh
# Local rendering with Inspect and Tweaks:
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal

# Local source previews against your online development environment:
npx --no-install paqvilo lense dev --config ./paqvilo.config.yml --site portal --env dev
```

Run one development command at a time. **Alt+Shift+P** opens the panel. Add `.paqvilo/` and personal configuration to your project's ignore file.

## Scope

Paqvilo supports standard and enhanced portal exports and imports `.powerpages-site` code-site exports. Its local Liquid simulation is intended for traditional portal development; code-site import does not provide SPA build tooling.

Lense interactions use the live portal's backend and can change live data. Mirage supports selected platform contracts; the [coverage guide](https://github.com/maksii/paqvilo/blob/main/docs/coverage.md) identifies capabilities and limits. Verify important scenarios against Power Pages before release. Exporting, uploading and deploying remain part of your existing [Power Platform CLI workflow](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages). Paqvilo is an independent project with no Microsoft affiliation.

## Documentation

| Task | Guide |
| --- | --- |
| Set up your first project | [Getting started](https://github.com/maksii/paqvilo/blob/main/docs/getting-started.md) |
| Explore the demo and deploy its sources | [Demo walkthrough](https://github.com/maksii/paqvilo/blob/main/docs/demo.md) |
| Configure sources, browsers and several sites | [Configuration](https://github.com/maksii/paqvilo/blob/main/docs/configuration.md) |
| Add personas, datasets and acceptance tests | [Project starter](https://github.com/maksii/paqvilo/blob/main/examples/project/README.md), [extensions](https://github.com/maksii/paqvilo/blob/main/docs/project-extensions.md) |
| Understand runtime support and evidence | [Mirage reference](https://github.com/maksii/paqvilo/blob/main/mirage/docs/README.md), [architecture](https://github.com/maksii/paqvilo/blob/main/docs/architecture.md) |
| Check support and common questions | [Coverage](https://github.com/maksii/paqvilo/blob/main/docs/coverage.md), [FAQ](https://github.com/maksii/paqvilo/blob/main/docs/faq.md) |
| Contribute | [Contributing](https://github.com/maksii/paqvilo/blob/main/CONTRIBUTING.md) |

## About and license

Paqvilo combines PAC, Virtual and Local. Its original code uses [GNU AGPLv3](https://github.com/maksii/paqvilo/blob/main/LICENSE), with third-party notices in [NOTICE](https://github.com/maksii/paqvilo/blob/main/NOTICE). Your independent portal sources retain their own licensing.
