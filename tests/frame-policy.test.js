import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_SANDBOX_CSP,
  buildFramePolicyRule,
  buildSandboxFramePolicyRule,
  panelFrameHref,
} from '../extension/frame-policy.js';

test('the frame rule (ChatGPT Embedded Panel copy) only strips framing headers for ChatGPT frames this extension loads', () => {
  const rule = buildFramePolicyRule('abcdefghijklmnopabcdefghijklmnop');
  assert.deepEqual(rule.condition, { requestDomains: ['chatgpt.com'], initiatorDomains: ['abcdefghijklmnopabcdefghijklmnop'], resourceTypes: ['sub_frame'] });
  assert.deepEqual(rule.action.responseHeaders.map((header) => [header.header, header.operation]), [
    ['x-frame-options', 'remove'],
    ['content-security-policy', 'remove'],
  ]);
});

test('visualization rule matches the live OpenAI sandbox CSP and only adds this extension as an ancestor', async () => {
  const { readFile } = await import('node:fs/promises');
  // Captured from https://codex-inline-visualization-*.web-sandbox.oaiusercontent.com/ on 2026-09-26.
  const live = await readFile(new URL('./fixtures/openai-sandbox-csp-2026-09-26.txt', import.meta.url), 'utf8');
  assert.equal(OPENAI_SANDBOX_CSP, live);
  const runtimeId = 'abcdefghijklmnopabcdefghijklmnop';
  const rule = buildSandboxFramePolicyRule(runtimeId);
  assert.deepEqual(rule.condition.requestDomains, ['web-sandbox.oaiusercontent.com']);
  assert.deepEqual(rule.condition.initiatorDomains, ['chatgpt.com', 'web-sandbox.oaiusercontent.com']);
  assert.deepEqual(rule.condition.resourceTypes, ['sub_frame']);
  assert.equal(rule.condition.regexFilter, '^https://codex-inline-visualization-[a-f0-9]+\\.web-sandbox\\.oaiusercontent\\.com/');
  assert.deepEqual(rule.condition.responseHeaders, [{ header: 'content-security-policy', values: [live] }]);
  assert.equal(rule.action.responseHeaders[0].operation, 'set');
  const before = live.split('; ');
  const after = rule.action.responseHeaders[0].value.split('; ');
  assert.equal(after.length, before.length);
  before.forEach((directive, index) => assert.equal(after[index], directive.startsWith('frame-ancestors ')
    ? `${directive} chrome-extension://${runtimeId}`
    : directive));
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
