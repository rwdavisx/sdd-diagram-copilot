const { test } = require('node:test');
const assert = require('node:assert');
const { createInputQueue, userMessage, toUiEvents } = require('../sessions');

test('queue yields pushed messages in order, ends on close', async () => {
  const q = createInputQueue();
  q.push('a');
  q.push('b');
  q.close();
  const out = [];
  for await (const m of q) out.push(m);
  assert.deepStrictEqual(out, ['a', 'b']);
});

test('queue delivers messages pushed while a consumer is waiting', async () => {
  const q = createInputQueue();
  const consumer = (async () => {
    for await (const m of q) return m;
  })();
  setImmediate(() => q.push('late'));
  assert.strictEqual(await consumer, 'late');
});

test('push after close is refused', () => {
  const q = createInputQueue();
  q.close();
  assert.strictEqual(q.push('x'), false);
  assert.strictEqual(q.closed, true);
});

test('userMessage wraps text in the SDK user message shape', () => {
  assert.deepStrictEqual(userMessage('hi'), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    parent_tool_use_id: null,
    session_id: '',
  });
});

test('toUiEvents: system init -> session-start', () => {
  const events = toUiEvents({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
  assert.deepStrictEqual(events, [{ kind: 'session-start', sessionId: 's1', model: 'm' }]);
});

test('toUiEvents: assistant text + tool_use blocks', () => {
  const events = toUiEvents({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Thinking about it.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } },
      { type: 'text', text: '   ' },
    ] },
  });
  assert.deepStrictEqual(events, [
    { kind: 'assistant-text', text: 'Thinking about it.' },
    { kind: 'tool-use', name: 'Bash', summary: 'npm test' },
    { kind: 'tool-use', name: 'Edit', summary: 'a.js' },
  ]);
});

test('toUiEvents: result -> turn-end', () => {
  const events = toUiEvents({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5 });
  assert.deepStrictEqual(events, [{ kind: 'turn-end', ok: true, costUsd: 0.5 }]);
});

test('toUiEvents: irrelevant messages produce nothing', () => {
  assert.deepStrictEqual(toUiEvents({ type: 'user' }), []);
  assert.deepStrictEqual(toUiEvents(null), []);
});

const { startSession } = require('../sessions');

function fakeQueryFn(messages, { onPrompt } = {}) {
  return async ({ prompt }) => {
    if (onPrompt) onPrompt(prompt);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

test('startSession relays flattened events and resolves done with the session id', async () => {
  const seen = [];
  const session = startSession({
    initialPrompt: 'go',
    cwd: '.',
    onEvent: (ev) => seen.push(ev),
    queryFn: fakeQueryFn([
      { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'm' },
      { type: 'assistant', session_id: 'sid-1', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'sid-1', total_cost_usd: 0.1 },
    ]),
  });
  const result = await session.done;
  assert.deepStrictEqual(result, { ok: true, sessionId: 'sid-1' });
  assert.deepStrictEqual(seen.map((e) => e.kind), ['session-start', 'assistant-text', 'turn-end']);
});

test('startSession seeds the input stream with the initial prompt', async () => {
  let captured;
  const session = startSession({
    initialPrompt: 'the initial prompt',
    cwd: '.',
    onEvent: () => {},
    queryFn: async ({ prompt }) => {
      const first = await prompt[Symbol.asyncIterator]().next();
      captured = first.value;
      return (async function* () {})();
    },
  });
  await session.done;
  assert.strictEqual(captured.message.content[0].text, 'the initial prompt');
});

test('startSession resolves done with ok:false when the SDK throws', async () => {
  const session = startSession({
    initialPrompt: 'go',
    cwd: '.',
    onEvent: () => {},
    queryFn: async () => { throw new Error('spawn failed'); },
  });
  const result = await session.done;
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /spawn failed/);
});

test('send() after close() is refused', async () => {
  const session = startSession({
    initialPrompt: 'go',
    cwd: '.',
    onEvent: () => {},
    queryFn: fakeQueryFn([]),
  });
  await session.done;
  assert.strictEqual(session.send('more'), false);
});
