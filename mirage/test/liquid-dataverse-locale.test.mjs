// @test-kind contract: the local Liquid reader uses the selected portal language for imported choice labels and the Knowledge language join
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const ITEM = 'ab000000-0000-4000-8000-000000000001';
const ENGLISH = 'ab000000-0000-4000-8000-000000000002';
const FRENCH = 'ab000000-0000-4000-8000-000000000003';
const template = `
{% fetchxml choices %}<fetch><entity name="locale_item"><attribute name="item_choice" alias="localized_choice"/></entity></fetch>{% endfetchxml %}
<section id="fetch">{% for row in choices.results.entities %}{{ row.localized_choice.value }}:{{ row.localized_choice.label }}{% endfor %}</section>
<section id="entity">{{ entities.locale_item["${ITEM}"].item_choice.label }}</section>
{% fetchxml articles %}
  <fetch><entity name="knowledgearticle"><attribute name="title"/>
    <link-entity name="languagelocale" from="languagelocaleid" to="languagelocaleid">
      <filter><condition attribute="code" operator="eq" value="{{ website.selected_language.code }}"/></filter>
    </link-entity>
  </entity></fetch>
{% endfetchxml %}
<section id="articles">{% for row in articles.results.entities %}{{ row.title }}{% endfor %}</section>`;

for (const liquidFetchExecution of ['eager', 'lazy-query-drop'])
  test(`${liquidFetchExecution} Liquid reads use the request LCID and the exact selected Knowledge locale join`, async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'liquid-dataverse-locale-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    const files = {
      'site/website.yml': 'adx_websiteid: site\nadx_name: Localized database\nadx_defaultlanguage: english',
      'site/websitelanguage.yml':
        '- adx_websitelanguageid: english\n  adx_name: English\n  adx_languagecode: en-US\n  adx_lcid: 1033\n' +
        '- adx_websitelanguageid: french\n  adx_name: French\n  adx_languagecode: fr-FR\n  adx_lcid: 1036\n',
      'site/sitesetting.yml': 'adx_name: MultiLanguage/DisplayLanguageCodeInURL\nadx_value: true',
      'site/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: page',
      'site/Home.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: template',
      'site/Home.webtemplate.yml': 'adx_webtemplateid: template\nadx_name: Home',
      'site/Home.webtemplate.source.html': template,
      'solution/Entities/locale_item/Entity.xml': `<Entity><Name>locale_item</Name><EntityInfo><entity Name="locale_item">
      <EntitySetName>locale_items</EntitySetName><PrimaryIdAttribute>locale_itemid</PrimaryIdAttribute>
      <attributes><attribute PhysicalName="locale_itemid"><Name>locale_itemid</Name><Type>primarykey</Type></attribute>
      <attribute PhysicalName="item_choice"><Name>item_choice</Name><Type>picklist</Type>
      <optionset Name="locale_item_choice"><OptionSetType>picklist</OptionSetType><options>
        <option value="1"><labels><label description="Approved" languagecode="1033"/><label description="Approuvé" languagecode="1036"/></labels></option>
      </options></optionset></attribute></attributes></entity></EntityInfo></Entity>`,
    };
    for (const [relative, contents] of Object.entries(files)) {
      const filename = path.join(root, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, contents);
    }
    const app = await createSimulator({
      sourceDir: path.join(root, 'site'),
      solutionRoots: [path.join(root, 'solution')],
      projectRoot: root,
      watch: false,
      observed: { liquidFetchExecution, evidence: 'Invented language fixture for local execution in both modes' },
      initial: {
        mappings: {
          knowledgearticle: { entitySet: 'knowledgearticles', idColumn: 'knowledgearticleid', nameColumn: 'title' },
          languagelocale: { entitySet: 'languagelocales', idColumn: 'languagelocaleid', nameColumn: 'code' },
        },
        tables: {
          locale_item: [{ locale_itemid: ITEM, item_choice: 1 }],
          knowledgearticle: [
            { knowledgearticleid: 'article-en', languagelocaleid: ENGLISH, title: 'English article' },
            { knowledgearticleid: 'article-fr', languagelocaleid: FRENCH, title: 'French article' },
          ],
          languagelocale: [
            { languagelocaleid: ENGLISH, code: 'en-US' },
            { languagelocaleid: FRENCH, code: 'fr-FR' },
          ],
        },
        permissions: ['locale_item', 'knowledgearticle'].map((entity) => ({
          id: entity,
          entity,
          scope: 'global',
          operations: ['read'],
        })),
      },
    });
    ownedFixture(t).add(() => app.close());
    assert.equal(app.store.tableRows('locale_item').length, 1, 'the invented item is present before rendering');
    for (const [language, choice, article] of [
      ['en-US', 'Approved', 'English article'],
      ['fr-FR', 'Approuvé', 'French article'],
    ]) {
      const response = await fetch(`${app.url}/${language}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      const value = (id) => new RegExp(`<section id="${id}">([^<]*)</section>`).exec(html)?.[1];
      assert.equal(value('fetch'), `1:${choice}`, `${language}\n${html.match(/<section[^>]*>[^<]*<\/section>/g)}`);
      assert.equal(value('entity'), choice);
      assert.equal(value('articles'), article);
    }
  });
