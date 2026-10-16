import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { diagnoseTailscale, type CommandResult } from '../src/net/tailscale';

const ok = (value: unknown): CommandResult => ({ stdout: JSON.stringify(value), stderr: '', code: null });
const host = 'nas.example.ts.net:443';
function config(proxy = 'http://127.0.0.1:8096') {
  return { AllowFunnel: { [host]: true }, TCP: { '443': { HTTPS: true } }, Web: { [host]: { Handlers: { '/': { Proxy: proxy } } } } };
}
async function diagnose(options: { state?: unknown; funnel?: unknown; error?: CommandResult; missing?: boolean } = {}) {
  const calls: string[][] = [];
  const result = await diagnoseTailscale(8096, {
    findBinary: () => options.missing ? null : '/fake/tailscale',
    run: async (_binary, args) => {
      calls.push(args);
      if (args[0] === 'version') return { stdout: '1.90.1\nprivate build details', stderr: '', code: null };
      if (options.error) return options.error;
      return args[0] === 'status' ? ok(options.state ?? { BackendState: 'Running', Self: { Online: true } }) : ok(options.funnel ?? {});
    },
  });
  return { result, calls };
}
const check = (result: Awaited<ReturnType<typeof diagnoseTailscale>>, id: string) => result.checks.find((c) => c.id === id)!;

describe('Tailscale read-only diagnostics', () => {
  it('does not execute anything if the client cannot be found', async () => {
    const { result, calls } = await diagnose({ missing: true });
    assert.equal(calls.length, 0);
    assert.equal(check(result, 'binary').status, 'warning');
    assert.equal(result.publicUrl, null);
  });
  it('only executes fixed read-only arguments and never confirms write permissions', async () => {
    const { result, calls } = await diagnose();
    assert.deepEqual(calls, [['version'], ['status', '--json'], ['funnel', 'status', '--json']]);
    assert.equal(result.readOnly, true);
    assert.equal(result.version, '1.90.1');
    assert.equal(check(result, 'connection').status, 'ok');
    assert.equal(check(result, 'permissions').status, 'unknown');
    assert.equal(check(result, 'authorization').status, 'unknown');
    assert.equal(check(result, 'funnel').status, 'warning');
  });
  it('identifies Funnel only when HTTPS and the application proxy match', async () => {
    const { result } = await diagnose({ funnel: config() });
    assert.equal(result.publicUrl, 'https://nas.example.ts.net');
    assert.match(check(result, 'funnel').message, /reste à tester/);
  });
  it('does not mistake private Serve for public Funnel', async () => {
    const privateConfig = { ...config(), AllowFunnel: {} };
    assert.equal((await diagnose({ funnel: privateConfig })).result.publicUrl, null);
  });
  it('does not claim another service, path or non-HTTPS endpoint is this app', async () => {
    for (const funnel of [config('http://127.0.0.1:5000'), { ...config(), TCP: {} },
      { ...config(), Web: { [host]: { Handlers: { '/media': { Proxy: 'http://127.0.0.1:8096' } } } } },
      { ...config(), AllowFunnel: { 'malicious.example:443': true } }]) {
      assert.equal((await diagnose({ funnel })).result.publicUrl, null);
    }
  });
  it('does not claim a logged-out or offline client is connected', async () => {
    for (const state of [{ BackendState: 'NeedsLogin' }, { BackendState: 'Running', Self: { Online: false } }]) {
      const { result } = await diagnose({ state, funnel: config() });
      assert.equal(check(result, 'connection').status, 'warning');
      assert.equal(check(result, 'funnel').status, 'warning');
    }
  });
  it('reports permission denial without exposing raw CLI output', async () => {
    const { result } = await diagnose({ error: { stdout: '', stderr: 'Access denied: private-secret', code: 1 } });
    assert.match(check(result, 'funnel').message, /Accès refusé/);
    assert.ok(!JSON.stringify(result).includes('private-secret'));
  });
  it('handles unsupported commands and malformed JSON conservatively', async () => {
    const unsupported = (await diagnose({ error: { stdout: '', stderr: 'unknown command funnel', code: 1 } })).result;
    assert.equal(check(unsupported, 'funnel').status, 'unknown');
    const invalid = await diagnoseTailscale(8096, {
      findBinary: () => '/fake/tailscale',
      run: async () => ({ stdout: 'invalid JSON', stderr: '', code: null }),
    });
    assert.equal(check(invalid, 'connection').status, 'unknown');
    assert.equal(check(invalid, 'funnel').status, 'unknown');
  });
  it('handles an executable that cannot be started', async () => {
    const result = await diagnoseTailscale(8096, { findBinary: () => '/nonexistent/tailscale' });
    assert.equal(check(result, 'connection').status, 'error');
    assert.equal(result.publicUrl, null);
  });
  it('bounds actual subprocess execution time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailscale-test-'));
    const binary = path.join(dir, 'tailscale');
    fs.writeFileSync(binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    try {
      const started = Date.now();
      const result = await diagnoseTailscale(8096, { findBinary: () => binary });
      assert.ok(Date.now() - started < 10_000);
      assert.equal(check(result, 'connection').status, 'error');
      assert.equal(result.publicUrl, null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
