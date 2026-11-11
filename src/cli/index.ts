#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { VercelClient } from '../runtime/client';
import { DeploymentFailedError, waitForDeployment } from '../runtime/deployments';
import { checkDrift, type DriftReport, formatDrift, hasDriftErrors } from '../runtime/drift';
import type { VercelProjectDeclaration } from '../runtime/types';
import { validateDeclaration } from '../runtime/validate';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSION: string = require('../../package.json').version;

const HELP = `cdk-vercel ${VERSION}

Usage:
  cdk-vercel drift [options]
      Compare declared Vercel projects to their live state. Exits 1 on drift.
      --declarations <json>            JSON array (or single object) of declarations
      --declarations-base64 <b64>      Same, base64-encoded
      --declarations-file <path>       Same, read from a file
      --json                           Print the reports as JSON
      --token-env <NAME>               Env var holding the Vercel token (default VERCEL_TOKEN)

  cdk-vercel wait-deployment [options]
      Wait for a commit's deployment to be READY; print its URL. Fails fast on CANCELED/ERROR.
      --project <id>   --sha <sha>   [--team <id>]   [--ref <branch>]
      [--target production|preview]  [--timeout <seconds=600>]  [--interval <seconds=15>]
      --token-env <NAME>               Env var holding the Vercel token (default VERCEL_TOKEN)

Exit codes: 0 ok, 1 drift / deployment failed or timed out, 2 usage or API error.
`;

export interface CliIo {
  readonly env: Record<string, string | undefined>;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly fetch?: ConstructorParameters<typeof VercelClient>[0]['fetch'];
  readonly sleep?: (ms: number) => Promise<void>;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): { command?: string; flags: Record<string, string | true> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new UsageError(`Unexpected argument: ${a}`);
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (inline !== undefined) flags[name] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) flags[name] = rest[++i]!;
    else flags[name] = true;
  }
  return { command, flags };
}

function str(flags: Record<string, string | true>, name: string, required: true): string;
function str(flags: Record<string, string | true>, name: string, required?: false): string | undefined;
function str(flags: Record<string, string | true>, name: string, required = false): string | undefined {
  const v = flags[name];
  if (v === true) throw new UsageError(`--${name} needs a value`);
  if (required && v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

function num(flags: Record<string, string | true>, name: string, fallback: number): number {
  const v = str(flags, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number`);
  return n;
}

function token(flags: Record<string, string | true>, io: CliIo): string {
  const name = str(flags, 'token-env') ?? 'VERCEL_TOKEN';
  const t = io.env[name];
  if (!t) throw new UsageError(`Set the Vercel token in $${name}`);
  return t;
}

function readDeclarations(flags: Record<string, string | true>): VercelProjectDeclaration[] {
  const inline = str(flags, 'declarations');
  const b64 = str(flags, 'declarations-base64');
  const file = str(flags, 'declarations-file');
  if ([inline, b64, file].filter((x) => x !== undefined).length !== 1) {
    throw new UsageError('Pass exactly one of --declarations, --declarations-base64, --declarations-file');
  }
  const raw =
    inline ?? (b64 !== undefined ? Buffer.from(b64, 'base64').toString('utf8') : readFileSync(file!, 'utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`Declarations are not valid JSON: ${(err as Error).message}`);
  }
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as VercelProjectDeclaration[];
  list.forEach((d, i) => {
    const errors = validateDeclaration(d);
    if (errors.length) throw new UsageError(`Declaration ${i} is invalid:\n  - ${errors.join('\n  - ')}`);
  });
  return list;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { command, flags } = parsed;
  if (!command || command === 'help' || command === '--help' || command === '-h' || flags.help) {
    io.stdout(HELP);
    return 0;
  }
  if (command === '--version' || command === 'version') {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  try {
    if (command === 'drift') {
      const declarations = readDeclarations(flags);
      const tok = token(flags, io);
      const reports: DriftReport[] = [];
      for (const d of declarations) {
        const client = new VercelClient({ token: tok, teamId: d.teamId, fetch: io.fetch, sleep: io.sleep });
        reports.push(await checkDrift(d, client));
      }
      const failed = hasDriftErrors(reports);
      if (flags.json) io.stdout(`${JSON.stringify(reports, null, 2)}\n`);
      else {
        const text = formatDrift(reports);
        if (text) io.stdout(`${text}\n`);
        io.stdout(
          failed
            ? `\nVercel configuration drift detected. Fix the dashboard or update the declaration, then redeploy.\n`
            : `No drift in ${reports.length} Vercel project(s).\n`,
        );
      }
      return failed ? 1 : 0;
    }

    if (command === 'wait-deployment') {
      const client = new VercelClient({
        token: token(flags, io),
        teamId: str(flags, 'team'),
        fetch: io.fetch,
        sleep: io.sleep,
      });
      const target = str(flags, 'target');
      if (target !== undefined && target !== 'production' && target !== 'preview')
        throw new UsageError('--target must be production or preview');
      try {
        const d = await waitForDeployment({
          client,
          projectId: str(flags, 'project', true),
          sha: str(flags, 'sha', true),
          ref: str(flags, 'ref'),
          target,
          timeoutMs: num(flags, 'timeout', 600) * 1000,
          intervalMs: num(flags, 'interval', 15) * 1000,
          onProgress: (m) => io.stderr(`${m}\n`),
          sleep: io.sleep,
        });
        io.stderr(`READY: https://${d.url} (${d.id})\n`);
        io.stdout(`${d.url}\n`);
        return 0;
      } catch (err) {
        io.stderr(
          `${err instanceof DeploymentFailedError ? 'FAILED' : 'ERROR'}: ${(err as Error).message}\n`,
        );
        return err instanceof UsageError ? 2 : 1;
      }
    }

    throw new UsageError(`Unknown command: ${command}`);
  } catch (err) {
    if (err instanceof UsageError) io.stderr(`${err.message}\n\nRun "cdk-vercel --help" for usage.\n`);
    else io.stderr(`ERROR: ${(err as Error).message}\n`);
    return 2;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }).then((code) => {
    process.exitCode = code;
  });
}
