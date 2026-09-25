import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beginInstall, guardTagFor } from '../native/host/install-rollback.js';

const TAG = 'deepseek-webmcp-p2:dev';
const OLD_IMAGE = `sha256:${'a'.repeat(64)}`;

// A fake docker that records calls; `present` lists images that exist, `failing` names calls
// that fail (by their first two arguments).
function fakeDocker({ present = [OLD_IMAGE], failing = [] } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push(args.join(' '));
    if (failing.includes(args.slice(0, 2).join(' '))) throw new Error(`docker ${args.join(' ')} failed`);
    if (args[0] === 'image' && args[1] === 'inspect' && !present.includes(args[2])) throw new Error('No such image');
    return { stdout: '' };
  };
  return { exec, calls };
}

async function withFiles(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deepseek-rollback-'));
  try {
    const config = path.join(root, 'state', 'config.json');
    const launcher = path.join(root, 'state', 'launcher');
    const manifest = path.join(root, 'browser', 'NativeMessagingHosts', 'host.json');
    const imagePin = path.join(root, 'instance', 'native-image.json');
    const releasePin = path.join(root, 'instance', 'host-release.json');
    await mkdir(path.dirname(config), { recursive: true });
    await mkdir(path.dirname(imagePin), { recursive: true });
    await writeFile(config, '{"image":"old"}\n', { mode: 0o600 });
    await writeFile(launcher, '#!/bin/sh\nold\n', { mode: 0o755 });
    await writeFile(imagePin, 'old-pin\n');
    await writeFile(releasePin, 'old-release\n');
    // The manifest does not exist yet: this install would be the first to write it.
    await run({ root, files: [config, launcher, manifest, imagePin, releasePin], config, launcher, manifest, imagePin, releasePin });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Every write an install makes, as install-p2-native-host.mjs does them.
async function writeNewInstall({ config, launcher, manifest, imagePin, releasePin }) {
  await writeFile(config, '{"image":"new"}\n', { mode: 0o644 });
  await writeFile(launcher, '#!/bin/sh\nnew\n', { mode: 0o700 });
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, 'new-manifest\n');
  await writeFile(imagePin, 'new-pin\n');
  await writeFile(releasePin, 'new-release\n');
}

test('a failed update puts every instance file back and keeps the previous image usable', async () => {
  await withFiles(async (files) => {
    const docker = fakeDocker();
    const install = await beginInstall({ files: files.files, previousImage: OLD_IMAGE, imageTag: TAG, dockerPath: 'docker', exec: docker.exec });
    assert.deepEqual(docker.calls, [`image inspect ${OLD_IMAGE}`, `tag ${OLD_IMAGE} ${guardTagFor(TAG)}`]);
    await writeNewInstall(files);
    await install.rollback();
    assert.equal(await readFile(files.config, 'utf8'), '{"image":"old"}\n');
    assert.equal((await stat(files.config)).mode & 0o777, 0o600);
    assert.equal(await readFile(files.launcher, 'utf8'), '#!/bin/sh\nold\n');
    assert.equal((await stat(files.launcher)).mode & 0o777, 0o755);
    assert.equal(await readFile(files.imagePin, 'utf8'), 'old-pin\n');
    assert.equal(await readFile(files.releasePin, 'utf8'), 'old-release\n');
    await assert.rejects(stat(files.manifest), { code: 'ENOENT' }, 'a file this install created is removed');
    // The tag goes back to the previous image, then the guard tag is dropped.
    assert.deepEqual(docker.calls.slice(2), [`tag ${OLD_IMAGE} ${TAG}`, `image rm ${guardTagFor(TAG)}`]);
  });
});

test('a failure at any write boundary restores the same previous state', async () => {
  for (let step = 0; step <= 5; step += 1) {
    await withFiles(async (files) => {
      const docker = fakeDocker();
      const install = await beginInstall({ files: files.files, previousImage: OLD_IMAGE, imageTag: TAG, dockerPath: 'docker', exec: docker.exec });
      const writes = [
        () => writeFile(files.imagePin, 'new-pin\n'),
        () => writeFile(files.config, '{"image":"new"}\n'),
        () => writeFile(files.launcher, 'new\n'),
        async () => { await mkdir(path.dirname(files.manifest), { recursive: true }); await writeFile(files.manifest, 'new\n'); },
        () => writeFile(files.releasePin, 'new-release\n'),
      ];
      for (const write of writes.slice(0, step)) await write();
      await install.rollback();
      assert.equal(await readFile(files.config, 'utf8'), '{"image":"old"}\n', `step ${step}`);
      assert.equal(await readFile(files.imagePin, 'utf8'), 'old-pin\n', `step ${step}`);
      assert.equal(await readFile(files.releasePin, 'utf8'), 'old-release\n', `step ${step}`);
      await assert.rejects(stat(files.manifest), { code: 'ENOENT' }, `step ${step}`);
    });
  }
});

test('a completed install drops only the guard tag', async () => {
  await withFiles(async (files) => {
    const docker = fakeDocker();
    const install = await beginInstall({ files: files.files, previousImage: OLD_IMAGE, imageTag: TAG, dockerPath: 'docker', exec: docker.exec });
    await writeNewInstall(files);
    await install.commit();
    assert.equal(await readFile(files.config, 'utf8'), '{"image":"new"}\n');
    assert.deepEqual(docker.calls.slice(2), [`image rm ${guardTagFor(TAG)}`]);
  });
});

test('a fresh install that fails leaves no instance files and touches no image', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deepseek-rollback-fresh-'));
  try {
    const config = path.join(root, 'config.json');
    const docker = fakeDocker();
    const install = await beginInstall({ files: [config], previousImage: null, imageTag: TAG, dockerPath: 'docker', exec: docker.exec });
    await writeFile(config, 'new\n');
    await install.rollback();
    await assert.rejects(stat(config), { code: 'ENOENT' });
    assert.deepEqual(docker.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a previous image Docker no longer has needs no guard', async () => {
  await withFiles(async (files) => {
    const docker = fakeDocker({ present: [] });
    const install = await beginInstall({ files: files.files, previousImage: OLD_IMAGE, imageTag: TAG, dockerPath: 'docker', exec: docker.exec });
    await install.rollback();
    assert.deepEqual(docker.calls, [`image inspect ${OLD_IMAGE}`]);
  });
});

test('if the previous image cannot be guarded, nothing is written and the install stops', async () => {
  await withFiles(async (files) => {
    const docker = fakeDocker({ failing: [`tag ${OLD_IMAGE}`] });
    await assert.rejects(
      beginInstall({ files: files.files, previousImage: OLD_IMAGE, imageTag: TAG, dockerPath: 'docker', exec: docker.exec }),
      /failed/,
    );
    assert.equal(await readFile(files.config, 'utf8'), '{"image":"old"}\n');
  });
});

test('rollback runs every step even when one fails, then reports the first failure', async () => {
  await withFiles(async (files) => {
    const calls = [];
    let retagFails = false;
    const exec = async (command, args) => {
      calls.push(args.join(' '));
      if (retagFails && args[0] === 'tag' && args[2] === TAG) throw new Error('re-tag failed');
      return { stdout: '' };
    };
    const install = await beginInstall({ files: files.files, previousImage: OLD_IMAGE, imageTag: TAG, dockerPath: 'docker', exec });
    await writeNewInstall(files);
    retagFails = true;
    await assert.rejects(install.rollback(), /re-tag failed/);
    // The files were still put back and the guard tag still dropped.
    assert.equal(await readFile(files.config, 'utf8'), '{"image":"old"}\n');
    await assert.rejects(stat(files.manifest), { code: 'ENOENT' });
    assert.equal(calls.at(-1), `image rm ${guardTagFor(TAG)}`);
  });
});
