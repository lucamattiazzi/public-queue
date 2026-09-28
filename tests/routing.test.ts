import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRouting, resolveDestination, routingSchema } from '../packages/agent/src/routing.js';

const legacy = { runtimeUrl: 'http://127.0.0.1:9090/v1', models: ['qwen'], runtimeKey: 'LOCAL_SECRET' };
test('legacy configurations retain explicit selection and map fast/quality to their first model', () => {
  const routing = effectiveRouting(legacy);
  for (const model of ['qwen', 'profile:fast', 'profile:quality']) {
    const result = resolveDestination(model, routing);
    assert.equal(result.model, 'qwen'); assert.equal(result.runtimeKey, 'LOCAL_SECRET');
  }
  assert.throws(() => resolveDestination('profile:vision', routing), /Profile is not configured/);
  assert.throws(() => resolveDestination('other', routing), /Model is not allowed/);
});
test('profiles resolve one registered endpoint; cloud requires explicit approval and never acts as fallback', () => {
  const routing = routingSchema.parse({ destinations: [
    { id: 'small', name: 'Local', kind: 'local', model: 'small', runtimeUrl: legacy.runtimeUrl },
    { id: 'remote', name: 'Cloud', kind: 'cloud', model: 'remote', runtimeUrl: 'https://provider.example/v1', runtimeKey: 'CLOUD_SECRET' },
  ], profiles: { fast: 'small', quality: 'remote', cloud: 'remote' } });
  assert.equal(resolveDestination('profile:fast', routing).id, 'small');
  assert.throws(() => resolveDestination('profile:quality', routing), /Cloud destination requires explicit approval/);
  assert.throws(() => resolveDestination('remote', routing), /Cloud destination requires explicit approval/);
  assert.throws(() => resolveDestination('profile:vision', routing), /Profile is not configured/);
  routing.destinations[1]!.cloudApproved = true;
  assert.equal(resolveDestination('profile:quality', routing).runtimeKey, 'CLOUD_SECRET');
});
test('configuration rejects broken references and duplicate ids; ambiguous explicit model names require a profile', () => {
  const a = { id: 'a', name: 'A', model: 'same', kind: 'local', runtimeUrl: legacy.runtimeUrl };
  assert.throws(() => routingSchema.parse({ destinations: [a, a], profiles: {} }));
  assert.throws(() => routingSchema.parse({ destinations: [a], profiles: { fast: 'missing' } }));
  assert.throws(() => routingSchema.parse({ destinations: [a], profiles: { cloud: 'a' } }));
  assert.throws(() => routingSchema.parse({ destinations: [{ ...a, runtimeUrl: 'https://user:password@example.com/v1' }], profiles: {} }));
  const routing = routingSchema.parse({ destinations: [a, { ...a, id: 'b' }], profiles: { fast: 'b' } });
  assert.throws(() => resolveDestination('same', routing), /multiple destinations/);
  assert.equal(resolveDestination('profile:fast', routing).id, 'b');
});
