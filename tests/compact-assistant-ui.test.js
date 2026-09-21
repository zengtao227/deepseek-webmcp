import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const [popup, sidepanel, content, background, manifestText] = await Promise.all([
  readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/content.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/background.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText);

test('Compact Assistant opens the Side Panel inside the direct popup click path before provider startup can await', () => {
  const open = popup.indexOf('chrome.sidePanel.open({ tabId: tab.id })');
  const start = popup.indexOf("chrome.runtime.sendMessage({ type: 'assistant.open' })");
  assert.ok(open >= 0);
  assert.ok(start > open);
  assert.match(popup, /#assistant'\)\.addEventListener\('click', \(\) =>/);
});

test('Compact Assistant panel is a local extension resource and renders provider text without HTML injection', () => {
  assert.equal(manifest.side_panel?.default_path, 'sidepanel.html');
  assert.equal(manifest.permissions.includes('sidePanel'), true);
  assert.doesNotMatch(sidepanel, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(sidepanel, /textContent/);
  assert.match(sidepanel, /assistant\.prompt/);
  assert.match(sidepanel, /assistant\.restore/);
  assert.match(sidepanel, /assistant\.stop/);
});

test('Compact Assistant mirrors only provider-visible DeepSeek DOM and keeps exact provider binding fail-closed', () => {
  assert.match(content, /REASONING_SELECTOR = '\.ds-think-content'/);
  assert.match(content, /assistant\.snapshot/);
  assert.match(content, /assistant\.health/);
  assert.match(background, /NOT_BOUND_PROVIDER/);
  assert.match(background, /session\.providerTabId !== tabId/);
});

const [answerRender, answerBlocks] = await Promise.all([
  readFile(new URL('../extension/answer-render.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/answer-blocks.js', import.meta.url), 'utf8'),
]);

test('answer actions: Copy on every finished answer, Regenerate and Share on the latest one, all sent through the background worker', () => {
  assert.match(sidepanel, /actionButton\('Copy'/);
  assert.match(sidepanel, /actionButton\('Regenerate'/);
  assert.match(sidepanel, /actionButton\('Share'/);
  assert.match(sidepanel, /type: 'assistant\.action', action/);
  // History entries get Copy only: DeepSeek's Regenerate/Share act on its latest reply.
  assert.match(sidepanel, /renderActions\(actions, \{ text: answerCopyText\(text, blocks\), provider: false \}\)/);
  assert.match(sidepanel, /clipboard\.writeText/);
  assert.equal(manifest.permissions.includes('clipboardWrite'), false);
});

test('the polled panel only rebuilds history and the answer when they change, so action clicks are not lost', () => {
  assert.match(sidepanel, /signature === lastHistorySignature\) return/);
  assert.match(sidepanel, /answerSignature !== lastAnswerSignature/);
});

test('answer rendering modules never parse HTML and the panel does not import DeepSeek styling', () => {
  for (const source of [answerRender, answerBlocks]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser/);
  }
  assert.doesNotMatch(answerRender, /className\s*=\s*['"]ds-/);
  assert.match(content, /assistant\.action/);
  assert.match(background, /assistant\.action/);
  assert.match(background, /sidePanel && message\.type === 'assistant\.action'/);
});

test('a failed answer action shows its diagnostic in the panel as copyable text, and clears it on success', () => {
  assert.match(sidepanel, /showDiagnostic\(response\?\.ok \? null : response\?\.diagnostics\)/);
  assert.match(sidepanel, /\$\('#diagnostic-text'\)\.textContent = JSON\.stringify\(diagnostics, null, 2\)/);
  assert.match(sidepanel, /\$\('#diagnostic-copy'\)\.addEventListener\('click'/);
  assert.match(sidepanel, /copyText\(\$\('#diagnostic-text'\)\.textContent/);
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="diagnostic" hidden>/);
  assert.match(html, /id="diagnostic-copy"/);
  assert.equal(manifest.permissions.includes('clipboardWrite'), false);
});
