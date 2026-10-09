#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { importPortal } from "./lib/importer.mjs";
import { assertPortalSource } from "./lib/source-dialect.mjs";
import { createSimulator } from "./server.mjs";
import { builtinPresets, presetDescriptor } from "./lib/presets.mjs";
import { resolveSolutionRoots } from "./lib/solution-roots.mjs";
import { shareSolutionParses } from "./lib/solution-cache.mjs";
import { bootstrapProject, loadProjectConfig, projectOrigin, projectStateFile, projectSummary } from "./lib/project-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: "string" },
      repo: { type: "string" },
      // The toolkit catalogue file (lense/config.mjs), as the toolkit's own --config.
      config: { type: "string" },
      site: { type: "string" },
      // Without --env the catalogue site's defaultEnv applies (lense/config.mjs).
      env: { type: "string" },
      port: { type: "string", default: "8787" },
      state: { type: "string" },
      "state-dir": { type: "string" },
      origin: { type: "string" },
      cdp: { type: "string" },
      preset: { type: "string" },
      path: { type: "string", default: "/" },
      "managed-control-path": { type: "string" },
      stylesheet: { type: "string", multiple: true },
      "parent-snippet": { type: "string" },
      "child-snippet": { type: "string" },
      output: { type: "string" },
      local: { type: "string" },
      "solution-root": { type: "string", multiple: true },
      "solution-order": { type: "string" },
      project: { type: "string" },
      portal: { type: "string" },
      "deployment-profile": { type: "string" },
      pack: { type: "string" },
      "pack-module": { type: "string", multiple: true },
      profile: { type: "string" },
      seed: { type: "string" },
      rows: { type: "string" },
      out: { type: "string" },
      count: { type: "string", multiple: true },
      help: { type: "boolean" },
      json: { type: "boolean" },
      "no-watch": { type: "boolean" },
      // Live create, update and delete requests are impossible without this runtime flag.
      "allow-live-writes": { type: "boolean" },
      // standard or enhanced: the data model of a YAML source (a .powerpages-site export
      // defaults to enhanced); a project portal and a catalogue site set dataModel instead.
      "data-model": { type: "string" },
    },
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { values: args, positionals } = parsed;
const stateDir = path.resolve(args['state-dir'] ?? path.join(
  args.config ? path.dirname(path.resolve(args.config)) : args.project ? path.dirname(path.resolve(args.project)) : process.cwd(), '.paqvilo'));
