import type { LiveProject } from './api-types';
import type { FieldDiff } from './settings';
import type { VercelProtection } from './types';

/** Note attached to bypass secrets this library creates, so rotation can revoke the old ones. */
export const MANAGED_BYPASS_NOTE = 'managed by cdk-vercel';

/**
 * Compare Vercel Authentication and Password Protection scopes. Password values can't be
 * read back, so they aren't compared here (apply rewrites them every time).
 */
export function diffProtection(declared: VercelProtection | undefined, live: LiveProject): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (!declared) return diffs;
  if (declared.vercelAuthentication !== undefined) {
    const actual = live.ssoProtection?.deploymentType ?? null;
    if (actual !== declared.vercelAuthentication) {
      diffs.push({
        field: 'protection.vercelAuthentication',
        expected: declared.vercelAuthentication,
        actual,
      });
    }
  }
  if (declared.passwordProtection !== undefined) {
    const actual = live.passwordProtection?.deploymentType ?? null;
    const expected = declared.passwordProtection?.scope ?? null;
    if (actual !== expected) diffs.push({ field: 'protection.passwordProtection', expected, actual });
  }
  return diffs;
}

export type BypassAction =
  | { readonly op: 'generate'; readonly secret: string }
  | { readonly op: 'make-default'; readonly secret: string }
  | { readonly op: 'revoke'; readonly secret: string; readonly managed: boolean };

/** Plan automation-bypass writes given the declared (resolved) secret values. */
export function planBypass(
  declaredSecrets: readonly string[],
  pruneUnmanaged: boolean,
  live: LiveProject,
): { actions: BypassAction[]; unmanaged: number } {
  const entries = Object.entries(live.protectionBypass ?? {}).filter(
    ([, v]) => v.scope === 'automation-bypass',
  );
  const liveSecrets = new Set(entries.map(([k]) => k));
  const declared = new Set(declaredSecrets);
  const actions: BypassAction[] = [];

  for (const s of declared) if (!liveSecrets.has(s)) actions.push({ op: 'generate', secret: s });

  const revokes: BypassAction[] = [];
  let unmanaged = 0;
  let revokingDefault = false;
  for (const [secret, entry] of entries) {
    if (declared.has(secret)) continue;
    const managed = entry.note === MANAGED_BYPASS_NOTE;
    if (managed || pruneUnmanaged) {
      revokes.push({ op: 'revoke', secret, managed });
      // `isEnvVar` undefined means "is the default" on older records.
      if (entry.isEnvVar !== false) revokingDefault = true;
    } else {
      unmanaged++;
    }
  }
  // Vercel needs exactly one default (env var) bypass; hand that role to a declared one first.
  const first = declaredSecrets[0];
  if (revokingDefault && first !== undefined) actions.push({ op: 'make-default', secret: first });
  actions.push(...revokes);
  return { actions, unmanaged };
}
