import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';

import { createTar, createTarGz } from '../synology/lib/tar.mjs';
import { createIconPng } from '../synology/lib/icons.mjs';
import { readInfoFile, compareDsmVersion } from '../synology/lib/info.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');
const SYNO_DIR = path.join(REPO_ROOT, 'synology');

const PACKAGE_NAME = 'nas-simple-media';
const TARGET_VERSION = '1.5.1';
const TARGET_ARCH = 'geminilake';
const TARGET_PORT = '8096';

function readInfo(): Map<string, string> {
  return readInfoFile(path.join(SYNO_DIR, 'INFO'));
}

function isExecutable(relPath: string): boolean {
  const stat = fs.statSync(path.join(SYNO_DIR, relPath));
  return (stat.mode & 0o111) !== 0;
}

function readScript(name: string): string {
  return fs.readFileSync(path.join(SYNO_DIR, 'scripts', name), 'utf8');
}

describe('DSM 7 SPK metadata', () => {
  it('declares every field DSM 7 makes mandatory', () => {
    const info = readInfo();
    for (const key of ['package', 'version', 'os_min_ver', 'description', 'arch', 'maintainer']) {
      assert.ok(info.get(key), `INFO is missing required field "${key}"`);
    }
  });

  it('targets Synology DS220+ (geminilake) at version 1.5.1', () => {
    const info = readInfo();
    assert.equal(info.get('package'), PACKAGE_NAME);
    assert.equal(info.get('version'), TARGET_VERSION);
    assert.equal(info.get('arch'), TARGET_ARCH);
  });

  it('requires DSM 7.0 or newer', () => {
    const osMinVer = readInfo().get('os_min_ver') ?? '';
    assert.ok(
      compareDsmVersion(osMinVer, '7.0-40000') >= 0,
      `os_min_ver ${osMinVer} is below 7.0-40000`
    );
  });

  it('exposes the web UI on port 8096 with port checking', () => {
    const info = readInfo();
    assert.equal(info.get('adminport'), TARGET_PORT);
    assert.equal(info.get('adminprotocol'), 'http');
    assert.equal(info.get('checkport'), 'yes');
    assert.equal(info.get('ctl_stop'), 'yes');
  });

  it('depends on Synology Node.js v22 and SynoCommunity ffmpeg6', () => {
    const info = readInfo();
    const installDeps = (info.get('install_dep_packages') ?? '').split(':');
    assert.ok(
      installDeps.includes('Node.js_v22'),
      `install_dep_packages must include Node.js_v22, got: ${installDeps.join(', ')}`
    );
    assert.ok(
      installDeps.includes('ffmpeg6'),
      `install_dep_packages must include ffmpeg6, got: ${installDeps.join(', ')}`
    );

    const startDeps = (info.get('start_dep_packages') ?? '').split(':');
    assert.ok(startDeps.includes('Node.js_v22'), 'start_dep_packages must include Node.js_v22');
  });

  it('ships both package icons', () => {
    const info = readInfo();
    assert.equal(info.get('package_icon'), 'PACKAGE_ICON.PNG');
    assert.equal(info.get('package_icon_256'), 'PACKAGE_ICON_256.PNG');
  });

  it('is a third-party package so Package Center can be set to all publishers', () => {
    assert.equal(readInfo().get('thirdparty'), 'yes');
  });
});

describe('DSM 7 privilege configuration', () => {
  it('runs as the package user sc-nas-simple-media', () => {
    const privilege = JSON.parse(
      fs.readFileSync(path.join(SYNO_DIR, 'conf', 'privilege'), 'utf8')
    ) as {
      defaults: { 'run-as': string };
      username?: string;
      groupname?: string;
    };

    assert.equal(privilege.defaults['run-as'], 'package');
    assert.equal(privilege.username, 'sc-nas-simple-media');
    assert.equal(privilege.groupname, 'sc-nas-simple-media');
  });

  it('never requests root privileges (disallowed for third-party DSM 7 packages)', () => {
    const privilege = JSON.parse(
      fs.readFileSync(path.join(SYNO_DIR, 'conf', 'privilege'), 'utf8')
    ) as {
      defaults: { 'run-as': string };
      'ctrl-script'?: Array<{ action: string; 'run-as': string }>;
      executable?: Array<{ relpath: string; 'run-as': string }>;
    };
    assert.equal(privilege.defaults['run-as'], 'package');
    for (const c of privilege['ctrl-script'] ?? []) {
      assert.notEqual(c['run-as'], 'root', `${c.action} must not run as root on DSM 7`);
    }
    for (const e of privilege.executable ?? []) {
      assert.notEqual(e['run-as'], 'root', `${e.relpath} must not run as root on DSM 7`);
    }
  });
});

