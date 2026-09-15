#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { dispatchNativeRequest, loadNativeHostConfig } from '../native/host/docker-dispatch.js';

const configPath = process.env.DEEPSEEK_WEBMCP_CONFIG
  || path.join(os.homedir(), '.deepseek-webmcp', 'p2-native-config.json');

const config = await loadNativeHostConfig(configPath);

const first = await dispatchNativeRequest({
  version: 1,
  id: 'diag_open_1',
  tool: 'open_workspace',
  arguments: { path: '/workspace' },
}, config);

const second = await dispatchNativeRequest({
  version: 1,
  id: 'diag_open_2',
  tool: 'open_workspace',
  arguments: { path: '/workspace' },
}, config);

const firstWorkspaceId = first?.result?.workspaceId ?? null;
const secondWorkspaceId = second?.result?.workspaceId ?? null;

const read = firstWorkspaceId
  ? await dispatchNativeRequest({
      version: 1,
      id: 'diag_read',
      tool: 'read',
      arguments: { workspaceId: firstWorkspaceId, path: 'p2-fixture.txt' },
    }, config)
  : null;

process.stdout.write(`${JSON.stringify({
  config: {
    workspaceRoot: config.canonicalRoot,
    image: config.image,
    runtimeTokenPrefix: config.runtimeToken.slice(0, 12),
  },
  firstOpen: first,
  secondOpen: second,
  sameWorkspaceId: firstWorkspaceId !== null && firstWorkspaceId === secondWorkspaceId,
  readWithFirstWorkspaceId: read,
}, null, 2)}\n`);
