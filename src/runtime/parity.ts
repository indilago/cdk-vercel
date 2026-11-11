import type { VercelEnvTarget, VercelEnvVar } from './types';

/** One "environment" as Vercel resolves env vars for a deployment. */
export interface EnvSlice {
  readonly name: string;
  readonly target: VercelEnvTarget;
  /** For preview deployments of a specific branch. Branch-scoped vars override branch-less ones. */
  readonly gitBranch?: string;
}

export interface EnvParityOptions {
  readonly a: EnvSlice;
  readonly b: EnvSlice;
  /**
   * Keys whose values differ because they are derived from the environment
   * (e.g. API URLs). Map of key to reason.
   */
  readonly derivedDivergentKeys?: Readonly<Record<string, string>>;
  /** Keys that differ on purpose and change behaviour (e.g. analytics off in staging). Map of key to reason. */
  readonly behaviouralDivergentKeys?: Readonly<Record<string, string>>;
  /** Keys deliberately present in only one slice. Map of key to reason. */
  readonly singleSliceKeys?: Readonly<Record<string, string>>;
}

export interface ParityIssue {
  readonly key: string;
  readonly problem: 'missing' | 'undeclared-divergence' | 'stale-exception';
  readonly message: string;
}

/** The env var Vercel would apply for a slice: branch-scoped wins over branch-less. */
export function effectiveEnv(env: readonly VercelEnvVar[], slice: EnvSlice): Map<string, VercelEnvVar> {
  const out = new Map<string, VercelEnvVar>();
  for (const v of env) {
    if (!v.targets.includes(slice.target)) continue;
    if (v.gitBranch && v.gitBranch !== slice.gitBranch) continue;
    const existing = out.get(v.key);
    if (!existing || (v.gitBranch && !existing.gitBranch)) out.set(v.key, v);
  }
  return out;
}

const valueId = (v: VercelEnvVar) =>
  v.secret ? `secret:${v.secret.secretId}#${v.secret.jsonKey ?? ''}` : `value:${v.value}`;

/**
 * Check that two environments (e.g. staging previews and production) declare the same
 * keys, and that every key whose value differs is listed with a reason. Listed
 * exceptions that no longer apply are reported too, so the lists stay honest.
 */
export function checkEnvParity(env: readonly VercelEnvVar[], opts: EnvParityOptions): ParityIssue[] {
  const a = effectiveEnv(env, opts.a);
  const b = effectiveEnv(env, opts.b);
  const derived = opts.derivedDivergentKeys ?? {};
  const behavioural = opts.behaviouralDivergentKeys ?? {};
  const single = opts.singleSliceKeys ?? {};
  const issues: ParityIssue[] = [];

  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(key);
    const vb = b.get(key);
    if (!va || !vb) {
      if (!(key in single)) {
        const [has, lacks] = va ? [opts.a.name, opts.b.name] : [opts.b.name, opts.a.name];
        issues.push({
          key,
          problem: 'missing',
          message: `${key} is set for ${has} but not ${lacks}; declare it for both or list it in singleSliceKeys.`,
        });
      }
      continue;
    }
    const differs = valueId(va) !== valueId(vb);
    const listed = key in derived || key in behavioural;
    if (differs && !listed) {
      issues.push({
        key,
        problem: 'undeclared-divergence',
        message: `${key} differs between ${opts.a.name} and ${opts.b.name}; list it in derivedDivergentKeys or behaviouralDivergentKeys with a reason.`,
      });
    }
    if (!differs && listed) {
      issues.push({
        key,
        problem: 'stale-exception',
        message: `${key} is listed as divergent but has the same value in both; remove it from the list.`,
      });
    }
  }
  for (const key of Object.keys(single)) {
    if (a.has(key) && b.has(key)) {
      issues.push({
        key,
        problem: 'stale-exception',
        message: `${key} is listed in singleSliceKeys but is set for both; remove it from the list.`,
      });
    }
  }
  for (const key of [...Object.keys(derived), ...Object.keys(behavioural)]) {
    if (!a.has(key) && !b.has(key)) {
      issues.push({
        key,
        problem: 'stale-exception',
        message: `${key} is listed as divergent but is not declared; remove it from the list.`,
      });
    }
  }
  return issues;
}