describe('DSM 7 lifecycle scripts', () => {
  it('ships every hook and marks them executable', () => {
    for (const script of [
      'scripts/preinst',
      'scripts/postinst',
      'scripts/preuninst',
      'scripts/postuninst',
      'scripts/start-stop-status',
    ]) {
      assert.ok(fs.existsSync(path.join(SYNO_DIR, script)), `missing ${script}`);
      assert.ok(isExecutable(script), `${script} must be executable`);
    }
  });

  it('starts, stops and reports status', () => {
    const script = readScript('start-stop-status');
    for (const action of ['start)', 'stop)', 'status)']) {
      assert.ok(script.includes(action), `start-stop-status must handle ${action}`);
    }
    assert.ok(
      script.includes('sc-nas-simple-media'),
      'service must run as sc-nas-simple-media'
    );
  });

  it('checks the Node.js version before starting', () => {
    const script = readScript('start-stop-status');
    assert.ok(script.includes('node_is_supported'), 'start-stop-status must validate Node.js');
    assert.ok(script.includes('APP_PORT'), 'start-stop-status must reference the app port');

    const common = fs.readFileSync(path.join(SYNO_DIR, 'scripts', 'common.sh'), 'utf8');
    assert.ok(/APP_PORT="8096"/.test(common), 'common.sh must define APP_PORT as 8096');
    assert.ok(
      common.includes('sc-nas-simple-media'),
      'common.sh must define the service user'
    );
  });

  it('documents the shared-folder ACL step at install time', () => {
    const postinst = readScript('postinst');
    assert.ok(
      /SERVICE_USER/.test(postinst) || postinst.includes('sc-nas-simple-media'),
      'postinst must reference the service user'
    );
    assert.ok(/Shared Folder/.test(postinst), 'postinst must point at Shared Folder permissions');
    assert.ok(/ACL/.test(postinst), 'postinst must explain the ACL requirement');
  });

  it('warns before uninstalling that the database will be removed', () => {
    const preuninst = readScript('preuninst');
    assert.ok(/library\.db/.test(preuninst), 'preuninst must mention the SQLite database');
  });

  it('ships a run.sh entry point that records its own PID', () => {
    const run = fs.readFileSync(path.join(SYNO_DIR, 'bin', 'run.sh'), 'utf8');
    assert.ok(isExecutable('bin/run.sh'), 'bin/run.sh must be executable');
    // PID must be written before exec so stop/status target the real process.
    const pidIdx = run.indexOf('> "${PIDFILE}"');
    const execIdx = run.indexOf('exec "${NODE_BIN}"');
    assert.ok(pidIdx !== -1, 'run.sh must write the PID file');
    assert.ok(execIdx !== -1, 'run.sh must exec node');
    assert.ok(pidIdx < execIdx, 'PID must be written before exec');
  });
});

describe('package.json wiring', () => {
  it('exposes an spk build script and matches the INFO version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
      scripts: Record<string, string>;
    };
    assert.ok(pkg.scripts.spk, 'package.json must define an "spk" script');
    assert.ok(pkg.scripts.spk.includes('build-spk.mjs'), 'spk script must call build-spk.mjs');
    assert.equal(pkg.version, readInfo().get('version'));
  });

  it('keeps the sqlite and packaging tests in the test run', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.ok(pkg.scripts.test.includes('tests/sqlite.test.ts'), 'sqlite adapter tests must run');
    assert.ok(pkg.scripts.test.includes('tests/spk.test.ts'), 'packaging tests must run');
    assert.ok(pkg.scripts.test.includes('tests/explorer.test.ts'), 'NAS explorer tests must run');
    assert.ok(pkg.scripts.test.includes('tests/ui.test.ts'), 'UI smoke tests must run');
  });

  it('keeps the 1.5.1 version in sync across the package files', () => {
    assert.equal(readInfo().get('version'), TARGET_VERSION);
    assert.ok(
      readScript('preinst').includes(`VERSION:-${TARGET_VERSION}`),
      `preinst must default to ${TARGET_VERSION}`
    );
    const notes = fs.readFileSync(path.join(SYNO_DIR, 'RELEASE_NOTES.md'), 'utf8');
    assert.ok(
      notes.startsWith(`## NAS Simple Media ${TARGET_VERSION}`),
      `RELEASE_NOTES.md must document ${TARGET_VERSION} first`
    );
  });

  it('generates the external access settings in the runtime env file', () => {
    const common = fs.readFileSync(path.join(SYNO_DIR, 'scripts', 'common.sh'), 'utf8');
    assert.ok(/PUBLIC_BASE_URL=/.test(common), 'common.sh must generate PUBLIC_BASE_URL');
    assert.ok(/TRUST_PROXY=1/.test(common), 'common.sh must generate TRUST_PROXY for reverse proxies');
  });
});

