#!/usr/bin/env node
import { readNativeMessage, writeNativeMessage, MAX_NATIVE_RESPONSE_BYTES } from './chrome-framing.js';
import { dispatchNativeRequest, loadNativeHostConfig, toNativeError } from './docker-dispatch.js';

async function main() {
  let request = null;
  try {
    request = await readNativeMessage(process.stdin);
    const configPath = process.env.DEEPSEEK_WEBMCP_CONFIG;
    const config = await loadNativeHostConfig(configPath);
    const response = await dispatchNativeRequest(request, config);
    writeNativeMessage(process.stdout, response, { maxBytes: MAX_NATIVE_RESPONSE_BYTES });
  } catch (error) {
    const response = toNativeError(request?.id, error);
    try {
      writeNativeMessage(process.stdout, response, { maxBytes: MAX_NATIVE_RESPONSE_BYTES });
    } catch {
      process.exitCode = 1;
    }
  }
}

await main();
