// A dependency-free GitHub Pages build: ship only deliberate public site assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The help contract of scripts/script-help.mjs, inline: the site build test runs this file without its siblings.
const [arg] = process.argv.slice(2);
if (arg === '--help' || arg === '-h') {
  console.log(`Usage: npm run site:build   (node scripts/build-site.mjs)
Replaces dist/pages with the public site files, two docs/assets images and the site/media screenshots, and checks every
project-site link. Offline. Takes no options; --help prints this help.`);
  process.exit(0);
}
if (arg) {
  console.error(`build-site: unknown option ${arg} (see --help).`);
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'pages');
// Rebuild only the generated directory; stale files must never enter a Pages artifact.
const resolvedRoot = fs.realpathSync(root);
const dist = path.dirname(output);
if (fs.existsSync(dist) && fs.realpathSync(dist) !== path.join(resolvedRoot, 'dist'))
  throw new Error('The site build directory must stay inside this checkout.');
if (
  fs.existsSync(output) &&
  (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== path.join(resolvedRoot, 'dist', 'pages'))
)
  throw new Error('The site output must be a generated directory inside this checkout.');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
// robots.txt and sitemap.xml are served from the root of the site's own domain.
for (const name of [
  'index.html',
  'coverage.html',
  'guide.html',
  'guide.js',
  'style.css',
  'favicon.svg',
  'robots.txt',
  'sitemap.xml',
])
  fs.copyFileSync(path.join(root, 'site', name), path.join(output, name));
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
// Only the images a page references: the diagram and the social preview.
for (const name of ['social-preview.png'])
  fs.copyFileSync(path.join(root, 'docs/assets', name), path.join(output, 'assets', name));
// Screenshots: every file in site/media, flat (stills as WebP, clips as MP4).
fs.mkdirSync(path.join(output, 'media'), { recursive: true });
for (const entry of fs.readdirSync(path.join(root, 'site/media'), { withFileTypes: true })) {
  if (!entry.isFile()) throw new Error(`site/media must contain files only: ${entry.name}`);
  fs.copyFileSync(path.join(root, 'site/media', entry.name), path.join(output, 'media', entry.name));
}
fs.writeFileSync(path.join(output, '.nojekyll'), '');
// Catch project-site path mistakes, missing assets and anchors that name no element before publication.
const pages = ['index.html', 'coverage.html', 'guide.html'];
const read = (name) => fs.readFileSync(path.join(output, name), 'utf8');
const ids = new Map(
  pages.map((name) => [name, new Set([...read(name).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))]),
);
for (const name of pages) {
  const html = read(name);
  for (const match of html.matchAll(/(?:href|src|poster)="([^"]+)"/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    if (target.startsWith('/') || !fs.existsSync(path.join(output, target)))
      throw new Error(`Broken project-site link in ${name}: ${target}`);
  }
  // A fragment must name an existing id, on this page or on the site page it points to.
  for (const [, page, id] of html.matchAll(/href="([^"#]*)#([^"]+)"/g)) {
    if (!page && !ids.get(name).has(id)) throw new Error(`Broken in-page link in ${name}: #${id}`);
    if (ids.has(page) && !ids.get(page).has(id))
      throw new Error(`Broken ${page === name ? 'in-page' : 'cross-page'} link in ${name}: ${page}#${id}`);
  }
}
console.log(`GitHub Pages built and links checked: ${output}`);
