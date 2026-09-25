import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';

// An install or update writes a fixed set of instance files (config, launcher, browser
// manifests, image pin, release pin) and moves the image tag. If any step fails, the previous
// install must still work: the files are saved first, and the image the previous config runs
// keeps a guard tag, because Docker may delete an image once its last tag moves away.
export function guardTagFor(imageTag) {
  return `${imageTag}-previous`;
}

export async function beginInstall({ files, previousImage = null, imageTag, dockerPath, exec }) {
  const saved = [];
  for (const file of files) {
    try {
      const { mode } = await stat(file);
      saved.push({ file, content: await readFile(file), mode: mode & 0o7777 });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      saved.push({ file, content: null, mode: 0 });
    }
  }

  const guardTag = guardTagFor(imageTag);
  let guarded = false;
  if (previousImage) {
    const present = await exec(dockerPath, ['image', 'inspect', previousImage], { encoding: 'utf8' }).then(() => true, () => false);
    // Nothing has been written yet, so a failure here leaves the install exactly as it was.
    if (present) {
      await exec(dockerPath, ['tag', previousImage, guardTag], { encoding: 'utf8' });
      guarded = true;
    }
  }

  return {
    // Puts every saved file back (or removes it if it did not exist) and the image tag back on
    // the previous image. Every step is attempted; the first failure is reported after all ran.
    async rollback() {
      let firstError = null;
      const attempt = async (step) => {
        try {
          await step();
        } catch (error) {
          firstError ??= error;
        }
      };
      for (const { file, content, mode } of saved) {
        await attempt(async () => {
          if (content === null) {
            await rm(file, { force: true });
          } else {
            await writeFile(file, content, { mode });
            await chmod(file, mode);
          }
        });
      }
      if (guarded) {
        // The guard tag is dropped only once the previous image carries the tag again;
        // otherwise it is the image's last tag and keeps it from being deleted.
        let retagged = false;
        await attempt(async () => {
          await exec(dockerPath, ['tag', previousImage, imageTag], { encoding: 'utf8' });
          retagged = true;
        });
        if (retagged) await attempt(() => exec(dockerPath, ['image', 'rm', guardTag], { encoding: 'utf8' }));
      }
      if (firstError) throw firstError;
    },
    // The new install is complete: the previous image is no longer needed.
    async commit() {
      if (guarded) await exec(dockerPath, ['image', 'rm', guardTag], { encoding: 'utf8' }).catch(() => {});
    },
  };
}
