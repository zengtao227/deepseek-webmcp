import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/model-probe.js', import.meta.url), 'utf8');
const encoder = new TextEncoder();

const delta = (message) => `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message } })}\n\n`;
const ste = (metadata) => `data: ${JSON.stringify({ type: 'server_ste_metadata', metadata })}\n\n`;

const USER_FRAME = delta({ author: { role: 'user' }, content: { parts: ['SECRET QUESTION'] }, metadata: { user_context_message_data: { about_model_message: 'SECRET PERSONALIZATION' } } });
const ASSISTANT_FRAME = delta({ author: { role: 'assistant' }, content: { parts: ['SECRET ANSWER'] }, metadata: { resolved_model_slug: 'gpt-5-6-thinking', model_slug: 'gpt-5-6-thinking', thinking_effort: 'extended' } });
const STE_FRAME = ste({ model_slug: 'gpt-5-6-thinking', requested_model_experience: 'thinking' });
const FULL_STREAM = `event: delta_encoding\ndata: "v1"\n\n${USER_FRAME}${ASSISTANT_FRAME}${STE_FRAME}data: [DONE]\n\n`;

function streamResponse(text, { chunkSize = text.length, contentType = 'text/event-stream; charset=utf-8' } = {}) {
  const bytes = encoder.encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': contentType } });
}

function load({ respond, embedded = true } = {}) {
  const posted = [];
  const window = { postMessage: (message) => posted.push(message) };
  window.top = embedded ? {} : window;
  window.fetch = async (input, init) => respond(input, init);
  const location = {
    origin: 'https://chatgpt.com',
    href: 'https://chatgpt.com/',
    ancestorOrigins: [embedded ? 'chrome-extension://abcdef' : 'https://example.com'],
  };
  const originalFetch = window.fetch;
  vm.runInNewContext(source, { window, location, crypto, TextDecoder, URL, JSON, String, Promise, Object });
  return { window, posted, originalFetch };
}

const idle = () => new Promise((resolve) => setTimeout(resolve, 20));
async function untilTurnEnds(posted) {
  for (let i = 0; i < 100 && !posted.some((m) => m.type === 'turn_end'); i += 1) await idle();
}

const post = (body = { model: 'gpt-5-6-thinking', thinking_effort: 'extended' }) => ({ method: 'POST', body: JSON.stringify(body) });
const CONVERSATION = 'https://chatgpt.com/backend-api/f/conversation';
const types = (posted) => posted.map((m) => m.type);

test('extracts the real server model and the explicit requested model from a real-shaped stream', async () => {
  const { window, posted } = load({ respond: () => streamResponse(FULL_STREAM) });
  await window.fetch(CONVERSATION, post());
  await untilTurnEnds(posted);

  assert.deepEqual(types(posted), ['turn_start', 'model', 'effort', 'model', 'turn_end']);
  assert.equal(posted[0].requestedModel, 'gpt-5-6-thinking');
  assert.equal(posted[0].requestedEffort, 'extended');
  const effort = posted.find((m) => m.type === 'effort');
  assert.deepEqual([effort.actualEffort, effort.sourceField], ['extended', 'message.metadata.thinking_effort']);
  const models = posted.filter((m) => m.type === 'model');
  assert.deepEqual(models.map((m) => m.sourceField), ['message.metadata.resolved_model_slug', 'server_ste_metadata.model_slug']);
  assert.equal(models.at(-1).actualModel, 'gpt-5-6-thinking');
  assert.equal(new Set(posted.map((m) => m.turnId)).size, 1);
});

test('never emits answer text, question text or personalization text', async () => {
  const { window, posted } = load({ respond: () => streamResponse(FULL_STREAM) });
  await window.fetch(CONVERSATION, post({ model: 'gpt-5-6-thinking', messages: [{ content: 'SECRET QUESTION' }] }));
  await untilTurnEnds(posted);

  const serialized = JSON.stringify(posted);
  for (const secret of ['SECRET ANSWER', 'SECRET QUESTION', 'SECRET PERSONALIZATION', 'about_model_message']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const message of posted) {
    assert.deepEqual(Object.keys(message).filter((key) => !['source', 'type', 'turnId', 'requestedModel', 'requestedEffort', 'actualModel', 'actualEffort', 'sourceField'].includes(key)), []);
  }
});

test('parses frames that arrive split across arbitrary chunks', async () => {
  const { window, posted } = load({ respond: () => streamResponse(FULL_STREAM, { chunkSize: 7 }) });
  await window.fetch(CONVERSATION, post());
  await untilTurnEnds(posted);

  assert.equal(posted.filter((m) => m.type === 'model').at(-1).actualModel, 'gpt-5-6-thinking');
});

