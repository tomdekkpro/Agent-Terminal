import { app, net } from 'electron';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { UpdateInfo } from 'electron-updater';
import { debugLog, debugError } from '../shared/utils';

/**
 * Self-updater for the macOS build.
 *
 * electron-updater hands mac installs to Squirrel.Mac, which only accepts an
 * update signed with the same Developer ID as the running app — the ad-hoc
 * signed build can never pass that. So on mac we only use electron-updater to
 * read latest-mac.yml, then download the release zip ourselves, verify its
 * sha512 against the yml, unpack it with ditto (keeps the bundle's signature
 * and symlinks intact) and swap the .app bundle once the app has exited.
 * Node's download doesn't set the quarantine flag, so the new bundle opens
 * without the Gatekeeper prompt.
 */

const RELEASE_DOWNLOAD_URL = 'https://github.com/tomdekkpro/Agent-Terminal/releases/download';

interface StagedUpdate {
  version: string;
  appPath: string;
}

let staged: StagedUpdate | null = null;
let installStarted = false;

/** The release zip for this build's arch, or null for releases published
 *  before the mac zip target existed (caller falls back to the release page). */
export function findMacZip(info: UpdateInfo): { url: string; sha512: string } | null {
  const zips = info.files.filter((f) => f.url.endsWith('.zip'));
  // x64 zip carries no arch in its name; an x64 build under Rosetta keeps x64
  const zip = process.arch === 'arm64'
    ? zips.find((f) => f.url.includes('arm64'))
    : zips.find((f) => !f.url.includes('arm64'));
  return zip ?? null;
}

/** The running .app bundle (…/Agent Terminal.app), or null in dev */
function currentAppBundle(): string | null {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/** Why the running bundle can't be replaced in place, or null if it can */
export function macInstallBlocker(): string | null {
  const bundle = currentAppBundle();
  if (!bundle || !app.isPackaged) return 'Updates can only be installed in the packaged app';
  if (bundle.startsWith('/Volumes/')) return 'Agent Terminal is running from the disk image — drag it to Applications first';
  if (bundle.includes('/AppTranslocation/')) return 'macOS is running Agent Terminal from a temporary location — move it to Applications and reopen it';
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return `No permission to replace ${bundle}`;
  }
  return null;
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve();
    });
  });
}

/** Download, verify and unpack the update. Resolves once it is ready to install. */
export async function downloadMacUpdate(
  info: UpdateInfo,
  onProgress: (percent: number, transferred: number, total: number) => void,
): Promise<void> {
  const zip = findMacZip(info);
  if (!zip) throw new Error('This release has no macOS zip');

  const dir = path.join(app.getPath('userData'), 'pending-update');
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, 'update.zip');

  const url = `${RELEASE_DOWNLOAD_URL}/v${info.version}/${encodeURIComponent(zip.url)}`;
  debugLog('[MacUpdater] Downloading', url);
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha512');
  const out = fs.createWriteStream(zipPath);
  let transferred = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      transferred += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress(total ? Math.round((transferred / total) * 100) : 0, transferred, total);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }

  if (hash.digest('base64') !== zip.sha512) {
    throw new Error('Downloaded update failed its checksum — try again');
  }

  const unpacked = path.join(dir, 'app');
  await run('/usr/bin/ditto', ['-x', '-k', zipPath, unpacked]);
  await fs.promises.rm(zipPath, { force: true });

  const bundleName = (await fs.promises.readdir(unpacked)).find((f) => f.endsWith('.app'));
  if (!bundleName) throw new Error('Update zip contained no .app bundle');

  staged = { version: info.version, appPath: path.join(unpacked, bundleName) };
  debugLog('[MacUpdater] Staged', staged.appPath);
}

export function hasStagedMacUpdate(): boolean {
  return staged !== null;
}

/**
 * Hand the swap to a detached shell script that waits for this process to
 * exit, replaces the bundle (restoring the old one if the move fails) and
 * optionally reopens the app. The caller quits the app afterwards.
 */
export function startMacInstall(relaunch: boolean): boolean {
  if (!staged || installStarted) return false;
  const target = currentAppBundle();
  if (!target || macInstallBlocker()) return false;
  installStarted = true;

  const script = `
pid="$1"; target="$2"; next="$3"; relaunch="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; done
rm -rf "$target.old"
if mv "$target" "$target.old"; then
  if mv "$next" "$target"; then
    rm -rf "$target.old"
  else
    mv "$target.old" "$target"
  fi
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null
if [ "$relaunch" = "1" ]; then open "$target"; fi
`;
  try {
    const child = spawn('/bin/sh', ['-c', script, 'mac-update', String(process.pid), target, staged.appPath, relaunch ? '1' : '0'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    debugLog('[MacUpdater] Installing', staged.version, 'into', target);
    return true;
  } catch (err) {
    installStarted = false;
    debugError('[MacUpdater] Failed to start install:', err);
    return false;
  }
}
