import type { LiveEnvVar, LiveProject, LiveProjectDomain } from './api-types';
import { listAll, type VercelClient } from './client';
import { planDomains } from './domains';
import { DEFAULT_ENV_TYPE, envLabel, liveTargets, planEnv, type ValueComparison } from './env';
import { diffProtection } from './protection';
import { checkGuards } from './reconcile';
import { diffSettings } from './settings';
import type { VercelProjectDeclaration } from './types';

export interface DriftItem {
  readonly project: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  /** `error` fails the gate. `warning` is reported only (e.g. undeclared env vars while pruning is off). */
  readonly severity: 'error' | 'warning';
}

export interface DriftReport {
  readonly project: string;
  readonly projectId?: string;
  readonly items: readonly DriftItem[];
}

/**
 * Compare a declaration to the live project without writing anything. Values that can't
 * be read with only a Vercel token (secret-backed and `sensitive` env vars, bypass
 * secrets, passwords) are checked for presence and shape only.
 */
export async function checkDrift(d: VercelProjectDeclaration, client: VercelClient): Promise<DriftReport> {
  const label = d.projectId ?? d.create?.name ?? '(unknown)';
  const items: DriftItem[] = [];
  const add = (
    field: string,
    expected: unknown,
    actual: unknown,
    severity: DriftItem['severity'] = 'error',
  ) => items.push({ project: label, field, expected, actual, severity });

  const idOrName = d.projectId ?? d.create!.name;
  const project = await client.getOrUndefined<LiveProject>(`/v9/projects/${encodeURIComponent(idOrName)}`);
  if (!project) {
    add('project', 'exists', 'not found');
    return { project: label, items };
  }
  const name = project.name;
  const report = (): DriftReport => ({
    project: name,
    projectId: project.id,
    items: items.map((i) => ({ ...i, project: name })),
  });

  try {
    checkGuards(d, project);
  } catch (err) {
    add('guard', d.expectRepo ?? d.teamId, (err as Error).message);
    return report();
  }

  for (const diff of diffSettings(d.settings, project))
    add(`settings.${diff.field}`, diff.expected, diff.actual);
  for (const diff of diffProtection(d.protection, project)) add(diff.field, diff.expected, diff.actual);

  const p = encodeURIComponent(project.id);
  if (d.env) {
    const live = await listAll<LiveEnvVar>(client, `/v10/projects/${p}/env`, 'envs');
    const decrypted = new Map<string, string | undefined>();
    const readLive = async (l: LiveEnvVar) => {
      if (l.type === 'plain') return l.value;
      if (l.type !== 'encrypted') return undefined;
      if (!decrypted.has(l.id)) {
        const full = await client.get<LiveEnvVar>(`/v1/projects/${p}/env/${encodeURIComponent(l.id)}`);
        if (full?.value) client.redactor.add(full.value);
        decrypted.set(l.id, full?.decrypted === false ? undefined : full?.value);
      }
      return decrypted.get(l.id);
    };
    // Pre-read live values for literal declarations so the (synchronous) planner can compare them.
    const literalKeys = new Set(
      d.env
        .filter((v) => v.value !== undefined && (v.type ?? DEFAULT_ENV_TYPE) !== 'sensitive')
        .map((v) => v.key),
    );
    for (const l of live) if (literalKeys.has(l.key)) await readLive(l);

    const plan = planEnv(d.env, live, {
      prune: !!d.pruneUndeclaredEnv,
      unknownValue: 'ignore',
      compareValue: (decl, l): ValueComparison => {
        if (decl.value === undefined) return 'unknown';
        const lv = l.type === 'plain' ? l.value : decrypted.get(l.id);
        if (lv === undefined) return 'unknown';
        return lv === decl.value ? 'same' : 'different';
      },
    });
    for (const a of plan.actions) {
      if (a.op === 'create') add(`env.${envLabel(a.decl, a.decl.targets)}`, 'present', 'missing');
      else if (a.op === 'update' || a.op === 'replace') {
        for (const c of a.changes) {
          const field = `env.${envLabel(a.decl, a.decl.targets)}.${c}`;
          if (c === 'targets') add(field, [...a.decl.targets].sort(), liveTargets(a.live).sort());
          else if (c === 'type') add(field, a.decl.type ?? DEFAULT_ENV_TYPE, a.live.type);
          else if (c === 'comment') add(field, a.decl.comment, a.live.comment ?? null);
          else if (c === 'value' && (a.decl.type ?? DEFAULT_ENV_TYPE) === 'plain')
            add(field, a.decl.value, a.live.value ?? null);
          else if (c === 'value') add(field, '(declared value)', '(different value)');
        }
      } else add(`env.${envLabel(a.live, liveTargets(a.live))}`, 'absent', `present (${a.reason})`);
    }
    for (const c of plan.conflicts)
      add(
        `env.${envLabel(c.live, liveTargets(c.live))}`,
        'absent',
        `overlaps ${envLabel(c.decl, c.decl.targets)}`,
      );
    for (const u of plan.undeclared)
      add(`env.${envLabel(u, liveTargets(u))}`, 'undeclared', 'present', 'warning');
  }

  if (d.domains) {
    const live = await listAll<LiveProjectDomain>(client, `/v9/projects/${p}/domains`, 'domains', {
      limit: 100,
    });
    const plan = planDomains(d.domains, live, !!d.pruneUndeclaredDomains);
    for (const a of plan.actions) {
      if (a.op === 'add') add(`domains.${a.decl.name}`, 'attached', 'missing');
      else if (a.op === 'update')
        for (const c of a.changes) add(`domains.${a.decl.name}.${c.field}`, c.expected, c.actual);
      else add(`domains.${a.live.name}`, 'detached', 'attached');
    }
    for (const u of plan.undeclared) add(`domains.${u.name}`, 'undeclared', 'attached', 'warning');
  }

  return report();
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** One line per item: `project / field / expected / actual`. */
export function formatDrift(reports: readonly DriftReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    for (const i of r.items) {
      lines.push(
        `${i.severity === 'error' ? 'DRIFT' : 'WARN '} ${r.project} / ${i.field} / expected ${show(i.expected)} / actual ${show(i.actual)}`,
      );
    }
  }
  return lines.join('\n');
}

export function hasDriftErrors(reports: readonly DriftReport[]): boolean {
  return reports.some((r) => r.items.some((i) => i.severity === 'error'));
}
