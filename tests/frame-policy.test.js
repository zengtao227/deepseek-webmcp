import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFramePolicyRule, panelFrameHref } from '../extension/frame-policy.js';

test('the frame rule (ChatGPT Embedded Panel copy) only strips framing headers for ChatGPT frames this extension loads', () => {
  const rule = buildFramePolicyRule('abcdefghijklmnopabcdefghijklmnop');
  assert.deepEqual(rule.condition, { requestDomains: ['chatgpt.com'], initiatorDomains: ['abcdefghijklmnopabcdefghijklmnop'], resourceTypes: ['sub_frame'] });
  assert.deepEqual(rule.action.responseHeaders.map((header) => [header.header, header.operation]), [
    ['x-frame-options', 'remove'],
    ['content-security-policy', 'remove'],
  ]);
});

test('only a tab-less chatgpt.com frame reporting its own origin counts as the panel frame', () => {
  const panel = { origin: 'https://chatgpt.com', frameId: 1 };
  assert.equal(panelFrameHref(panel, 'https://chatgpt.com/c/abc'), 'https://chatgpt.com/c/abc');
  assert.equal(panelFrameHref({ ...panel, tab: { id: 3 } }, 'https://chatgpt.com/c/abc'), null);
  assert.equal(panelFrameHref({ ...panel, origin: 'https://evil.example' }, 'https://chatgpt.com/c/abc'), null);
  assert.equal(panelFrameHref(panel, 'https://chat.deepseek.com/a/chat/s/x'), null);
  assert.equal(panelFrameHref(panel, 'not a url'), null);
  assert.equal(panelFrameHref(panel, undefined), null);
});