describe('release artefacts stay out of git', () => {
  it('ignores node_modules, dist and the .spk', () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    for (const pattern of ['node_modules/', 'dist/', '*.spk', 'dist-spk/', 'synology/package/']) {
      assert.ok(ignore.includes(pattern), `.gitignore must ignore ${pattern}`);
    }
  });

  it('keeps the build output ignored by git', () => {
    const ignored = (relPath: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', relPath], { cwd: REPO_ROOT });
        return true;
      } catch {
        return false;
      }
    };
    for (const artefact of [
      'dist-spk/nas-simple-media-1.5.1-geminilake.spk',
      'synology/package/app/dist/index.js',
      'node_modules/express/package.json',
      'dist/index.js',
    ]) {
      assert.ok(ignored(artefact), `${artefact} must be git-ignored`);
    }
  });
});

describe('tar writer', () => {
  it('round-trips through the system tar', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-tar-'));
    const file = path.join(tmp, 'test.tar');
    try {
      fs.writeFileSync(
        file,
        createTar([
          { name: 'dir', type: 'dir', data: Buffer.alloc(0), mode: 0o755 },
          { name: 'dir/hello.txt', data: Buffer.from('hello world'), mode: 0o644 },
          { name: 'dir/big.bin', data: Buffer.alloc(1024, 7), mode: 0o600 },
        ])
      );

      const listing = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      assert.equal(listing.length, 3, `expected 3 entries, got: ${listing.join(' | ')}`);
      assert.ok(listing[0].startsWith('drwxr-xr-x'), `dir entry malformed: ${listing[0]}`);
      assert.ok(listing[1].includes('hello.txt'));

      const extracted = path.join(tmp, 'out');
      fs.mkdirSync(extracted, { recursive: true });
      execFileSync('tar', ['-xf', file, '-C', extracted]);
      assert.equal(fs.readFileSync(path.join(extracted, 'dir', 'hello.txt'), 'utf8'), 'hello world');
      assert.equal(fs.statSync(path.join(extracted, 'dir', 'big.bin')).size, 1024);
      const mode = fs.statSync(path.join(extracted, 'dir', 'big.bin')).mode & 0o777;
      assert.equal(mode, 0o600, `mode not preserved: ${mode.toString(8)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('pads entries to the 512-byte tar block size', () => {
    const tar = createTar([{ name: 'a.txt', data: Buffer.from('x') }]);
    assert.equal(tar.length % 512, 0, 'tar must be a multiple of 512 bytes');
    assert.equal(tar.length, 512 + 512 + 1024, 'header + padded data + end marker');
  });

  it('produces a gzipped package.tgz', () => {
    const gz = createTarGz([{ name: 'INFO', data: Buffer.from('package="x"\n') }]);
    assert.equal(gz[0], 0x1f, 'gzip magic byte 1');
    assert.equal(gz[1], 0x8b, 'gzip magic byte 2');
  });

  it('rejects names longer than the ustar limit', () => {
    assert.throws(
      () => createTar([{ name: 'x'.repeat(101), data: Buffer.alloc(0) }]),
      /too long/
    );
  });
});

describe('package icons', () => {
  it('generates valid PNGs at both DSM sizes', () => {
    for (const size of [72, 256]) {
      const png = createIconPng(size);
      const signature = [...png.subarray(0, 8)];
      assert.deepEqual(
        signature,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        `bad PNG signature at ${size}px`
      );
      assert.equal(png.readUInt32BE(16), size, `IHDR width must be ${size}`);
      assert.equal(png.readUInt32BE(20), size, `IHDR height must be ${size}`);
      assert.ok(png.length > 500, `icon at ${size}px looks empty`);
    }
  });
});
