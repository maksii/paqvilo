import test from 'node:test';
import assert from 'node:assert/strict';
import { connectRuntime } from '../testing/runtime.mjs';

test('configured sign-in validates contacts before POST and preserves membership/override roles', async () => {
  for (const identity of [undefined, { roles: ['Reader'] }, { contactId: 'member', roles: ['stale'], roleSource: 'memberships' }, { id: 'override', roles: ['Reader'], roleSource: 'override' }]) {
    const posts = [];
    const fetchImpl = async (url, options) => {
      if (options.method === 'POST') posts.push(JSON.parse(options.body));
      return new Response(JSON.stringify(url.endsWith('/status') ? {} : url.endsWith('/state?summary=1') ? { csrf: 'synthetic', config: { identity } } : { signedIn: true }), { headers: { 'content-type': 'application/json' } });
    };
    const runtime = await connectRuntime({ origin: 'http://127.0.0.1:8787', fetchImpl });
    if (!identity?.contactId && !identity?.id) {
      await assert.rejects(runtime.signIn(null, { configuredPersona: true }), error => error.code === 'MISSING_PERSONA_CONTACT' && /configured persona contact/.test(error.message));
      let contextPosts = 0;
      await assert.rejects(runtime.signIn({ request: { post() { contextPosts++; } } }, { configuredPersona: true }), { code: 'MISSING_PERSONA_CONTACT' });
      assert.equal(contextPosts, 0); assert.deepEqual(posts, []);
    } else {
      await runtime.signIn(null, { configuredPersona: true });
      assert.deepEqual(posts, [{ contactId: identity.contactId ?? identity.id, ...(identity.roleSource === 'override' ? { roles: identity.roles } : {}) }]);
      posts.length = 0;
      await runtime.signIn(null, { configuredPersona: true, contactId: 'explicit', roles: [] });
      assert.deepEqual(posts, [{ contactId: 'explicit', roles: [] }]);
    }
  }
});