test('reports requested and actual separately when they differ', async () => {
  const stream = `${ASSISTANT_FRAME.replaceAll('gpt-5-6-thinking', 'gpt-5-5-mini')}${ste({ model_slug: 'gpt-5-5-mini' })}`;
  const { window, posted } = load({ respond: () => streamResponse(stream) });
  await window.fetch(CONVERSATION, post({ model: 'gpt-5-6-thinking' }));
  await untilTurnEnds(posted);

  assert.equal(posted[0].requestedModel, 'gpt-5-6-thinking');
  assert.equal(posted.filter((m) => m.type === 'model').at(-1).actualModel, 'gpt-5-5-mini');
});

test('a stream with no model metadata emits no model event', async () => {
  const { window, posted } = load({ respond: () => streamResponse(`${USER_FRAME}data: [DONE]\n\n`) });
  await window.fetch(CONVERSATION, post());
  await untilTurnEnds(posted);

  assert.deepEqual(types(posted), ['turn_start', 'turn_end']);
});

test('effort is reported once per value, from assistant messages only, and only when the server sent it', async () => {
  const repeated = ASSISTANT_FRAME + ASSISTANT_FRAME;
  const forged = delta({ author: { role: 'user' }, metadata: { thinking_effort: 'forged' } });
  const none = delta({ author: { role: 'assistant' }, metadata: { resolved_model_slug: 'gpt-5-6-thinking' } });

  const withEffort = load({ respond: () => streamResponse(`${forged}${repeated}data: [DONE]\n\n`) });
  await withEffort.window.fetch(CONVERSATION, post());
  await untilTurnEnds(withEffort.posted);
  assert.deepEqual(withEffort.posted.filter((m) => m.type === 'effort').map((m) => m.actualEffort), ['extended']);

  const without = load({ respond: () => streamResponse(`${none}data: [DONE]\n\n`) });
  await without.window.fetch(CONVERSATION, post());
  await untilTurnEnds(without.posted);
  assert.equal(without.posted.some((m) => m.type === 'effort'), false);
});

test('the request effort is read from the real request body, and prompt text is not', async () => {
  const { window, posted } = load({ respond: () => streamResponse(`data: [DONE]\n\n`) });
  await window.fetch(CONVERSATION, post({ model: 'gpt-5-6-thinking', thinking_effort: 'standard', messages: [{ content: 'SECRET QUESTION' }] }));
  await untilTurnEnds(posted);
  assert.equal(posted[0].requestedEffort, 'standard');
  assert.equal(JSON.stringify(posted).includes('SECRET QUESTION'), false);
});

test('a user-authored message carrying a model slug is not a source', async () => {
  const forged = delta({ author: { role: 'user' }, metadata: { resolved_model_slug: 'forged-model' } });
  const { window, posted } = load({ respond: () => streamResponse(`${forged}data: [DONE]\n\n`) });
  await window.fetch(CONVERSATION, post());
  await untilTurnEnds(posted);

  assert.deepEqual(types(posted), ['turn_start', 'turn_end']);
});

test('server_ste_metadata outranks the per-message fallback, never the reverse', async () => {
  const stream = `${ste({ model_slug: 'from-ste' })}${delta({ author: { role: 'assistant' }, metadata: { resolved_model_slug: 'from-message' } })}`;
  const { window, posted } = load({ respond: () => streamResponse(stream) });
  await window.fetch(CONVERSATION, post());
  await untilTurnEnds(posted);

  const models = posted.filter((m) => m.type === 'model');
  assert.deepEqual(models.map((m) => m.actualModel), ['from-ste']);
});

test('the page still receives the complete untouched response body', async () => {
  const { window, posted } = load({ respond: () => streamResponse(FULL_STREAM, { chunkSize: 11 }) });
  const response = await window.fetch(CONVERSATION, post());
  assert.equal(await response.text(), FULL_STREAM);
  await untilTurnEnds(posted);
});

test('non-conversation requests and other methods never touch state', async () => {
  const seen = [];
  const { window, posted } = load({ respond: (input) => { seen.push(String(input)); return streamResponse(FULL_STREAM); } });
  await window.fetch('https://chatgpt.com/backend-api/me', post());
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'GET' });
  await window.fetch('https://chatgpt.com/backend-api/f/conversation/abc/stream_status', post());
  await window.fetch('https://example.com/backend-api/f/conversation', post());
  await idle();

  assert.equal(seen.length, 4);
  assert.deepEqual(posted, []);
});

test('a non-stream or failed conversation response ends the turn without a model', async () => {
  const json = load({ respond: () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
  await json.window.fetch(CONVERSATION, post());
  assert.deepEqual(types(json.posted), ['turn_start', 'turn_end']);

  const failing = load({ respond: () => Promise.reject(new Error('offline')) });
  await assert.rejects(failing.window.fetch(CONVERSATION, post()), /offline/);
  assert.deepEqual(types(failing.posted), ['turn_start', 'turn_end']);
});

test('the hook is not installed outside the extension-embedded frame', () => {
  const top = load({ embedded: false, respond: () => streamResponse(FULL_STREAM) });
  assert.equal(top.window.fetch, top.originalFetch);
});
