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
