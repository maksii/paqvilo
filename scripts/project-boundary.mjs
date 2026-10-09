import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Guard against inherited organisation identifiers in reusable code and fixtures.
const terms = ['e' + 'ma', 'p' + 'lm', 'e' + 'smp', 'i' + 'ris', 'e' + 'af', 'p' + 'ui', 'e' + 'ns'];
const business = new RegExp(`\\b(?:${terms.join('|')})\\b|\\be${'ma'}_|eu${'ema'}|e${'ma'}logo|_e${'ns'}`, 'i');
const legacy = /pp-local|PP_LOCAL|\b[Cc]ompanion\b/;
const allowed = new Set(['docs/migration.md', 'mirage/test/core-separation.test.mjs', 'scripts/project-boundary.mjs', 'test/project-boundary.test.mjs']);
const textFile = /\.(?:mjs|js|json|html|css|md|xml|ya?ml)$/;

export function inspectProjectBoundary(directory = root) {
  const findings = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.paqvilo', '.pp-local'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const rel = path.relative(directory, file).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(file);
      else if (textFile.test(entry.name) && !allowed.has(rel)) {
        const source = fs.readFileSync(file, 'utf8');
        if (business.test(source)) findings.push(`${rel}: project-specific identifier`);
        if (legacy.test(source)) findings.push(`${rel}: old product name`);
      }
    }
  };
  for (const name of ['bin', 'lense', 'mirage', 'scripts', 'test', 'test-browser', 'docs', 'examples', '.github']) {
    const dir = path.join(directory, name);
    if (fs.existsSync(dir)) walk(dir);
  }
  for (const name of ['package.json', 'paqvilo.config.yml', 'README.md', 'CONTRIBUTING.md', 'AGENTS.md', '.env.example']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file) && business.test(fs.readFileSync(file, 'utf8'))) findings.push(`${name}: project-specific identifier`);
  }
  if (fs.existsSync(path.join(directory, 'mirage/packs'))) findings.push('mirage/packs: project packs must be external');
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = inspectProjectBoundary();
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
  else console.log('Project boundary passed: reusable source, tests, examples and guidance are independent.');
}
