import type { VercelProjectDeclaration } from './runtime/types';
import type { VercelProject } from './vercel-project';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSION: string = require('../package.json').version;

export interface CliCommandOptions {
  /** npm package spec to run. Pin it so the gate matches the construct version. @default `cdk-vercel@<this version>` */
  readonly packageSpec?: string;
  /** Environment variable holding the Vercel token in the build environment. @default VERCEL_TOKEN */
  readonly tokenEnvVar?: string;
}

/** Double-quote for POSIX shells. `$VARS` still expand, so you can pass e.g. `$CODEBUILD_RESOLVED_SOURCE_VERSION`. */
function q(v: string): string {
  return `"${v.replace(/(["\\`])/g, '\\$1')}"`;
}

function npx(opts: CliCommandOptions): string {
  return `npx --yes ${opts.packageSpec ?? `cdk-vercel@${VERSION}`}`;
}

/**
 * A shell command for a pipeline step (e.g. CodeBuild) that fails, naming
 * `project / field / expected / actual`, when any project differs from its declaration.
 * The declarations are embedded from the same objects the constructs use, so the
 * gate and the stack can't disagree.
 */
export function driftGateCommand(
  projects: readonly (VercelProject | VercelProjectDeclaration)[],
  opts: CliCommandOptions = {},
): string {
  const declarations = projects.map((p) =>
    'declaration' in p && 'resource' in p ? p.declaration : (p as VercelProjectDeclaration),
  );
  const b64 = Buffer.from(JSON.stringify(declarations)).toString('base64');
  return `${npx(opts)} drift --token-env ${opts.tokenEnvVar ?? 'VERCEL_TOKEN'} --declarations-base64 ${b64}`;
}

export interface WaitForDeploymentCommandOptions extends CliCommandOptions {
  readonly projectId: string;
  readonly teamId?: string;
  readonly sha: string;
  readonly ref?: string;
  readonly target?: 'production' | 'preview';
  /** @default 600 */
  readonly timeoutSeconds?: number;
  /** @default 15 */
  readonly intervalSeconds?: number;
}

/**
 * A shell command that waits for the deployment of a commit to be READY and prints its
 * URL on stdout. It exits non-zero at once if the deployment is CANCELED or ERROR.
 * Capture the URL with `url=$(<command>)`.
 */
export function waitForDeploymentCommand(o: WaitForDeploymentCommandOptions): string {
  const parts = [
    npx(o),
    'wait-deployment',
    `--token-env ${o.tokenEnvVar ?? 'VERCEL_TOKEN'}`,
    `--project ${q(o.projectId)}`,
    o.teamId ? `--team ${q(o.teamId)}` : '',
    `--sha ${q(o.sha)}`,
    o.ref ? `--ref ${q(o.ref)}` : '',
    o.target ? `--target ${o.target}` : '',
    o.timeoutSeconds !== undefined ? `--timeout ${o.timeoutSeconds}` : '',
    o.intervalSeconds !== undefined ? `--interval ${o.intervalSeconds}` : '',
  ];
  return parts.filter(Boolean).join(' ');
}
