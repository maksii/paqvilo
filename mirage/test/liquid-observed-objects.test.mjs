import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LiquidEngine,
  LiquidContext,
  LiquidDrop,
  LIQUID_PROPERTIES,
  LIQUID_HIDDEN,
  lookupMember,
  isEnumerable,
} from '../lib/liquid-engine.mjs';
import { createFilters, FILTER_SIGNATURES } from '../lib/liquid-filters.mjs';
import { applyObservedLiquidObjects, withLiquidIdentity } from '../lib/liquid-observed-objects.mjs';

const engine = new LiquidEngine({ filters: createFilters(), filterSignatures: FILTER_SIGNATURES });
const render = (source, context) => engine.parse(source).render(new LiquidContext(engine, { environment: context }));
const observed = (context) => applyObservedLiquidObjects(context, { mode: 'observed' });

test('object observations are opt-in and do not alter original records or anonymous users', async () => {
  const context = { website: { name: 'Fixture portal', adx_name: 'Exported fixture title' }, user: null };
  assert.equal(applyObservedLiquidObjects(context), context);
  assert.equal(await render('{{ website.name }}', context), 'Fixture portal');
  const output = observed(context);
  assert.equal(
    await render(
      '{{ website.name }}|{{ website.adx_name }}|{% if user %}signed-in{% else %}anonymous{% endif %}',
      output,
    ),
    '|Exported fixture title|anonymous',
  );
  assert.equal(output.website.name, 'Fixture portal');
  assert.equal(context.website[LIQUID_HIDDEN], undefined);
  assert.throws(() => applyObservedLiquidObjects(context, { mode: 'unknown' }), /compatibility mode/);
});

test('observed host names are hidden while entity fields, identity, roles and existing guards survive', async () => {
  const user = {
    id: 'fixture-contact-id',
    name: 'Host alias',
    fullname: 'Synthetic Contact',
    roles: ['Reader'],
    privateValue: 'hidden',
  };
  Object.defineProperty(user, LIQUID_PROPERTIES, { value: new Set(['id', 'roles']) });
  Object.defineProperty(user, LIQUID_HIDDEN, { value: new Set(['privateValue']) });
  const context = observed({ user });
  assert.equal(
    await render(
      "{{ user.name }}|{{ user.NAME }}|{{ user.ID }}|{{ user.fullname }}|{{ user.FullName }}|{{ user.roles | join: ',' }}|{{ user.privateValue }}",
      context,
    ),
    '||fixture-contact-id|Synthetic Contact||Reader|',
  );
  assert.equal(user.name, 'Host alias');
  assert.deepEqual([...user[LIQUID_HIDDEN]], ['privateValue']);
});

test('entity-set CLR type conversion keeps table/key resolution and provider failures', async () => {
  const reads = [];
  class FixtureSet extends LiquidDrop {
    async liquidGet(key) {
      reads.push(key);
      if (key === 'explode') throw new Error('Fixture provider unavailable');
      return key === 'row' ? { title: 'Fixture row' } : null;
    }
  }
  const set = new FixtureSet();
  class FixtureEntities extends LiquidDrop {
    liquidGet() {
      return set;
    }
  }
  const context = observed({ entities: new FixtureEntities() });
  assert.equal(
    await render('{{ entities.example | escape }}', context),
    "Liquid error: Object of type 'Adxstudio.Xrm.Web.Mvc.Liquid.EntitySetDrop' cannot be converted to type 'System.String'.",
  );
  assert.equal(
    await render('{{ entities.example.row.title }}|{{ entities.example.missing.title }}', context),
    'Fixture row|',
  );
  assert.deepEqual(reads, ['row', 'missing']);
  const table = (await lookupMember(context.entities, 'example')).value;
  await assert.rejects(lookupMember(table, 'explode'), /Fixture provider unavailable/);
});

test('observed sitemap index probes use typed node drops and retain existing navigation', async () => {
  const sitemap = {
    root: { title: 'Fixture home', children: [{ title: 'Fixture child' }] },
    '/fixture/': { title: 'Fixture route' },
  };
  const context = observed({ sitemap });
  assert.equal(
    await render('{{ sitemap.name | escape }}|{{ sitemap.code | escape }}', context),
    "Liquid error: Object of type 'Adxstudio.Xrm.Web.Mvc.Liquid.SiteMapNodeDrop' cannot be converted to type 'System.String'.|Liquid error: Object of type 'Adxstudio.Xrm.Web.Mvc.Liquid.SiteMapNodeDrop' cannot be converted to type 'System.String'.",
  );
  assert.equal(
    await render(
      "{{ sitemap.root.title }}|{{ sitemap['/fixture/'].title }}|{% for node in sitemap.root.children %}{{ node.title }}{% endfor %}|{{ sitemap.other }}",
      context,
    ),
    'Fixture home|Fixture route|Fixture child|',
  );
  assert.equal(sitemap.name, undefined);
});

test('events presence is bounded to the observed empty drop and does not fabricate service metadata', async () => {
  const context = observed({});
  assert.equal(
    await render(
      '{% if events %}present{% endif %}|{{ events.id }}|{{ events.name }}|{{ events.code }}|{{ events.size }}',
      context,
    ),
    'present||||',
  );
  assert.equal(isEnumerable(context.events), false);
  assert.equal(context.blogs, undefined);
  assert.equal(context.forums, undefined);
  const existing = { upcoming: ['Fixture event'] };
  assert.equal(observed({ events: existing }).events, existing);
});

test('source-derived Liquid content ID leaves root navigation and guarded member lookup intact', async () => {
  const page = {
    id: 'root-page-id',
    title: 'Fixture page',
    adx_copy: 'Fixture copy',
    secret: 'hidden',
    callback() {
      return 'host-only';
    },
  };
  Object.defineProperty(page, LIQUID_PROPERTIES, { value: new Set(['id', 'title']) });
  Object.defineProperty(page, LIQUID_HIDDEN, { value: new Set(['secret']) });
  const proxy = withLiquidIdentity(page, 'language-content-id');
  assert.equal(proxy.id, 'root-page-id');
  assert.deepEqual(Object.keys(proxy), Object.keys(page));
  assert.equal(
    await render(
      '{{ page.id }}|{{ page.ID }}|{{ page.Title }}|{{ page.adx_copy }}|{{ page.ADX_COPY }}|{{ page.secret }}|{{ page.callback }}|{{ page.constructor }}|{{ page.__proto__ }}',
      { page: proxy },
    ),
    'language-content-id|language-content-id|Fixture page|Fixture copy|||||',
  );
  assert.equal(page.id, 'root-page-id');
  assert.equal(withLiquidIdentity(page, null), page);
  const context = { page };
  assert.equal(
    await render('{{ page.id }}', applyObservedLiquidObjects(context, { pageIdentity: 'language-content-id' })),
    'language-content-id',
  );
  assert.equal(context.page.id, 'root-page-id');
});
