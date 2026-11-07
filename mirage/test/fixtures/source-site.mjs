import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../../testing/owned-fixture.mjs';

export async function sourceFixture(t, { prefix, files, subdirectory = '' }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, subdirectory);
  for (const [name, body] of Object.entries(files)) {
    const destination = path.join(sourceDir, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, body);
  }
  return { root, sourceDir };
}

export async function simulatorFixture(t, { prefix, files, ...options }) {
  const { sourceDir } = await sourceFixture(t, { prefix, files });
  const sim = await createSimulator({ sourceDir, ...options });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

export async function inventedProjectFixture(t, prefix) {
  const { root } = await sourceFixture(t, {
    prefix,
    files: {
      'portal/website.yml': 'adx_name: Invented\nadx_websiteid: invented\n',
      'portal/web-pages/home.webpage.yml':
        'adx_name: Home\nadx_webpageid: home\nadx_partialurl: /\nadx_copy: <div>Home</div>\n',
      'paqvilo.config.yml':
        'sourceRoot: .\nsites:\n  invented:\n    source: portal\n    environments:\n      dev: https://invented.example.test\n',
    },
  });
  return root;
}

export async function environmentVariableFixture(t, prefix) {
  const { root, sourceDir } = await sourceFixture(t, {
    prefix,
    subdirectory: 'portal',
    files: {
      'website.yml': 'adx_websiteid: site\nadx_name: Variables',
      'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
    },
  });
  return { dir: root, portal: sourceDir, solution: path.join(root, 'solution') };
}

export function adminJsonCaller(app) {
  const csrf = app.csrf;
  return async (route, method = 'GET', body) => {
    const response = await fetch(app.url + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}
