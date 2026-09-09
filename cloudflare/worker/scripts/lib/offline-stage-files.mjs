import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

export function readRegular(path, maximumBytes = Infinity) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('Expected a regular file');
    if (info.size > maximumBytes) throw new Error('Staged raw hash or size mismatch');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function immutableWrite(path, bytes) {
  const temporary = join(dirname(path), `.stage-${randomUUID()}`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!readRegular(path).equals(bytes)) throw new Error('Existing staging output conflicts with verified input');
    }
    if (!readRegular(path).equals(bytes)) throw new Error('Staging readback verification failed');
  } finally {
    unlinkSync(temporary);
  }
}

export function stagingDirectory(sourceRoot, requestedOutput) {
  const parent = realpathSync(dirname(resolve(requestedOutput)));
  const output = join(parent, basename(resolve(requestedOutput)));
  if (output === sourceRoot || inside(sourceRoot, output) || inside(output, sourceRoot)) throw new Error('Source and staging directories must not overlap');
  try {
    mkdirSync(output, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) throw new Error('Staging destination must be a real directory');
  return output;
}

export async function runStagingCli(moduleUrl, flags, stage) {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(resolve(process.argv[1])).href) return;
  try {
    const args = process.argv.slice(2);
    if (args.length !== flags.length * 2 || flags.some((flag, index) => args[index * 2] !== flag))
      throw new Error(`Required arguments: ${flags.map((flag) => `${flag} VALUE`).join(' ')}`);
    console.log(JSON.stringify(await stage(...flags.map((_, index) => args[index * 2 + 1])), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
