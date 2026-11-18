import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { editSource } from 'paqvilo/lense/source-edit.mjs';
import { cli, UsageError } from '../cli.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = cli(
  `Usage: node ./deployment/configure.mjs --environment https://YOUR-ENVIRONMENT.crm.dynamics.com [--pac FILE]

Run from the demo folder after importing PaqviloDemoCodeComponents.zip. Reads the live environment through
\`pac org fetch\` to resolve the imported ExampleAccountFields code component's ID, then writes that ID into the
local PCF page sources (portal/web-pages/pcf-account) and the paqvilo.config.yml mapping. Writes nothing to the
environment.

  --environment URL  required: the environment origin PAC is authenticated to
  --pac FILE         PAC executable (default: pac on PATH)`,
  { environment: { type: 'string' }, pac: { type: 'string', default: 'pac' } },
);
let environment;
try {
  environment = new URL(values.environment ?? '');
} catch {
  environment = null;
}
if (
  environment?.protocol !== 'https:' ||
  environment.username ||
  environment.password ||
  environment.search ||
  environment.hash ||
  !/^\/\s*$/.test(environment.pathname)
) {
  throw new UsageError('Use --environment https://YOUR-ENVIRONMENT.crm.dynamics.com.');
}
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-component-query-')));
try {
  const query = path.join(temporary, 'control.xml');
  await fs.writeFile(
    query,
    '<fetch><entity name="customcontrol"><attribute name="customcontrolid"/><filter><condition attribute="name" operator="eq" value="exa_ExamplePages.ExampleAccountFields"/></filter></entity></fetch>',
  );
  const { stdout } = await run(values.pac, ['org', 'fetch', '--environment', environment.origin, '--xmlFile', query], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 256_000,
  }).catch((error) => {
    if (error.code === 'ENOENT')
      throw new UsageError(`PAC CLI not found (${values.pac}); install PAC or pass --pac FILE.`);
    // PAC output is not echoed: its messages can carry account details.
    throw new Error(`pac org fetch failed (exit ${error.code ?? error.signal}); check that PAC is signed in to it.`);
  });
  const ids = [...new Set(stdout.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || [])];
  if (ids.length !== 1)
    throw new Error(
      'The imported ExampleAccountFields component could not be resolved uniquely. Import PaqviloDemoCodeComponents.zip first.',
    );
  const sourceDir = path.join(root, 'portal');
  const files = [
    path.join(sourceDir, 'web-pages/pcf-account/PCF-account.webpage.copy.html'),
    path.join(sourceDir, 'web-pages/pcf-account/content-pages/PCF-account.en-US.webpage.copy.html'),
  ];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const tags = [...source.matchAll(/\{%\s*codecomponent\s+name\s*:\s*[0-9a-f-]{36}\s*%\}/gi)];
    if (tags.length !== 1) throw new Error('The exported PCF workspace must contain exactly one component tag.');
  }
  const catalogue = path.join(root, 'paqvilo.config.yml');
  const configuration = await fs.readFile(catalogue, 'utf8');
  const mappings = [
    ...configuration.matchAll(
      /^((?:(?![\r\n\u2028\u2029])\s)*)([0-9a-f-]{36})(:\s*exa_ExamplePages\.ExampleAccountFields\s*)$/gim,
    ),
  ];
  if (mappings.length !== 1)
    throw new Error('The local catalogue must contain exactly one observed ExampleAccountFields mapping.');
  for (const file of files)
    editSource({ file, sourceDir }, (text) =>
      text.replace(/(\{%\s*codecomponent\s+name\s*:\s*)[0-9a-f-]{36}(\s*%\})/gi, '$1' + ids[0] + '$2'),
    );
  editSource({ file: catalogue, sourceDir: root }, (text) =>
    text.replace(
      /^((?:(?![\r\n\u2028\u2029])\s)*)[0-9a-f-]{36}(:\s*exa_ExamplePages\.ExampleAccountFields\s*)$/gim,
      '$1' + ids[0] + '$2',
    ),
  );
  console.log('PCF source configured for the selected environment.');
  console.log('Next: pac pages upload --path ./portal --modelVersion 2 --environment ' + environment.origin);
} finally {
  // This helper owns only the temporary query it created.
  await fs.unlink(path.join(temporary, 'control.xml')).catch(() => {});
  await fs.rmdir(temporary);
}
