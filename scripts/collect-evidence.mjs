// CI publishes only known synthetic outputs, never the complete development state directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUTS = {
  'extended-round': /^(?:multipart\.json|(?:classic|enhanced)-workflows\.(?:json|png)|verify-(?:classic|enhanced)-(?:baseline|working-copy)\.json)$/,
  'multi-portal-round': /^(?:acceptance|cli-smoke)\.json$/,
};

export function collectSyntheticEvidence(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const root = fs.realpathSync.native(stateDir);
  const output = fs.mkdtempSync(path.join(root, 'ci-evidence-'));
  const files = [];
  for (const [folder, allowed] of Object.entries(OUTPUTS)) {
    const source = path.join(root, folder);
    if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || !allowed.test(entry.name)) continue;
      const relative = path.join(folder, entry.name);
      const target = path.join(output, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, entry.name), target);
      files.push(relative.replaceAll('\\', '/'));
    }
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ synthetic: true, files }, null, 2) + '\n');
  return { output, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = collectSyntheticEvidence(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.paqvilo'));
  if (process.argv.includes('--azure')) console.log(`##vso[task.setvariable variable=paqviloEvidence]${result.output}`);
  console.log(`Collected ${result.files.length} synthetic evidence files in ${result.output}`);
}
