#!/usr/bin/env node
import { readNativeMessage, writeNativeMessage, MAX_NATIVE_RESPONSE_BYTES } from './chrome-framing.js';
import { dispatchNativeRequest, loadNativeHostConfig, toNativeError } from './docker-dispatch.js';
import { handleControlRequest } from './control.js';
import { dispatchHostCommand } from './host-access.js';

async function main() {
  let request = null;
  try {
    request = await readNativeMessage(process.stdin);
    const configPath = process.env.DEEPSEEK_WEBMCP_CONFIG;
    // Owner settings from the popup never go through the tool dispatcher and vice versa.
    const response = request && typeof request === 'object' && Object.hasOwn(request, 'control')
      ? await handleControlRequest(request, { configFile: configPath })
      : request?.tool === 'host_command'
        ? await dispatchHostCommand(request, { configFile: configPath })
        : await dispatchNativeRequest(request, await loadNativeHostConfig(configPath));
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