const command = positionals[0] ?? "serve";
if (args.help || command === "help") {
  console.log(`Power Pages local mirage

  node mirage/cli.mjs serve [--site SITE --env ENV] [--repo PATH]
  node mirage/cli.mjs serve --source PATH --port 8787
  node mirage/cli.mjs inspect --project mirage.project.yml --json
  node mirage/cli.mjs serve --project mirage.project.yml --port 8787
  node mirage/cli.mjs serve --project mirage.project.yml --portal PORTAL_ID
  node mirage/cli.mjs inspect --source PATH --json
  node mirage/cli.mjs render --source PATH --path /PAGE/ --output .paqvilo/page.html
  node mirage/cli.mjs capture-shell --site SITE --env ENV --cdp http://127.0.0.1:PORT --path /PAGE/
    [--managed-control-path /known-native-editor-route]
  node mirage/cli.mjs capture-stylesheets --site SITE --env ENV --cdp http://127.0.0.1:PORT --stylesheet /styles/theme.css
  node mirage/cli.mjs capture-snippet-composition --site SITE --env ENV --cdp http://127.0.0.1:PORT --path /PAGE/ --parent-snippet NAME --child-snippet NAME
  node mirage/cli.mjs verify --local http://127.0.0.1:8787 --origin https://PORTAL --cdp http://127.0.0.1:PORT --path /PAGE/
  node mirage/cli.mjs data generate --pack PACK_ID --profile PROFILE --state FILE [--out FILE] [--seed S]
  node mirage/cli.mjs data scaffold --profile smoke|dev --state FILE [--rows N] [--seed S] [--out FILE]
    portal: [--site SITE --env ENV --repo PATH] | --project FILE [--portal ID] | --source PORTAL_DIR [--solution-root DIR ...]
    [--count NAME=N ...] [--pack-module PATH]

Options: --state FILE, --preset NAME, --no-watch, --cdp URL, --solution-root PATH (repeatable), --solution-order derived|explicit, --project FILE, --portal ID, --deployment-profile NAME, --config FILE (toolkit catalogue for --site), --repo DIR, --allow-live-writes (permits live create, update and delete requests; the /__sim/ live writes switch still decides, off by default), --data-model standard|enhanced (the data model of a YAML source; a .powerpages-site export defaults to enhanced)
Solution roots (--solution-root, else the catalogue site's mirage solutionRoots, else unpacked solution repositories discovered next to the portal repository) are a set layered definition-before-extension; --solution-order explicit (or solutionOrder: explicit in the catalogue site or project file) keeps the listed order.
Admin: /__sim/. New workspaces use local data/page modes; saved modes persist.
Default state and evidence paths are under .paqvilo. Deployment profiles require --deployment-profile.
Presets (registry; a portal lists only packs that match it): ${Object.entries(
    Object.keys(builtinPresets).reduce((groups, id) => {
      const pack = presetDescriptor(builtinPresets, id)?.pack ?? "generic";
      (groups[pack] ??= []).push(id);
      return groups;
    }, {}),
  )
    .map(([pack, ids]) => `${pack}: ${ids.join(", ")}`)
    .join("; ")}
Live access uses the selected connected browser identity. Exact parity requires passing evidence.`);
  process.exit(0);
}
try {
  if (command === "data") {
    const { runDataCommand } = await import("./lib/data-generation.mjs");
    // data scaffold resolves its portal like serve: a project file and portal,
    // an explicit --source (solution roots discovered unless --solution-root),
    // or the toolkit catalogue site/environment (--site/--env/--repo).
    const resolved = positionals[1] === "scaffold" ? await resolveDataSource(args) : {};
    console.log(JSON.stringify(await runDataCommand(positionals.slice(1), { ...args, ...resolved }), null, 2));
  } else if (command === "verify") {
    const { verifyParity } = await import("./verify.mjs");
    const result = await verifyParity({
      localUrl: args.local,
      origin: args.origin,
      cdpUrl: args.cdp,
      path: args.path,
      outputDir:
        args.output ??
        path.join(stateDir, "simulator", args.site ?? "default", "evidence/latest"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } else {
    const project = args.project ? await loadProjectConfig(args.project) : null;
    if (project && args.source)
      throw new Error("Use either --project or --source, not both.");
    if (project && args["solution-root"]?.length)
      throw new Error("--solution-root is supplied by the project configuration.");
    if (project && args["solution-order"])
      throw new Error("--solution-order is supplied by the project configuration (solutionOrder).");
    if (project && args["data-model"])
      throw new Error("--data-model is supplied by the project configuration (the portal's dataModel).");
    if (args["data-model"] != null && !["standard", "enhanced"].includes(args["data-model"]))
      throw new Error("--data-model must be standard or enhanced.");
    if (project && args.portal && !project.portals.some((p) => p.id === args.portal))
      throw new Error(`Portal '${args.portal}' is not configured in ${project.configFile}`);
    if (project && command === "inspect") {
      const selected = args.portal
        ? project.portals.filter((p) => p.id === args.portal)
        : project.portals;
      const bootstrapped = await bootstrapProject({ ...project, portals: selected });
      // A source with zero recognised pages is not a portal: fail loudly, naming its layout.
      for (const { portal } of bootstrapped.portals) assertPortalSource(portal);
      console.log(JSON.stringify({
        configFile: project.configFile,
        version: project.version,
        defaultPortal: project.defaultPortal,
        lcid: project.lcid,
        solutionOrder: project.solutionOrder,
        portals: bootstrapped.portals.map(({ id, sourceDir, origin, reference, solutions, portal, metadata, solutionData }) => ({
          id, sourceDir: portal.sourceDir ?? sourceDir, origin: projectOrigin(project, { origin, reference }), solutions, format: portal.format,
          layout: portal.source?.dialect ?? null, dataModel: portal.dataModel, dataModelSource: portal.dataModelSource,
          serverLogics: (portal.serverLogics ?? []).map((item) => item.name),
          cloudFlows: (portal.cloudFlows ?? []).map((item) => item.name),
          solutionData: solutionData.stats,
          pages: portal.pages.map((page) => ({ id: page.id, name: page.name, url: page.url, pageTemplateId: page.pageTemplateId })),
          templates: new Set(Object.values(portal.templates)).size,
          snippets: Object.keys(portal.snippets).length,
          assets: portal.webFiles.length,
          forms: portal.forms.length,
          lists: portal.lists.length,
          solutionMetadata: metadata.summary,
          diagnostics: [...portal.diagnostics, ...metadata.diagnostics],
        })),
        solutions: project.solutions,
        references: project.references,
        defaultReference: project.defaultReference?.id ?? null,
        dataPacks: project.dataPacks,
        solutionDiagnostics: bootstrapped.solutionData.diagnostics,
      }, null, 2));
      process.exitCode = bootstrapped.portals.some(({ portal, metadata }) =>
        [...portal.diagnostics, ...metadata.diagnostics].some((d) => d.code?.startsWith("invalid"))) ? 1 : 0;
    }
    else if (project && command === "serve" && !args.portal) {
      const port = Number(args.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("port must be 0–65535");
      if (port && port + project.portals.length - 1 > 65535)
        throw new Error("The configured portal count exceeds the available port range.");
      const sessions = [];
      let stop;
      // The portals share their Solution roots: each file is parsed once during startup.
      const sharedParses = shareSolutionParses();
      try {
        for (let index = 0; index < project.portals.length; index++) {
          const portal = project.portals[index];
          // Each portal keeps its own state directory (cache/, assets/ and evidence/ live
          // next to the state file): --state DIR/FILE becomes DIR/<portal>/FILE.
          const stateFile = args.state
            ? (() => {
                const state = path.parse(path.resolve(args.state));
                return path.join(state.dir, portal.id, state.base);
              })()
            : projectStateFile(project, portal.id, path.join(stateDir, "simulator/projects"));
          const simulator = await createSimulator({
            sourceDir: portal.sourceDir,
            stateFile,
            port: port ? port + index : 0,
            origin: projectOrigin(project, portal) ?? args.origin,
            solutionRoots: portal.solutionRoots,
            solutionOrder: project.solutionOrder,
            environmentVariables: project.environmentVariables,
            project: projectSummary(project, portal.id),
            deploymentProfile: portal.deploymentProfile ?? undefined,
            observed: portal.observed,
            dataModel: portal.dataModel ?? undefined,
            watch: !args["no-watch"] && project.watch !== false,
            onShutdown: () => stop?.(),
            // A source with zero recognised pages is refused, naming its layout.
            requirePortalSource: true,
            allowLiveWrites: args["allow-live-writes"] === true,
          });
          if (args.preset) await simulator.applyPreset(args.preset);
          if (args.cdp) await simulator.live.connect(args.cdp);
          sessions.push({ portal, simulator, stateFile });
        }
      } catch (error) {
        await Promise.all(sessions.map(({ simulator }) => simulator.close()));
        throw error;
      } finally {
        sharedParses.close();
      }
      const discovery = path.join(stateDir, "simulator", `session-${process.pid}.json`);
      await fs.mkdir(path.dirname(discovery), { recursive: true });
      await fs.writeFile(discovery, JSON.stringify({
        pid: process.pid,
        project: project.configFile,
        portals: sessions.map(({ portal, simulator, stateFile }) => ({
          id: portal.id, sourceDir: portal.sourceDir, stateFile,
          url: simulator.url, adminUrl: simulator.adminUrl,
          identityProvider: { origin: simulator.identityProvider.origin, port: simulator.identityProvider.port },
        })),
        discovery,
      }, null, 2));
      console.log(JSON.stringify({ project: project.configFile, portals: sessions.map(({ portal, simulator, stateFile }) => {
        const { config: startedConfig, status: startedStatus } = simulator.state({ summary: true });
        return {
          id: portal.id, sourceDir: portal.sourceDir, stateFile,
          url: simulator.url, adminUrl: simulator.adminUrl,
          // Portal pages carry only site-setting headers unless confinement is opted in.
          confinePortalPages: startedConfig.confinePortalPages,
          signInPath: startedStatus.bootstrap.signInPath,
          // External sign-in's local identity provider: its own loopback port, closed with the runtime.
          identityProvider: { origin: simulator.identityProvider.origin, port: simulator.identityProvider.port },
          // "disabled" unless started with --allow-live-writes.
          liveWrites: simulator.live.status().liveWrites,
        };
      }), discovery }, null, 2));
      let stopped = false;
      stop = async () => {
        if (stopped) return;
        stopped = true;
        await Promise.all(sessions.map(({ simulator }) => simulator.close()));
        await fs.rm(discovery, { force: true });
      };
      process.once("SIGINT", () => stop().then(() => process.exit(0)));
      process.once("SIGTERM", () => stop().then(() => process.exit(0)));
      process.stdin.on("data", (data) => {
        if (String(data).trim() === "stop") stop().then(() => process.exit(0));
      });
    }
    else {
    let sourceDir = args.source,
      origin = args.origin;
    let configuredPortal = null;
    let siteMirage = null;
    if (project) {
      configuredPortal = project.portals.find((p) => p.id === (args.portal ?? project.defaultPortal));
      sourceDir = configuredPortal.sourceDir;
      origin = projectOrigin(project, configuredPortal) ?? origin;
    } else if (!sourceDir) {
      const { loadConfig } = await import("../lense/config.mjs");
      const cfg = await loadConfig({
        site: args.site,
        env: args.env,
        ...(args.repo ? { repo: args.repo } : {}),
        ...(args.config ? { config: args.config } : {}),
      });
      sourceDir = cfg.sourceDir;
      origin ??= /^https:\/\//i.test(cfg.origin ?? '') ? cfg.origin : null;
      args.site ??= cfg.siteName;
      siteMirage = cfg.mirageConfig ?? null;
    } else if (args.site) {
      // --source with a catalogued --site (as `mirage dev` launches serve): the site's
      // mirage settings (observed behaviour, catalogued roots) still apply.
      const { loadConfig } = await import("../lense/config.mjs");
      siteMirage = (await loadConfig({ site: args.site, env: args.env, ...(args.repo ? { repo: args.repo } : {}), ...(args.config ? { config: args.config } : {}) })).mirageConfig ?? null;
    }
    const deploymentProfile = args["deployment-profile"] ?? configuredPortal?.deploymentProfile;
    // The data model of a YAML source: --data-model, else the project portal's or catalogue
    // site's dataModel, else the source's default (lib/importer.mjs).
    const dataModel = args["data-model"] ?? (project ? configuredPortal?.dataModel : siteMirage?.dataModel) ?? undefined;
    if (command === "inspect") {
      // A source with zero recognised pages is not a portal: fail loudly, naming its layout.
      const portal = assertPortalSource(await importPortal(sourceDir, { deploymentProfile, dataModel }));
      console.log(
        JSON.stringify(
          {
            sourceDir: portal.sourceDir,
            format: portal.format,
            layout: portal.source?.dialect ?? null,
            dataModel: portal.dataModel,
            dataModelSource: portal.dataModelSource,
            serverLogics: (portal.serverLogics ?? []).map((item) => item.name),
            cloudFlows: (portal.cloudFlows ?? []).map((item) => item.name),
            pages: portal.pages.map((p) => ({
              id: p.id,
              name: p.name,
              url: p.url,
              pageTemplateId: p.pageTemplateId,
            })),
            templates: new Set(Object.values(portal.templates)).size,
            snippets: Object.keys(portal.snippets).length,
            assets: portal.webFiles.length,
            forms: portal.forms.length,
            lists: portal.lists.length,
            diagnostics: portal.diagnostics,
          },
          null,
          2,
        ),
      );
      process.exitCode = portal.diagnostics.some((d) =>
        d.code?.startsWith("invalid"),
      )
        ? 1
        : 0;
    } else if (
      command === "serve" ||
      command === "render" ||
      command === "capture-shell" ||
      command === "capture-stylesheets" ||
      command === "capture-snippet-composition"
    ) {
      const capturing = [
        "capture-shell",
        "capture-stylesheets",
        "capture-snippet-composition",
      ].includes(command);
      if (capturing && !args.cdp)
        throw new Error(
          `${command} requires --cdp for the intended connected browser.`,
        );
      if (capturing && args.preset)
        throw new Error(
          `${command} does not apply presets. Apply --preset when starting serve.`,
        );
      if (command === "capture-stylesheets" && !args.stylesheet?.length)
        throw new Error(
          "capture-stylesheets requires --stylesheet PATH (repeatable).",
        );
      if (
        command === "capture-snippet-composition" &&
        (!args["parent-snippet"] || !args["child-snippet"])
      )
        throw new Error(
          "capture-snippet-composition requires --parent-snippet NAME and --child-snippet NAME.",
        );
      if (
        command === "capture-shell" &&
        (!args.path.startsWith("/") ||
          args.path.startsWith("//") ||
          args.path.includes("\\"))
      )
        throw new Error("Capture page path must be portal-relative.");
      const port = command === "serve" ? Number(args.port) : 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("port must be 0–65535");
      const stateFile = path.resolve(
        args.state ??
        (project
          ? projectStateFile(project, configuredPortal.id, path.join(stateDir, "simulator/projects"))
          : path.join(stateDir, "simulator", args.site ?? "default", "state.json")));
      // Solution roots are resolved as bootstrap-report resolves them: --solution-root,
      // else the catalogue site's mirage roots, else discovery; layered in derived
      // order unless --solution-order explicit (or the site's solutionOrder: explicit).
      const resolvedRoots = project
        ? { roots: configuredPortal.solutionRoots, order: project.solutionOrder }
        : await resolveSolutionRoots({
            sourceDir,
            explicitRoots: args["solution-root"],
            explicitOrder: args["solution-order"],
            catalogue: siteMirage,
            cacheFile: path.join(path.dirname(stateFile), "cache", "solution-sources.json"),
          });
      const solutionRoots = resolvedRoots.roots;
      let stop;
      const simulator = await createSimulator({
              sourceDir,
        dataPacks: [...(siteMirage?.dataPacks ?? []), ...(args['pack-module'] ?? []).map((module) => ({ module }))],
              ...(project ? { project: projectSummary(project, configuredPortal.id), solutionOrder: project.solutionOrder, environmentVariables: project.environmentVariables } : {}),
        stateFile,
        port,
        origin,
        solutionRoots,
        solutionOrder: resolvedRoots.order,
        // Observed site behaviour the export cannot express (project portal or catalogue site).
        observed: project ? configuredPortal.observed : siteMirage?.observed,
        deploymentProfile,
        dataModel,
        watch: command === "serve" && !args["no-watch"] && project?.watch !== false,
        ...(command === "serve" ? { onShutdown: () => stop?.() } : {}),
        // A source with zero recognised pages is refused, naming its layout.
        requirePortalSource: true,
        allowLiveWrites: args["allow-live-writes"] === true,
      });
      try {
        if (args.preset) {
          await simulator.applyPreset(args.preset);
        }
        if (args.cdp) await simulator.live.connect(args.cdp);
        if (capturing) {
          const state = simulator.state();
          const response = await fetch(
            `${simulator.url}/__sim/api/assets/${command}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Sim-CSRF": state.csrf,
              },
              body: JSON.stringify(
                command === "capture-stylesheets"
                  ? { paths: args.stylesheet }
                  : command === "capture-snippet-composition"
                    ? {
                        path: args.path,
                        parentName: args["parent-snippet"],
                        childName: args["child-snippet"],
                      }
                    : {
                        path: args.path,
                        managedControlPath: args["managed-control-path"],
                      },
              ),
            },
          );
          const report = await response.json();
          const capture = report.report ?? report;
          console.log(
            JSON.stringify(
              {
                ...report,
                counts: {
                  captured: capture.captured?.length ?? 0,
                  failures: capture.failures?.length ?? 0,
                },
              },
              null,
              2,
            ),
          );
          process.exitCode = response.ok ? 0 : 1;
          await simulator.close();
        } else if (command === "render") {
          if (
            !args.path.startsWith("/") ||
            args.path.startsWith("//") ||
            args.path.includes("\\")
          )
            throw new Error("Render path must be portal-relative.");
          const target = new URL(args.path, simulator.url);
          if (target.origin !== simulator.url)
            throw new Error("Render path escaped the local simulator.");
          const response = await fetch(target, { redirect: "error" });
          const html = await response.text();
          if (args.output) {
            const output = path.resolve(args.output);
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, html);
            console.log(
              JSON.stringify(
                {
                  status: response.status,
                  output,
                  diagnostics: simulator.state().diagnostics,
                },
                null,
                2,
              ),
            );
          } else console.log(html);
          process.exitCode = response.ok ? 0 : 1;
          await simulator.close();
        } else {
          const discovery = path.join(
            stateDir,
            "simulator",
            `session-${process.pid}.json`,
          );
          await fs.mkdir(path.dirname(discovery), { recursive: true });
          await fs.writeFile(
            discovery,
            JSON.stringify(
              {
                pid: process.pid,
                url: simulator.url,
                adminUrl: simulator.adminUrl,
                identityProvider: { origin: simulator.identityProvider.origin, port: simulator.identityProvider.port },
                sourceDir,
                stateFile,
              },
              null,
              2,
            ),
          );
          const { config: startedConfig, status: startedStatus } = simulator.state({ summary: true });
          console.log(
            JSON.stringify(
              {
                url: simulator.url,
                adminUrl: simulator.adminUrl,
                sourceDir,
                stateFile,
                discovery,
                // Portal pages carry only site-setting headers unless confinement is opted in.
                confinePortalPages: startedConfig.confinePortalPages,
                signInPath: startedStatus.bootstrap.signInPath,
                // External sign-in's local identity provider: its own loopback port, closed with the runtime.
                identityProvider: { origin: simulator.identityProvider.origin, port: simulator.identityProvider.port },
                // "disabled" unless started with --allow-live-writes.
                liveWrites: simulator.live.status().liveWrites,
              },
              null,
              2,
            ),
          );
          let stopped = false;
          stop = async () => {
            if (stopped) return;
            stopped = true;
            await simulator.close();
            await fs.rm(discovery, { force: true });
          };
          process.once("SIGINT", () => stop().then(() => process.exit(0)));
          process.once("SIGTERM", () => stop().then(() => process.exit(0)));
          process.stdin.on("data", (data) => {
            if (String(data).trim() === "stop")
              stop().then(() => process.exit(0));
          });
        }
      } catch (error) {
        await simulator.close();
        throw error;
      }
    } else throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

/** Portal source and solution roots of `data scaffold`, resolved like serve. */
async function resolveDataSource(options) {
  if (options.project) {
    if (options.source) throw new Error("Use either --project or --source, not both.");
    if (options["solution-root"]?.length) throw new Error("--solution-root is supplied by the project configuration.");
    const project = await loadProjectConfig(options.project);
    const portalId = options.portal ?? project.defaultPortal;
    const portal = project.portals.find((candidate) => candidate.id === portalId);
    if (!portal) throw new Error(`Portal '${portalId}' is not configured in ${project.configFile}`);
    return {
      source: portal.sourceDir,
      "solution-root": portal.solutionRoots,
      resolution: { kind: "project", configFile: project.configFile, portal: portal.id },
    };
  }
  if (options.source)
    return {
      source: path.resolve(options.source),
      resolution: { kind: "source", solutionRoots: options["solution-root"]?.length ? "explicit" : "discovered" },
    };
  const { loadConfig } = await import("../lense/config.mjs");
  const cfg = await loadConfig({ site: options.site, env: options.env, ...(options.repo ? { repo: options.repo } : {}), ...(options.config ? { config: options.config } : {}) });
  return {
    source: cfg.sourceDir,
    resolution: { kind: "catalogue", site: cfg.siteName, env: options.env, solutionRoots: options["solution-root"]?.length ? "explicit" : "discovered" },
  };
}
