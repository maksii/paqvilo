// A dependency-free GitHub Pages build: ship only deliberate public site assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'pages');
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
