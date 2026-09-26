import test from 'node:test';
import assert from 'node:assert/strict';
import { postToChatGptFrame } from '../extension/chatgpt-frame.js';

// Live 2026-09-26: opening the panel logged "The target origin provided ('https://chatgpt.com') does
// not match the recipient window's origin ('chrome-extension://…')": the frame still held its first
// about:blank document, which has the extension's own origin.
test('nothing is posted while the frame still holds the extension-origin blank page', () => {
  const sent = [];
  const blank = { location: { href: 'about:blank' }, postMessage: (...args) => sent.push(args) };
  assert.equal(postToChatGptFrame(blank, { type: 'x' }), false);
  assert.deepEqual(sent, []);
});

test('a cross-origin frame (ChatGPT) gets the message, addressed to chatgpt.com only', () => {
  const sent = [];
  const chatgpt = { get location() { throw new Error('SecurityError'); }, postMessage: (...args) => sent.push(args) };
  assert.equal(postToChatGptFrame(chatgpt, { type: 'x' }), true);
  assert.deepEqual(sent, [[{ type: 'x' }, 'https://chatgpt.com']]);
  assert.equal(postToChatGptFrame(null, { type: 'x' }), false);
});

// Live 2026-09-26 (Comet): the panel saves every chatgpt.com page it shows as the page to reopen,
// including /auth/logout and /auth/login after a log-in inside the panel. Every later open then
// logged the shared session out, flashed ChatGPT and jumped to auth.openai.com ("content is blocked").
test('only an ordinary chatgpt.com page is reopened; auth pages and API paths fall back to the home page', async () => {
  const { restorableChatGptUrl } = await import('../extension/chatgpt-frame.js');
  assert.equal(restorableChatGptUrl('https://chatgpt.com/c/abc?x=1#y'), 'https://chatgpt.com/c/abc');
  assert.equal(restorableChatGptUrl('https://chatgpt.com/'), 'https://chatgpt.com/');
  for (const blocked of ['https://chatgpt.com/auth/logout', 'https://chatgpt.com/auth/login', 'https://chatgpt.com/auth', 'https://chatgpt.com/api/auth/session', 'https://chatgpt.com/backend-api/x', 'https://chatgpt.com/cdn/x', 'https://auth.openai.com/log-in', 'https://user:pw@chatgpt.com/', 'not a url', undefined]) {
    assert.equal(restorableChatGptUrl(blocked), null, String(blocked));
  }
});
