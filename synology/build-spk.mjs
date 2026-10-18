#!/usr/bin/env node
/**
 * Build the native DSM 7 SPK package for Synology DS220+ (arch: geminilake).
 *
 *   npm run spk            -> dist-spk/nas-simple-media-<version>-<arch>.spk
 *   npm run spk:lite       -> same, without bundling ffmpeg (transcoding then
 *                             requires the SynoCommunity ffmpeg6 package)
 *   node synology/build-spk.mjs --keep-staging
 *
 * Layout produced inside the .spk:
 *
 *   INFO                       package metadata (DSM 7 required fields)
 *   PACKAGE_ICON*.PNG          Package Center icons
 *   conf/privilege             run-as package user sc-nas-simple-media
 *   conf/resource              auto "media" share, port/firewall entry, /dev/dri
 *   scripts/{pre,post}{inst,uninst}, preupgrade, postupgrade,
 *           start-stop-status, common.sh
 *   WIZARD_UIFILES             (none: installation is non-interactive)
 *   package.tgz                payload -> /var/packages/nas-simple-media/target
 *
 * The payload contains the compiled app, the web UI, the documentation, the
 * DSM port descriptor and — unless --without-bundled-ffmpeg is used — static
 * ffmpeg/ffprobe binaries so Compatible (HLS) playback works out of the box.
 *
 * The .spk itself is never committed: it is a release artefact only.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTar, createTarGz } from './lib/tar.mjs';
import { createIconPng } from './lib/icons.mjs';
import { readInfoFile, serializeInfo } from './lib/info.mjs';
import { stageBundledFfmpeg } from './lib/ffmpeg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SYNO_DIR = HERE;
const STAGING = path.join(SYNO_DIR, 'package');
const OUTPUT_DIR = path.join(REPO_ROOT, 'dist-spk');
const FFMPEG_CACHE = path.join(REPO_ROOT, '.cache', 'ffmpeg');
const KEEP_STAGING = process.argv.includes('--keep-staging');
const BUNDLE_FFMPEG = !process.argv.includes('--without-bundled-ffmpeg');

const PKG_NAME = 'nas-simple-media';

function fail(message) {
  console.error(`[spk] ERROR: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[spk] ${message}`);
}

function warn(message) {
  console.warn(`[spk] WARNING: ${message}`);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(src, dest, { executable = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, { executable });
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      const rel = path.relative(dest, to);
      if (executable.includes(rel)) fs.chmodSync(to, 0o755);
    }
  }
}

/** Recursively collect tar entries for a directory, in deterministic order. */
function tarEntriesFromDir(rootDir, prefix = '') {
  const entries = [];
  // A non-empty prefix becomes an explicit directory member (e.g. "conf");
  // an empty prefix means "the archive root", which needs no member of its own.
  if (prefix) {
    entries.push({ name: prefix, type: 'dir', data: Buffer.alloc(0), mode: 0o755 });
  }

  const executableNames = new Set(['app/bin/ffmpeg', 'app/bin/ffprobe']);

  const walk = (absDir, relPrefix) => {
    const items = fs.readdirSync(absDir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const abs = path.join(absDir, item.name);
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ name: rel, type: 'dir', data: Buffer.alloc(0), mode: 0o755 });
        walk(abs, rel);
      } else if (item.isFile()) {
        const data = fs.readFileSync(abs);
        const isScript =
          rel.endsWith('.sh') ||
          rel.endsWith('run.sh') ||
          rel.startsWith('scripts/') ||
          rel === 'app/bin/run.sh' ||
          executableNames.has(rel);
        entries.push({
          name: rel,
          data,
          mode: isScript ? 0o755 : 0o644,
        });
      }
    }
  };

  walk(rootDir, prefix.replace(/\/$/, ''));
  return entries;
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) fail(`${label} missing: ${path.relative(REPO_ROOT, file)}`);
}

