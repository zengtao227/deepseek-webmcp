import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(target));
    else if (entry.isFile() && target.endsWith('.js')) files.push(target);
  }
  return files;
}

test('P2 extension uses one-shot Native Messaging without DeepSeek credential access', async () => {
  const files = await collect('extension');
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.match(source, /sendNativeMessage/);
  assert.doesNotMatch(source, /connectNative/);
  assert.doesNotMatch(source, /chrome\.cookies|document\.cookie/i);
  assert.doesNotMatch(source, /authorization|bearer\s/i);
  assert.match(source, /chrome\.storage\.session/);
  assert.doesNotMatch(source, /chrome\.storage\.local/);
});

test('P2 extension neither hooks nor originates DeepSeek network traffic', async () => {
  const files = await collect('extension');
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /window\.fetch|\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest|EventSource|WebSocket/);
  assert.doesNotMatch(source, /\/api\/v0\//);
  assert.doesNotMatch(source, /webRequest|chrome\.debugger|world:\s*['"]MAIN/);
});

test('tool results reach the page only through the normal composer and Send control', async () => {
  const source = await readFile('extension/content.js', 'utf8');
  assert.match(source, /HTMLTextAreaElement\.prototype, 'value'/);
  assert.match(source, /control\.click\(\)/);
  assert.match(source, /ds-assistant-message-main-content/);
});
