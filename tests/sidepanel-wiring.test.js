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