/** Copy the project documentation into the package. */
function stageDocs(appDir) {
  const docsDir = path.join(appDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const files = [
    ['README.md', 'README.md'],
    ['docs/DOP.md', 'DOP.md'],
    ['.env.example', 'env.example'],
    ['LICENSE', 'LICENSE'],
    ['synology/RELEASE_NOTES.md', 'RELEASE_NOTES.md'],
  ];
  for (const [source, dest] of files) {
    const from = path.join(REPO_ROOT, source);
    requireFile(from, 'documentation');
    fs.copyFileSync(from, path.join(docsDir, dest));
  }
  info(`documentation: ${files.length} files in app/docs/`);
}

/** DSM port descriptor: makes the service visible in firewall/port-forwarding. */
function stagePortConfig(appDir) {
  const portConfDir = path.join(appDir, 'port_conf');
  fs.mkdirSync(portConfDir, { recursive: true });
  const source = path.join(SYNO_DIR, 'port_conf', `${PKG_NAME}.sc`);
  requireFile(source, 'port configuration');
  fs.copyFileSync(source, path.join(portConfDir, `${PKG_NAME}.sc`));
  info('port configuration: app/port_conf/nas-simple-media.sc (8096/tcp)');
}

// ---------------------------------------------------------------------------

function main() {
  // --- sanity ---------------------------------------------------------------
  const pkgJsonPath = path.join(REPO_ROOT, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) fail('package.json not found');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  const infoPath = path.join(SYNO_DIR, 'INFO');
  if (!fs.existsSync(infoPath)) fail('synology/INFO not found');
  const infoFields = readInfoFile(infoPath);

  const version = infoFields.get('version') || pkgJson.version;
  if (version !== pkgJson.version) {
    fail(
      `version mismatch: synology/INFO says ${version} but package.json says ${pkgJson.version}. ` +
        'Keep both in sync.'
    );
  }

  const arch = infoFields.get('arch');
  if (!arch) fail('synology/INFO is missing the arch field');

  const required = [
    'package',
    'version',
    'os_min_ver',
    'description',
    'arch',
    'maintainer',
    'install_dep_packages',
  ];
  const missing = required.filter((k) => !infoFields.get(k));
  if (missing.length) fail(`synology/INFO is missing required field(s): ${missing.join(', ')}`);

  info(`package  : ${infoFields.get('package')}`);
  info(`version  : ${version}`);
  info(`arch     : ${arch}`);
  info(`deps     : ${infoFields.get('install_dep_packages')}`);

  // --- clean staging --------------------------------------------------------
  rmrf(STAGING);
  rmrf(OUTPUT_DIR);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // --- compile TypeScript ---------------------------------------------------
  info('compiling TypeScript (npm run build)');
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });

  const distDir = path.join(REPO_ROOT, 'dist');
  const publicDir = path.join(REPO_ROOT, 'public');
  if (!fs.existsSync(path.join(distDir, 'index.js'))) fail('dist/index.js missing after build');
  if (!fs.existsSync(publicDir)) fail('public/ missing');

  // --- stage the payload ----------------------------------------------------
  const appDir = path.join(STAGING, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  copyDir(distDir, path.join(appDir, 'dist'));
  copyDir(publicDir, path.join(appDir, 'public'));
  fs.mkdirSync(path.join(appDir, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(SYNO_DIR, 'bin', 'run.sh'), path.join(appDir, 'bin', 'run.sh'));
  fs.chmodSync(path.join(appDir, 'bin', 'run.sh'), 0o755);
  fs.copyFileSync(pkgJsonPath, path.join(appDir, 'package.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
  stageDocs(appDir);
  stagePortConfig(appDir);

  // --- ffmpeg / ffprobe -----------------------------------------------------
  if (BUNDLE_FFMPEG) {
    info('bundling static ffmpeg/ffprobe (fallback when ffmpeg6 is not installed)');
    stageBundledFfmpeg({
      cacheDir: FFMPEG_CACHE,
      destDir: path.join(appDir, 'bin'),
      log: (message) => info(message),
    });
  } else {
    warn(
      'building without bundled ffmpeg (--without-bundled-ffmpeg): Compatible playback ' +
        'will require the SynoCommunity ffmpeg6 package.'
    );
  }

  // Production dependencies, installed without running install scripts so no
  // native compilation is attempted. The app uses Node's built-in SQLite engine
  // (node:sqlite) on DSM, so no native addon is required at runtime.
  info('installing production dependencies (no build scripts)');
  const depsTmp = fs.mkdtempSync(path.join(REPO_ROOT, '.spk-deps-'));
  try {
    fs.copyFileSync(pkgJsonPath, path.join(depsTmp, 'package.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(depsTmp, 'package-lock.json'));
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: depsTmp,
      stdio: 'inherit',
    });
    copyDir(path.join(depsTmp, 'node_modules'), path.join(appDir, 'node_modules'));
  } finally {
    rmrf(depsTmp);
  }

  // --- payload sanity -------------------------------------------------------
  const payloadRequired = [
    'app/dist/index.js',
    'app/public/index.html',
    'app/public/vendor/hls.js/hls.min.js',
    'app/bin/run.sh',
    'app/port_conf/nas-simple-media.sc',
    'app/docs/README.md',
    'app/docs/DOP.md',
    'app/package.json',
  ];
  if (BUNDLE_FFMPEG) payloadRequired.push('app/bin/ffmpeg', 'app/bin/ffprobe');
  for (const rel of payloadRequired) requireFile(path.join(STAGING, rel), 'payload');

  // --- package.tgz ----------------------------------------------------------
  info('creating package.tgz');
  const payloadEntries = tarEntriesFromDir(STAGING, '');
  const packageTgz = createTarGz(payloadEntries);
  const checksum = crypto.createHash('md5').update(packageTgz).digest('hex');
  info(`package.tgz: ${(packageTgz.length / 1024 / 1024).toFixed(2)} MiB, md5 ${checksum}`);

  // --- INFO with checksum ---------------------------------------------------
  const infoWithChecksum = new Map(infoFields);
  infoWithChecksum.set('checksum', checksum);
  const infoBuffer = Buffer.from(serializeInfo(infoWithChecksum), 'utf8');

  // --- icons ----------------------------------------------------------------
  const icon72 = createIconPng(72);
  const icon256 = createIconPng(256);
  const icon64 = createIconPng(64);
  info(
    `icons: 64x64 (${icon64.length} B), 72x72 (${icon72.length} B), 256x256 (${icon256.length} B)`
  );

  // --- assemble the SPK -----------------------------------------------------
  const spkEntries = [
    { name: 'INFO', data: infoBuffer, mode: 0o644 },
    { name: 'package.tgz', data: packageTgz, mode: 0o644 },
    { name: 'PACKAGE_ICON.PNG', data: icon72, mode: 0o644 },
    { name: 'PACKAGE_ICON_64.PNG', data: icon64, mode: 0o644 },
    { name: 'PACKAGE_ICON_256.PNG', data: icon256, mode: 0o644 },
    { name: 'LICENSE', data: fs.readFileSync(path.join(REPO_ROOT, 'LICENSE')), mode: 0o644 },
    ...tarEntriesFromDir(path.join(SYNO_DIR, 'conf'), 'conf'),
    ...tarEntriesFromDir(path.join(SYNO_DIR, 'scripts'), 'scripts'),
  ];

  const fileName = `${infoFields.get('package')}-${version}-${arch}.spk`;
  const outPath = path.join(OUTPUT_DIR, fileName);
  const spkBuffer = createTar(spkEntries);
  fs.writeFileSync(outPath, spkBuffer);
  const sha256 = crypto.createHash('sha256').update(spkBuffer).digest('hex');
  fs.writeFileSync(`${outPath}.sha256`, `${sha256}  ${fileName}\n`);
  info(`wrote ${path.relative(REPO_ROOT, outPath)} (${(spkBuffer.length / 1024 / 1024).toFixed(2)} MiB)`);
  info(`sha256: ${sha256}`);

  // --- self-verification ----------------------------------------------------
  info('verifying archive');
  const listing = execFileSync('tar', ['-tf', outPath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const expected = [
    'INFO',
    'package.tgz',
    'conf/privilege',
    'conf/resource',
    'scripts/preupgrade',
    'scripts/postupgrade',
    'scripts/start-stop-status',
  ];
  for (const item of expected) {
    if (!listing.includes(item)) fail(`verification failed: ${item} missing from ${fileName}`);
  }
  info(`archive contains ${listing.length} entries`);

  if (!KEEP_STAGING) rmrf(STAGING);

  info('done');
  console.log('');
  console.log(`  ${path.relative(REPO_ROOT, outPath)}`);
  console.log(`  ${path.relative(REPO_ROOT, outPath)}.sha256`);
  console.log('');
  console.log('  Install: Package Center > Manual Install > select the .spk');
  console.log('          (Settings > General > Trust Level must allow all publishers)');
  console.log('');
}

main();
