import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { editSource } from 'paqvilo/lense/source-edit.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { environment: { type: 'string' }, pac: { type: 'string', default: 'pac' } } });
const environment = new URL(values.environment || 'https://invalid.example');
if (!values.environment || environment.protocol !== 'https:' || environment.username || environment.password || environment.search || environment.hash || !/^\/[\s]*$/.test(environment.pathname)) {
  throw new Error('Use --environment https://YOUR-ENVIRONMENT.crm.dynamics.com');
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-component-query-'));
try {
  const query = path.join(temporary, 'control.xml');
  await fs.writeFile(query, '<fetch><entity name="customcontrol"><attribute name="customcontrolid"/><filter><condition attribute="name" operator="eq" value="exa_ExamplePages.ExampleAccountFields"/></filter></entity></fetch>');
  const { stdout } = await run(values.pac, ['org', 'fetch', '--environment', environment.origin, '--xmlFile', query], { windowsHide: true, timeout: 60_000, maxBuffer: 256_000 });
  const ids = [...new Set(stdout.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || [])];
  if (ids.length !== 1) throw new Error('The imported ExampleAccountFields component could not be resolved uniquely. Import PaqviloDemoCodeComponents.zip first.');
  const sourceDir = path.join(root, 'portal');
  const files = [path.join(sourceDir, 'web-pages/pcf-account/PCF-account.webpage.copy.html'), path.join(sourceDir, 'web-pages/pcf-account/content-pages/PCF-account.en-US.webpage.copy.html')];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const tags = [...source.matchAll(/\{%\s*codecomponent\s+name\s*:\s*[0-9a-f-]{36}\s*%\}/gi)];
    if (tags.length !== 1) throw new Error('The exported PCF workspace must contain exactly one component tag.');
  }
  const catalogue = path.join(root, 'paqvilo.config.yml');
  const configuration = await fs.readFile(catalogue, 'utf8');
  const mappings = [...configuration.matchAll(/^(\s*)([0-9a-f-]{36})(:\s*exa_ExamplePages\.ExampleAccountFields\s*)$/gim)];
  if (mappings.length !== 1) throw new Error('The local catalogue must contain exactly one observed ExampleAccountFields mapping.');
  for (const file of files) editSource({ file, sourceDir }, text => text.replace(/(\{%\s*codecomponent\s+name\s*:\s*)[0-9a-f-]{36}(\s*%\})/gi, '$1' + ids[0] + '$2'));
  editSource({ file: catalogue, sourceDir: root }, text => text.replace(/^(\s*)[0-9a-f-]{36}(:\s*exa_ExamplePages\.ExampleAccountFields\s*)$/gim, '$1' + ids[0] + '$2'));
  console.log('PCF source configured for the selected environment.');
  console.log('Next: pac pages upload --path ./portal --modelVersion 2 --environment ' + environment.origin);
} finally {
  // This helper owns only the temporary query it created.
  await fs.unlink(path.join(temporary, 'control.xml')).catch(() => {});
  await fs.rmdir(temporary);
}
