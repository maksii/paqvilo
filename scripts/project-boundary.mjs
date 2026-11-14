import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textFile = /\.(?:mjs|js|json|html|css|md|xml|ya?ml|template)$/;

// Project extensions enter through the explicit registry API, never as built-in dependencies.
function runtimeImports(source, file, directory) {
  const findings = [];
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
  )) {
    const specifier = match[1].replaceAll('\\', '/');
    const resolved = path.resolve(path.dirname(file), specifier);
    const relative = path.relative(directory, resolved).replaceAll('\\', '/');
    const outside = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative);
    if (
      /(?:^|\/)packs\//.test(specifier) ||
      /(?:^|\/)examples(?:\/|$)/.test(specifier) ||
      (specifier.startsWith('.') && outside) ||
      path.isAbsolute(specifier) ||
      /^[A-Za-z]:\//.test(specifier)
    ) {
      findings.push(`project-owned dependency: ${specifier}`);
    }
  }
  return findings;
}

/* NOSONAR */ function inspectProjectFile(file, name, rel, directory, findings) {
  const runtime =
    /^(?:lense|mirage)\//.test(rel) &&
    !/^(?:lense|mirage)\/(?:test|test-browser|testing|docs)\//.test(rel) &&
    /\.[cm]?js$/.test(name);
  // Only empty templates and runtime modules have content rules; other files are not read.
  if (!runtime && !rel.startsWith('templates/')) return;
  const source = fs.readFileSync(file, 'utf8');
  if (rel.startsWith('templates/')) {
    if (/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(source))
      findings.push(`${rel}: project identity in empty template`);
    for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      if (!/(?:^|\.)example\.test$/.test(match[1]) && !match[1].endsWith('.invalid'))
        findings.push(`${rel}: non-placeholder origin in empty template`);
    }
    if (/\bobserved\s*:\s*\{/.test(source)) findings.push(`${rel}: project observation in empty template`);
  }
  if (runtime) {
    for (const finding of runtimeImports(source, file, directory)) findings.push(`${rel}: ${finding}`);
  }
}

function inspectProjectDirectory(dir, directory, findings) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.paqvilo'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const rel = path.relative(directory, file).replaceAll('\\', '/');
    if (entry.isDirectory()) inspectProjectDirectory(file, directory, findings);
    else if (textFile.test(entry.name)) inspectProjectFile(file, entry.name, rel, directory, findings);
  }
}

export function inspectProjectBoundary(directory = root) {
  const findings = [];
  for (const name of [
    'bin',
    'lense',
    'mirage',
    'scripts',
    'test',
    'test-browser',
    'docs',
    'examples',
    'templates',
    '.github',
  ]) {
    const dir = path.join(directory, name);
    if (fs.existsSync(dir)) inspectProjectDirectory(dir, directory, findings);
  }
  if (fs.existsSync(path.join(directory, 'mirage/packs')))
    findings.push('mirage/packs: project packs must be external');
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = inspectProjectBoundary();
  if (findings.length) {
    console.error(findings.join('\n'));
    process.exitCode = 1;
  } else console.log('Project boundary passed: reusable source, tests, examples and guidance are independent.');
}
