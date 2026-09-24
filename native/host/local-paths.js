import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const HOST_NAME = 'com.deepseek.webmcp.native';
// Build, uninstall and cleanup all use this one tag. A rehearsal on a machine that also has
// a live install sets its own tag, because moving a tag can delete the image it named.
export const IMAGE_TAG = process.env.DEEPSEEK_WEBMCP_IMAGE_TAG || 'deepseek-webmcp-p2:dev';
// Created by install.sh in the program folder it unpacked; only such a folder is deleted on uninstall.
export const INSTALL_MARKER = '.deepseek-webmcp-installed';

// Chromium browsers each read Native Messaging manifests from their own profile root
// (macOS: ~/Library/Application Support/<root>/NativeMessagingHosts).
const CHROMIUM_PROFILE_ROOTS = [
  'Google/Chrome',
  'Google/Chrome Beta',
  'Google/Chrome Canary',
  'Chromium',
  'Comet',
  'Arc/User Data',
  'BraveSoftware/Brave-Browser',
  'Microsoft Edge',
  'Vivaldi',
];

export function stateDir(home = os.homedir()) {
  return path.join(home, '.deepseek-webmcp');
}

export function configPath(home = os.homedir()) {
  return path.join(stateDir(home), 'p2-native-config.json');
}

export function leasePath(home = os.homedir()) {
  return path.join(stateDir(home), 'full-access.json');
}

export function browserProfileRoots(home = os.homedir()) {
  return CHROMIUM_PROFILE_ROOTS.map((root) => path.join(home, 'Library/Application Support', root));
}

export function manifestDirFor(profileRoot) {
  return path.join(profileRoot, 'NativeMessagingHosts');
}

export async function installedBrowserProfileRoots(home = os.homedir()) {
  const roots = [];
  for (const root of browserProfileRoots(home)) {
    if (await access(root).then(() => true, () => false)) roots.push(root);
  }
  return roots;
}

// Hidden inside the container during Full access: anything that runs on the host
// outside the container (control plane, shell startup, login items) and credential
// stores. Base v1.1 masks its control plane the same way.
export function fullAccessMaskCandidates({ home = os.homedir(), hostCodeRoot, nodePath }) {
  return [
    hostCodeRoot,
    stateDir(home),
    path.dirname(nodePath),
    path.join(home, '.config/webmcp'),
    path.join(home, '.local/share/webmcp'),
    path.join(home, '.config/tunnel-client'),
    path.join(home, '.local/share/prism-webmcp'),
    path.join(home, '.prism-webmcp'),
    path.join(home, '.chatgpt-embedded-panel'),
    path.join(home, '.docker'),
    ...browserProfileRoots(home),
    path.join(home, 'Library/Keychains'),
    path.join(home, 'Library/Cookies'),
    path.join(home, 'Library/LaunchAgents'),
    path.join(home, 'Library/Safari'),
    path.join(home, 'Library/Application Support/Firefox'),
    path.join(home, 'Library/Application Support/tunnel-client'),
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.kube'),
    path.join(home, '.config/gh'),
    path.join(home, '.netrc'),
    path.join(home, '.git-credentials'),
    path.join(home, '.npmrc'),
    path.join(home, '.zshrc'),
    path.join(home, '.zprofile'),
    path.join(home, '.zshenv'),
    path.join(home, '.zsh_history'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.bash_history'),
    path.join(home, '.profile'),
  ];
}
