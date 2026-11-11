import type { LiveEnvVar } from './api-types';
import { overlaps, sameSet } from './compare';
import type { VercelEnvTarget, VercelEnvType, VercelEnvVar } from './types';

/** Result of comparing a declared value to a live one. */
export type ValueComparison = 'same' | 'different' | 'unknown';

export type EnvAction =
  | { readonly op: 'create'; readonly decl: VercelEnvVar }
  | {
      readonly op: 'update';
      readonly decl: VercelEnvVar;
      readonly live: LiveEnvVar;
      /** Which properties differ. `value?` means the live value could not be read, so it is rewritten. */
      readonly changes: readonly string[];
    }
  /** Type changes can't be PATCHed reliably, so the record is deleted and created again. */
  | {
      readonly op: 'replace';
      readonly decl: VercelEnvVar;
      readonly live: LiveEnvVar;
      readonly changes: readonly string[];
    }
  | { readonly op: 'delete'; readonly live: LiveEnvVar; readonly reason: 'undeclared' | 'conflict' };

export interface EnvPlan {
  readonly actions: readonly EnvAction[];
  readonly unchanged: readonly { decl: VercelEnvVar; live: LiveEnvVar }[];
  /** Live vars that match no declaration and were not scheduled for deletion. */
  readonly undeclared: readonly LiveEnvVar[];
  /** Live vars that block a declaration but may not be deleted (pruning is off). */
  readonly conflicts: readonly { decl: VercelEnvVar; live: LiveEnvVar }[];
}

export interface EnvPlanOptions {
  readonly prune: boolean;
  /** Compare the declared value to the live record's value. */
  readonly compareValue: (decl: VercelEnvVar, live: LiveEnvVar) => ValueComparison;
  /**
   * How to treat values that cannot be compared (sensitive vars, secrets not resolved).
   * `rewrite` for apply (no-op writes are fine), `ignore` for drift checks.
   */
  readonly unknownValue: 'rewrite' | 'ignore';
}

export const DEFAULT_ENV_TYPE: VercelEnvType = 'encrypted';

export function liveTargets(v: LiveEnvVar): VercelEnvTarget[] {
  const t = v.target ?? [];
  return (Array.isArray(t) ? t : [t]) as VercelEnvTarget[];
}

const branchOf = (b: string | null | undefined) => b || null;

/** True for env vars owned by Vercel or an integration. They are never modified or deleted. */
export function isForeignEnv(v: LiveEnvVar): boolean {
  return v.type === 'system' || v.system === true || !!v.configurationId;
}

/** Human-readable identity, e.g. `API_URL[preview:staging]` or `API_URL[development,preview]`. */
export function envLabel(v: { key: string; gitBranch?: string | null }, targets: readonly string[]): string {
  const t = [...targets].sort().join(',');
  return `${v.key}[${t}${v.gitBranch ? `:${v.gitBranch}` : ''}]`;
}

/**
 * Match declared env vars to live records by key + target set + Git branch, and plan
 * the writes that make Vercel match the declaration.
 */
export function planEnv(
  declared: readonly VercelEnvVar[],
  live: readonly LiveEnvVar[],
  opts: EnvPlanOptions,
): EnvPlan {
  const managed = live.filter((v) => !isForeignEnv(v));
  const used = new Set<string>();
  const actions: EnvAction[] = [];
  const deletes: EnvAction[] = [];
  const unchanged: { decl: VercelEnvVar; live: LiveEnvVar }[] = [];
  const conflicts: { decl: VercelEnvVar; live: LiveEnvVar }[] = [];

  const sameKeyBranch = (d: VercelEnvVar, l: LiveEnvVar) =>
    l.key === d.key && branchOf(l.gitBranch) === branchOf(d.gitBranch);

  const pending: VercelEnvVar[] = [];
  // Pass 1: exact matches (key + branch + identical target set).
  for (const d of declared) {
    const match = managed.find(
      (l) => !used.has(l.id) && sameKeyBranch(d, l) && sameSet(liveTargets(l), d.targets),
    );
    if (match) {
      used.add(match.id);
      const a = compare(d, match, opts, false);
      if (a) actions.push(a);
      else unchanged.push({ decl: d, live: match });
    } else {
      pending.push(d);
    }
  }
  // Pass 2: reuse an overlapping record by changing its targets. Without pruning, only records
  // whose targets are all declared can be reused (widening is safe; narrowing would silently
  // remove the var from undeclared targets). Every other overlapping record is a conflict.
  for (const d of pending) {
    const overlapping = managed.filter(
      (l) => !used.has(l.id) && sameKeyBranch(d, l) && overlaps(liveTargets(l), d.targets),
    );
    const isSubset = (l: LiveEnvVar) => liveTargets(l).every((t) => d.targets.includes(t));
    const reuse = overlapping.find(isSubset) ?? (opts.prune ? overlapping[0] : undefined);
    if (reuse) {
      used.add(reuse.id);
      actions.push(compare(d, reuse, opts, true)!);
    }
    for (const c of overlapping) {
      if (c === reuse) continue;
      used.add(c.id);
      if (opts.prune) deletes.push({ op: 'delete', live: c, reason: 'conflict' });
      else conflicts.push({ decl: d, live: c });
    }
    // Without a reusable record, create one, unless an unprunable conflict blocks it.
    if (!reuse && (opts.prune || overlapping.length === 0)) actions.push({ op: 'create', decl: d });
  }

  const undeclared: LiveEnvVar[] = [];
  for (const l of managed) {
    if (used.has(l.id)) continue;
    if (opts.prune) deletes.push({ op: 'delete', live: l, reason: 'undeclared' });
    else undeclared.push(l);
  }

  // Deletes first so creates and target changes don't collide with records being removed.
  return { actions: [...deletes, ...actions], unchanged, undeclared, conflicts };
}

function compare(
  d: VercelEnvVar,
  l: LiveEnvVar,
  opts: EnvPlanOptions,
  targetsChanged: boolean,
): EnvAction | undefined {
  const changes: string[] = [];
  if (targetsChanged) changes.push('targets');
  const declaredType = d.type ?? DEFAULT_ENV_TYPE;
  const typeChanged = l.type !== declaredType;
  if (typeChanged) changes.push('type');
  if ((d.comment ?? '') !== (l.comment ?? '') && d.comment !== undefined) changes.push('comment');
  if (!typeChanged) {
    const v = opts.compareValue(d, l);
    if (v === 'different') changes.push('value');
    else if (v === 'unknown' && opts.unknownValue === 'rewrite') changes.push('value?');
  }
  if (changes.length === 0) return undefined;
  return typeChanged
    ? { op: 'replace', decl: d, live: l, changes }
    : { op: 'update', decl: d, live: l, changes };
}

/** Request body for creating or updating an env var. */
export function envBody(d: VercelEnvVar, value: string): Record<string, unknown> {
  return {
    key: d.key,
    value,
    type: d.type ?? DEFAULT_ENV_TYPE,
    target: [...d.targets],
    ...(d.gitBranch ? { gitBranch: d.gitBranch } : {}),
    ...(d.comment !== undefined ? { comment: d.comment } : {}),
  };
}
