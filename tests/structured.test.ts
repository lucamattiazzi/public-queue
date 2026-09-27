import test from 'node:test';
import assert from 'node:assert/strict';
import { chatSchema } from '../packages/protocol/src/index.js';

test('preserves bounded JSON output and thinking controls for compatible local models', () => {
  const request = {
    model: 'qwen-flash-next', messages: [{ role: 'user', content: 'Compile this coach' }],
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'program', strict: true,
      schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false } } },
  };
  assert.deepEqual(chatSchema.parse(request), request);
  assert.equal(chatSchema.safeParse({ ...request, chat_template_kwargs: { arbitrary: 'not allowed' } }).success, false);
  assert.equal(chatSchema.safeParse({ ...request, response_format: { type: 'execute' } }).success, false);
});
