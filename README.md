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

Use the separate [`paqvilo dataverse` workflow](docs/dataverse-provisioning.md) to register a provisioning application, prepare/reconcile project-owned schema manifests, create metadata through the API, and export/unpack solutions from Dataverse. Lense and Mirage do not provision or deploy.

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

Generate an empty project with `npx paqvilo@^0.9.5 init ./my-portals --name my-portals`, then run `npm run setup` inside it and fill in the values listed by `npx paqvilo init --check`. The [project scaffold guide](docs/project-scaffold.md) covers multiple sites/packs, offline tests and editor refresh.

Start with an existing Power Pages export. [Getting started](https://github.com/maksii/paqvilo/blob/main/docs/getting-started.md#2-scaffold-your-project) explains where to place it, how to create your configuration, and how to open the integrated browser.

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

> **Microsoft notice:** Paqvilo is independent and is not affiliated with, sponsored or endorsed by Microsoft. Microsoft, Dataverse, Power Pages, Power Platform and other Microsoft names referenced here are trademarks of the Microsoft group of companies ([guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks)). Other trademarks belong to their respective owners.

## About and license

Paqvilo combines PAC, Virtual and Local. Its original code uses [GNU AGPLv3](https://github.com/maksii/paqvilo/blob/main/LICENSE), with third-party notices in [NOTICE](https://github.com/maksii/paqvilo/blob/main/NOTICE). Your independent portal sources retain their own licensing.

### License FAQ

**Why AGPLv3?** To keep shared improvements open. Paqvilo is for local development and testing, not replacing Power Pages or Dataverse or bypassing Microsoft licensing. Users must comply with applicable Microsoft terms. AGPLv3 permits self-hosting, subject to the conditions below.

**Will it stay free?** Yes. Paqvilo will remain free of charge for the community; its current baseline functionality and core features will not move behind a paywall.

**Commercial, company or customer use?** Yes, free of charge, including internal development and paid customer services. Microsoft licensing costs remain separate.

**Must I publish my portal or business data?** No, merely developing or testing independent portals with Paqvilo does not require this. Incorporating Paqvilo code can bring software under AGPLv3.

**When do conditions apply?** Mainly when you:

- **Distribute Paqvilo:** preserve its license, notices and recipients' rights; provide corresponding source as required. Modified versions must identify changes and remain under AGPLv3.
- **Modify Paqvilo and let others use its interface or API remotely:** this includes colleagues or customers over LAN, VPN or internet. Prominently offer free access to the running version's complete corresponding source, including changes and required build/install/run scripts, e.g. through a **Source** download link. Waiting for requests is insufficient ([section 13](https://www.gnu.org/licenses/agpl-3.0.html#section13)). Solely personal local use does not trigger this requirement.
- **Distribute a combined program incorporating Paqvilo code:** the covered work must use AGPLv3; independent tools used alongside it retain their licenses.

Summary only; [LICENSE](LICENSE) governs. See the [GNU license FAQ](https://www.gnu.org/licenses/gpl-faq.en.html).
