import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function profileFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-profile-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const sourceDir = path.join(root, 'portal'), solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Profile fixture',
    'portal/web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/web-templates/Main.webtemplate.source.html': '<html><body><h1>{{ snippets.Greeting }}</h1></body></html>',
    'portal/content-snippets/Greeting.contentsnippet.yml': 'adx_contentsnippetid: greeting\nadx_name: Greeting',
    'portal/content-snippets/Greeting.contentsnippet.value.html': 'Exported',
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>Fixture</UniqueName></SolutionManifest></ImportExportXml>',
    'solution/environmentvariabledefinitions/sample_Url/environmentvariabledefinition.xml': '<environmentvariabledefinition schemaname="sample_Url"><displayname default="URL"/><type>100000000</type><defaultvalue>Default</defaultvalue></environmentvariabledefinition>',
    'solution/environmentvariabledefinitions/sample_Url/environmentvariablevalues.json': '{"environmentvariablevalues":{"environmentvariablevalue":{"value":"Exported variable"}}}',
    'profiles/dev.yml': 'adx_contentsnippet:\n- adx_contentsnippetid: greeting\n  adx_value: Development',
    'profiles/test.json': JSON.stringify({ adx_contentsnippet: [{ adx_contentsnippetid: 'greeting', adx_value: 'Test' }] }),
  };
  for (const name of ['dev', 'test']) files[`profiles/${name}-settings.json`] = JSON.stringify({
    EnvironmentVariables: [{ SchemaName: 'sample_Url', Value: `${name} variable` }],
    ConnectionReferences: [{ LogicalName: 'sample_Api', ConnectionId: `${name}-connection`, ConnectorId: '/providers/Microsoft.PowerApps/apis/shared_sample' }],
  });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const deploymentProfiles = { default: 'dev', required: ['pages'], profiles: {
    dev: { pages: 'profiles/dev.yml', environmentVariables: 'profiles/dev-settings.json', connectionReferences: 'profiles/dev-settings.json' },
    test: { pages: 'profiles/test.json', environmentVariables: 'profiles/test-settings.json', connectionReferences: 'profiles/test-settings.json' },
  } };
  return { root, sourceDir, solutionRoots: [solution], projectRoot: root, deploymentProfiles, files, stateFile: path.join(root, '.paqvilo', 'state.json'), onCleanup: cleanup => cleanups.push(cleanup) };
}
