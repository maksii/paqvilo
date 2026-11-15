// Asserts that the static imports of served browser modules resolve to served JavaScript modules, from the entry URLs given.
import assert from 'node:assert/strict';

// Static `import`/`export ... from` specifiers of a module; a dynamic `import(...)` has no whitespace before its parenthesis.
const STATIC_SPECIFIER = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

export async function assertStaticImportsServed(entryUrls) {
  const pending = [...entryUrls];
  const seen = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await fetch(url);
    assert.equal(response.status, 200, `${url} is not served`);
    assert.match(response.headers.get('content-type'), /^text\/javascript/, url);
    for (const [, specifier] of (await response.text()).matchAll(STATIC_SPECIFIER)) {
      assert.match(specifier, /^(?:\.{1,2}\/|\/)/, `${url} imports ${specifier} by a bare specifier`);
      pending.push(new URL(specifier, url).href);
    }
  }
}
