import type { LiveDeployment } from './api-types';
import type { VercelClient } from './client';

export interface WaitForDeploymentOptions {
  readonly client: VercelClient;
  readonly projectId: string;
  /** Git commit SHA the deployment was built from. */
  readonly sha: string;
  /** Git branch (ref) the deployment was built for. Recommended: one SHA can be built for several branches. */
  readonly ref?: string;
  /** Only accept deployments with this target. `preview` matches deployments with no target. */
  readonly target?: 'production' | 'preview';
  /** @default 600_000 (10 minutes) */
  readonly timeoutMs?: number;
  /** @default 15_000 */
  readonly intervalMs?: number;
  readonly onProgress?: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface ReadyDeployment {
  readonly id: string;
  readonly url: string;
  readonly inspectorUrl?: string;
  readonly target: string | null;
}

/** The deployment finished in a state that will never become READY. */
export class DeploymentFailedError extends Error {
  constructor(
    readonly state: string,
    readonly deployment: LiveDeployment,
  ) {
    super(
      `Deployment ${deployment.uid} for ${shaOf(deployment)?.slice(0, 12) ?? '?'}` +
        `${refOf(deployment) ? ` on ${refOf(deployment)}` : ''} is ${state}` +
        `${deployment.errorMessage ? `: ${deployment.errorMessage}` : ''}. Inspect: ${deployment.inspectorUrl ?? `https://${deployment.url}`}`,
    );
    this.name = 'DeploymentFailedError';
  }
}

export class DeploymentTimeoutError extends Error {
  constructor(
    message: string,
    readonly lastSeen?: LiveDeployment,
  ) {
    super(message);
    this.name = 'DeploymentTimeoutError';
  }
}

/** States that can never turn into READY. */
export const TERMINAL_FAILURE_STATES = new Set(['ERROR', 'CANCELED', 'DELETED']);

function shaOf(d: LiveDeployment): string | undefined {
  const m = d.meta ?? {};
  return m.githubCommitSha ?? m.gitlabCommitSha ?? m.bitbucketCommitSha;
}

function refOf(d: LiveDeployment): string | undefined {
  const m = d.meta ?? {};
  return m.githubCommitRef ?? m.gitlabCommitRef ?? m.bitbucketCommitRef;
}

const stateOf = (d: LiveDeployment) => (d.readyState ?? d.state ?? 'UNKNOWN').toUpperCase();

/**
 * Poll until the deployment for `sha` (and `ref`) is READY. Fails immediately when the
 * newest matching deployment is CANCELED or ERROR instead of waiting out the timeout,
 * which tells "not ready yet" apart from "will never be ready".
 */
export async function waitForDeployment(opts: WaitForDeploymentOptions): Promise<ReadyDeployment> {
  const timeout = opts.timeoutMs ?? 600_000;
  const interval = opts.intervalMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const progress = opts.onProgress ?? (() => {});
  const start = now();
  // Count slept time as well as wall time, so an injected sleep still reaches the deadline.
  let slept = 0;
  const elapsed = () => Math.max(now() - start, slept);
  let last: LiveDeployment | undefined;

  for (;;) {
    const res = await opts.client.get<{ deployments?: LiveDeployment[] }>('/v7/deployments', {
      projectId: opts.projectId,
      sha: opts.sha,
      ...(opts.ref ? { branch: opts.ref } : {}),
      limit: 20,
    });
    const matches = (res?.deployments ?? [])
      .filter((d) => shaOf(d) === opts.sha)
      .filter((d) => !opts.ref || refOf(d) === opts.ref)
      .filter(
        (d) =>
          !opts.target ||
          (opts.target === 'production' ? d.target === 'production' : d.target !== 'production'),
      )
      .sort((a, b) => (b.createdAt ?? b.created ?? 0) - (a.createdAt ?? a.created ?? 0));
    const newest = matches[0];

    if (newest) {
      last = newest;
      const state = stateOf(newest);
      if (state === 'READY') {
        return {
          id: newest.uid,
          url: newest.url ?? '',
          inspectorUrl: newest.inspectorUrl ?? undefined,
          target: newest.target ?? null,
        };
      }
      if (TERMINAL_FAILURE_STATES.has(state)) throw new DeploymentFailedError(state, newest);
      progress(`deployment ${newest.uid} is ${state}`);
    } else {
      progress(`no deployment yet for ${opts.sha.slice(0, 12)}${opts.ref ? ` on ${opts.ref}` : ''}`);
    }

    if (elapsed() + interval > timeout) {
      throw new DeploymentTimeoutError(
        `Timed out after ${Math.round(timeout / 1000)}s waiting for a READY deployment of ${opts.sha}` +
          `${opts.ref ? ` on ${opts.ref}` : ''}. ${last ? `Last state: ${stateOf(last)} (${last.inspectorUrl ?? last.uid}).` : 'No deployment was created.'}`,
        last,
      );
    }
    await sleep(interval);
    slept += interval;
  }
}
