import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from '../packages/server/src/app.js';
test('built website serves landing, login, dashboard, legal pages and downloadable packages', async () => {
  const { app } = await createServer({ database: ':memory:', adminToken: 's'.repeat(40), webRoot: resolve('dist/web'), saas: { publicUrl: 'https://queue.example.com', operator: { name: 'Example', address: 'Address', email: 'hello@example.com', taxId: 'ID' } } });
  try {
    for (const [url, expected] of [['/', 'Beyond'], ['/login/', 'email-form'], ['/app/', 'account-panel'], ['/console/', 'owner-key'], ['/legal/', 'Privacy notice']]) {
      const result = await app.inject({ url: url! }); assert.equal(result.statusCode, 200, url); assert.ok(result.body.includes(expected!), url);
      assert.match(result.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
      assert.ok(result.body.includes('<script defer data-domain="jobboard.grokked.it" src="https://check.grokked.it/js/script.js"></script>'), `${url}: Plausible snippet`);
      assert.match(result.headers['content-security-policy'] as string, /script-src 'self' https:\/\/check\.grokked\.it\/js\/script\.js;/);
    }
    for (const url of ['/site.js', '/app.js', '/site.css', '/sdk.js', '/downloads/sdk.tgz', '/downloads/agent.tgz', '/downloads/source.tgz']) assert.equal((await app.inject({ url })).statusCode, 200, url);
    assert.equal((await app.inject({ url: '/.env' })).statusCode, 404);
    const config = (await app.inject({ url: '/v1/public' })).json(); assert.equal(config.signupEnabled, false); assert.equal(config.billingEnabled, false);
  } finally { await app.close(); }
});
