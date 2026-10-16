import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';

// Fixed paths only: never execute a path or command supplied by an HTTP client.
const BINARIES = [
  '/var/packages/Tailscale/target/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
];
export interface CommandResult { stdout: string; stderr: string; code: string | number | null }
type Runner = (binary: string, args: string[]) => Promise<CommandResult>;
export interface DiagnosticCheck {
  id: string;
  label: string;
  status: 'ok' | 'warning' | 'error' | 'unknown';
  message: string;
}

/** Bounded, shell-free, read-only commands. No sudo, login, up, set or Funnel activation. */
const run: Runner = (binary, args) => new Promise((resolve) => {
  execFile(binary, args, { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? error.code || 'FAILED' : null }));
});

function failure(result: CommandResult): string {
  if (/permission denied|access denied|not permitted|requires root/i.test(result.stderr + result.stdout) || result.code === 'EACCES') {
    return 'Accès refusé au compte du paquet. Aucune élévation de privilèges n’a été tentée.';
  }
  if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Réponse trop volumineuse : diagnostic interrompu.';
  return 'Commande indisponible, service inaccessible ou délai dépassé. Vérifiez le paquet Tailscale dans DSM.';
}
function parseObject(text: string): any {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value;
}

export async function diagnoseTailscale(port: number, dependencies: {
  findBinary?: () => string | null;
  run?: Runner;
} = {}) {
  const binary = (dependencies.findBinary || (() => BINARIES.find((p) => fs.existsSync(p)) || null))();
  const execute = dependencies.run || run;
  let serviceUser = 'inconnu';
  try { serviceUser = os.userInfo().username; } catch { /* restricted runtime */ }
  const checks: DiagnosticCheck[] = [];
  const add = (id: string, label: string, status: DiagnosticCheck['status'], message: string) =>
    checks.push({ id, label, status, message });
  let version: string | null = null;
  let publicUrl: string | null = null;
  add('binary', 'Installation Tailscale', binary ? 'ok' : 'warning', binary
    ? `Client détecté : ${binary}` : 'Client introuvable aux emplacements connus. Cela ne prouve pas que Tailscale est absent du NAS.');
  if (binary) {
    const [v, state, funnel] = await Promise.all([
      execute(binary, ['version']),
      execute(binary, ['status', '--json']),
      execute(binary, ['funnel', 'status', '--json']),
    ]);
    version = v.code === null ? v.stdout.match(/^\s*(\d+\.\d+\.\d+(?:[-\w.]*)?)/)?.[1] || null : null;
    add('version', 'Version du client', version ? 'ok' : 'unknown', version || 'Version non déterminée.');
    let connected = false;
    if (state.code !== null) {
      add('connection', 'Connexion Tailscale', 'error', failure(state));
    } else {
      try {
        const info = parseObject(state.stdout);
        connected = info.BackendState === 'Running' && info.Self?.Online === true;
        add('connection', 'Connexion Tailscale', connected ? 'ok' : 'warning', connected
          ? 'Le client se déclare connecté.'
          : 'Connexion non confirmée. Vérifiez la connexion et les éventuelles autorisations dans Tailscale.');
      } catch { add('connection', 'Connexion Tailscale', 'unknown', 'Réponse du client non reconnue.'); }
    }
    if (funnel.code !== null) {
      add('funnel', 'Configuration Funnel', 'unknown', failure(funnel));
    } else {
      try {
        // Empty output is not proof that Funnel is supported or readable.
        const info = parseObject(funnel.stdout);
        const endpoints: string[] = Object.entries(info.AllowFunnel || {})
          .filter(([host, enabled]) => enabled === true && /^[a-z0-9.-]+\.ts\.net:(443|8443|10000)$/i.test(host))
          .map(([host]) => host);
        const matching = endpoints.find((host) => {
          const handler = info.Web?.[host]?.Handlers?.['/'];
          return info.TCP?.[host.split(':').pop()!]?.HTTPS === true &&
            (handler?.Proxy === `http://127.0.0.1:${port}` || handler?.Proxy === `http://localhost:${port}`);
        });
        if (matching) publicUrl = `https://${matching.replace(/:443$/, '')}`;
        add('funnel', 'Configuration Funnel', matching ? (connected ? 'ok' : 'warning') : 'warning', matching
          ? 'Une configuration Funnel cible cette application. L’accessibilité depuis Internet reste à tester en 4G/5G.'
          : endpoints.length
            ? 'Funnel est configuré pour un autre service ou chemin. Aucune configuration existante n’a été modifiée.'
            : 'Aucune publication Funnel détectée. Serve seul ne permet pas l’accès sans Tailscale.');
      } catch { add('funnel', 'Configuration Funnel', 'unknown', 'Configuration non reconnue : compatibilité Funnel non confirmée.'); }
    }
  }
  add('permissions', 'Droits d’activation', 'unknown',
    'Non testés : lire l’état ne prouve pas le droit d’activer Funnel. Aucune commande de modification n’est exécutée.');
  add('authorization', 'Autorisation HTTPS / Funnel', 'unknown',
    'L’autorisation du compte Tailscale n’est pas validée par ce diagnostic. Une première validation peut être nécessaire.');
  return {
    readOnly: true, checkedAt: new Date().toISOString(), serviceUser, binary, version, publicUrl, checks,
    notice: 'Ce diagnostic ne publie rien, ne change aucune permission et n’enregistre aucune adresse. Funnel est soumis à des limites de débit.',
  };
}

// Avoid spawning more processes on repeated clicks or simultaneous admin requests.
let cached: { until: number; result: ReturnType<typeof diagnoseTailscale> } | undefined;
export function tailscaleDiagnostic(port: number) {
  if (!cached || Date.now() >= cached.until) {
    cached = { until: Date.now() + 15_000, result: diagnoseTailscale(port) };
  }
  return cached.result;
}
