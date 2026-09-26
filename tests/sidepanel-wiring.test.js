import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = (name) => readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8');
const scripts = (html) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);

// Live 2026-09-25: the ChatGPT panel page loaded sidepanel.js, so loadFrame() never ran (white panel).
test('each Side Panel page loads its own script', async () => {
  assert.deepEqual(scripts(await page('sidepanel-chatgpt.html')), ['sidepanel-chatgpt.js']);
  assert.deepEqual(scripts(await page('sidepanel.html')), ['sidepanel.js']);
});

test('extension pages may frame chatgpt.com, as in the ChatGPT Embedded Panel', async () => {
  const manifest = JSON.parse(await page('manifest.json'));
  assert.equal(manifest.content_security_policy?.extension_pages, "script-src 'self'; object-src 'self'; frame-src https://chatgpt.com;");
});

// Unified Side Panel U1: both pages show the same Provider selector at the top, not in Settings.
test('both Side Panel pages carry the same Provider selector in their header', async () => {
  const selector = '<select id="provider" title="Provider"><option value="chatgpt">ChatGPT</option><option value="deepseek">DeepSeek</option></select>';
  for (const name of ['sidepanel.html', 'sidepanel-chatgpt.html']) {
    const html = await page(name);
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    assert.ok(header.includes(selector), `${name} header has the Provider selector`);
    assert.equal(html.split('id="provider"').length - 1, 1, `${name} has exactly one Provider selector`);
    assert.ok(header.includes('id="model"'), `${name} header has the model line`);
  }
  const chatgpt = await page('sidepanel-chatgpt.html');
  assert.equal(chatgpt.includes('model-requested'), false, 'ChatGPT shows the model actually used, not the requested one');
  assert.equal(chatgpt.includes('model-mismatch'), false, 'no Mismatch without the Requested line it compared against');
});

// C6: the DeepSeek panel's model line carries the mode switches and relays a press to the worker.
test('the DeepSeek model line has mode switches wired to assistant.mode-toggle', async () => {
  const html = await page('sidepanel.html');
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.ok(header.includes('<span id="model-toggles"></span>'), 'switches sit in the model line');
  const script = await page('sidepanel.js');
  assert.match(script, /type: 'assistant\.mode-toggle', label/);
  assert.match(script, /setAttribute\('aria-pressed', String\(toggle\.on\)\)/, 'each switch shows its real state');
});

// Shared files are pinned so drift is caught even when chatgpt-embedded-panel is not beside this worktree.
// frame-policy.js is one provenance line, then the exact shared file, then DeepSeek-only panel helpers.
test('the files copied from the ChatGPT Embedded Panel are unchanged', async () => {
  const { createHash } = await import('node:crypto');
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const pinned = {
    'embedded-chatgpt.js': '42961462cf4f7a91947a639f7e47339b40ef581e587e51ecaa6d40b16fb091c2',
    'model-probe.js': 'e8a93f87988d1703e7c3ee45226a2021f5decc5d8490262931fb7eb3e6f83dca',
    'model-status.js': '2706e620ecda011be7a89304b8cc4a7093c9c33c08f00e87ca8af24edfc1970e',
  };
  for (const [file, hash] of Object.entries(pinned)) assert.equal(sha(await page(file)), hash, `${file} differs from the ChatGPT Embedded Panel`);
  const framePolicy = await page('frame-policy.js');
  const copiedStart = framePolicy.indexOf('\n') + 1;
  assert.equal(sha(framePolicy.slice(copiedStart, copiedStart + 4016)), 'c27368b3799d5dad5e92d6697f5729b54b7ea017144046451b263e22285e1840', 'frame-policy.js no longer holds the copied file');
});
