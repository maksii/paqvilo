// The source of the Permission Lab shell web template. A module of its own, with Node built-ins only: the deployment
// and the tests that render the shell read it without the Dataverse client.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function shellSource(manifest) {
  const core = await fs.readFile(path.join(here, 'core.mjs'), 'utf8'),
    runtime = await fs.readFile(path.join(here, 'runtime.mjs'), 'utf8');
  const coreImport = /^import\s*\{[^}]*\}\s+from\s+(['"])\.\/core\.mjs\1;\s*/;
  if (!coreImport.test(runtime)) throw new Error('The portal runtime must begin with its bundled core import.');
  const code = (core + '\n' + runtime.replace(coreImport, '')).replace(/\bexport /g, '');
  const encoded = JSON.stringify(manifest).replaceAll('<', String.raw`\u003c`);
  return `<section id="co-lab"><h1>Company Operations Permission Lab</h1><p>Paired Liquid and Web API FetchXML. Results distinguish parity, scenario assertions and missing backend evidence.</p><pre id="co-identity"></pre><label>Read case <select id="co-cases"><option value="all">All read cases and variants</option></select></label><label>Previous run <select id="co-baseline"><option value="">No baseline</option></select></label><button id="co-history">Load history</button><button id="co-view-history">View selected run</button><button id="co-read" data-run>Run reads</button><label>CRUD scope <select id="co-crud-scope"><option value="all">All prepared canaries</option><option value="equipment">Equipment only</option><option value="probe">Recorder probe only</option></select></label><button id="co-crud" data-run>Run reads and prepared CRUD</button><label>Plugin profile <select id="co-profile"><option value="">None</option></select></label><button id="co-stop">Stop</button><button id="co-export">Export current JSON</button><p id="co-status" role="status"></p><div id="co-results"></div></section><style>#co-lab{max-width:1100px;margin:24px auto;padding:16px;font-family:system-ui}#co-lab pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f7;padding:12px}#co-lab button,#co-lab select{margin:6px;padding:8px}#co-lab details{border-top:1px solid #ddd;padding:10px}</style><script id="co-context" type="application/xml"><context contact-id="{{ user.id | xml_escape }}"><roles>{% for role in user.roles %}<role>{{ role | xml_escape }}</role>{% endfor %}</roles></context></script>{% raw %}<script type="module">${code}\nconst manifest=${encoded};const contextXML=new DOMParser().parseFromString(document.getElementById('co-context').textContent,'application/xml');const context={contactId:contextXML.documentElement.getAttribute('contact-id'),roles:[...contextXML.querySelectorAll('role')].map(r=>r.textContent)};mount(manifest,context);</script>{% endraw %}`;
}
