import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { encodeNativeMessage, readNativeMessage, MAX_NATIVE_RESPONSE_BYTES } from '../native/host/chrome-framing.js';

test('Chrome Native Messaging frame round-trips one JSON object', async () => {
  const payload = { version: 1, id: 'x', ok: true, result: { text: 'hello' } };
  const stream = new PassThrough();
  stream.end(encodeNativeMessage(payload));
  assert.deepEqual(await readNativeMessage(stream), payload);
});

test('Chrome Native Messaging response cap rejects oversized payloads before stdout', () => {
  const oversized = { result: 'x'.repeat(MAX_NATIVE_RESPONSE_BYTES) };
  assert.throws(() => encodeNativeMessage(oversized), /exceeds/);
});

test('Chrome Native Messaging request cap rejects an oversized declared frame', async () => {
  const stream = new PassThrough();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1025, 0);
  stream.end(header);
  await assert.rejects(readNativeMessage(stream, { maxBytes: 1024 }), /exceeds/);
});
