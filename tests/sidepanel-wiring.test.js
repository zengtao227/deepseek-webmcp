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
