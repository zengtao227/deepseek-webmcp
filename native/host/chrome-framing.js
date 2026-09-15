import os from 'node:os';

export const MAX_NATIVE_REQUEST_BYTES = 1024 * 1024;
export const MAX_NATIVE_RESPONSE_BYTES = 512 * 1024;

const littleEndian = os.endianness() === 'LE';

function readLength(buffer) {
  return littleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
}

function writeLength(buffer, value) {
  if (littleEndian) buffer.writeUInt32LE(value, 0);
  else buffer.writeUInt32BE(value, 0);
}

export function encodeNativeMessage(payload, { maxBytes = MAX_NATIVE_RESPONSE_BYTES } = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.byteLength > maxBytes) {
    throw new Error('Native message exceeds the configured response limit.');
  }
  const header = Buffer.allocUnsafe(4);
  writeLength(header, body.byteLength);
  return Buffer.concat([header, body]);
}

export async function readNativeMessage(stream, { maxBytes = MAX_NATIVE_REQUEST_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffer.byteLength < 4) continue;
    const length = readLength(buffer.subarray(0, 4));
    if (length > maxBytes) throw new Error('Native message exceeds the configured request limit.');
    if (buffer.byteLength < 4 + length) continue;
    const body = buffer.subarray(4, 4 + length).toString('utf8');
    return JSON.parse(body);
  }
  throw new Error('Native message ended before one complete frame was received.');
}

export function writeNativeMessage(stream, payload, options) {
  stream.write(encodeNativeMessage(payload, options));
}
