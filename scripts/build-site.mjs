// A dependency-free GitHub Pages build: ship only deliberate public site assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'pages');
// Rebuild only the generated directory; stale files must never enter a Pages artifact.
const resolvedRoot = fs.realpathSync(root);
const dist = path.dirname(output);
if (fs.existsSync(dist) && fs.realpathSync(dist) !== path.join(resolvedRoot, 'dist')) throw new Error('The site build directory must stay inside this checkout.');
if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== path.join(resolvedRoot, 'dist', 'pages'))) throw new Error('The site output must be a generated directory inside this checkout.');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of ['index.html', 'coverage.html', 'style.css']) fs.copyFileSync(path.join(root, 'site', name), path.join(output, name));
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
for (const name of ['overview.svg', 'lense-visual.png', 'mirage-visual.png']) fs.copyFileSync(path.join(root, 'docs/assets', name), path.join(output, 'assets', name));
fs.writeFileSync(path.join(output, '.nojekyll'), '');
// Catch project-site path mistakes and missing assets before publication.
for (const name of ['index.html', 'coverage.html']) {
  const html = fs.readFileSync(path.join(output, name), 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (target.startsWith('/') || !fs.existsSync(path.join(output, target))) throw new Error(`Broken project-site link in ${name}: ${target}`);
  }
}
console.log(`GitHub Pages built and links checked: ${output}`);
