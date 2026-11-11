import { createHmac } from 'node:crypto';
import type { LiveEnvVar, LiveProject, LiveProjectDomain } from './api-types';
import { listAll, VercelApiError, type VercelClient } from './client';
import { dnsTargetFromConfig, domainBody, planDomains } from './domains';
import { envBody, envLabel, liveTargets, planEnv, type ValueComparison } from './env';
import type { Logger } from './logger';
import { diffProtection, MANAGED_BYPASS_NOTE, planBypass } from './protection';
import { diffSettings, settingsWrites } from './settings';
import type { DnsTarget, SecretRef, VercelEnvVar, VercelProjectDeclaration } from './types';
import { assertValidDeclaration } from './validate';

export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}

/** Writes domain-verification TXT records (Route 53 in the handler). */
export interface TxtRecordWriter {
  /** Add values to the TXT record set at `name`, keeping any values already there. */
  addTxtValues(zoneId: string, name: string, values: readonly string[]): Promise<void>;
}

export interface ReconcileOptions {
  readonly declaration: VercelProjectDeclaration;
  readonly client: VercelClient;
  readonly secrets: SecretResolver;
  readonly logger: Logger;
  readonly txt?: TxtRecordWriter;
  /** Log the plan and skip every write. */
  readonly dryRun?: boolean;
  /** For `create` mode: the project ID returned by a previous create (the physical resource ID). */
  readonly existingProjectId?: string;
  /** Key for the `secretsHash` HMAC. The handler uses the Vercel token. */
  readonly secretsHashKey?: string;
}

export interface ReconcileResult {
  readonly projectId: string;
  readonly projectName: string;
  readonly dnsTargets: Record<string, DnsTarget>;
  /** SHA-256 over every resolved secret value, so a changed secret changes the resource's outputs. */
  readonly secretsHash: string;
  /** Number of writes made (or that would be made, in dry-run). */
  readonly changes: number;
  readonly dryRun: boolean;
}

export const DRY_RUN_ID_PREFIX = 'dry-run:';

/** Repository slug (`owner/name`) of a project's Git link, for any provider. */
export function linkedRepo(p: LiveProject): string | undefined {
  const l = p.link;
  if (!l) return undefined;
  if (l.org && l.repo) return `${l.org}/${l.repo}`;
  if (l.projectNamespace && l.projectName) return `${l.projectNamespace}/${l.projectName}`;
  if (l.owner && l.slug) return `${l.owner}/${l.slug}`;
  return undefined;
}

/** Refuse to act on a project outside the declared team or repository. */
export function checkGuards(d: VercelProjectDeclaration, p: LiveProject): void {
  if (d.teamId && p.accountId && p.accountId !== d.teamId) {
    throw new Error(
      `Refusing to manage project ${p.name} (${p.id}): it belongs to ${p.accountId}, not team ${d.teamId}.`,
    );
  }
  if (d.expectRepo) {
    const repo = linkedRepo(p);
    if (!repo || repo.toLowerCase() !== d.expectRepo.toLowerCase()) {
      throw new Error(
        `Refusing to manage project ${p.name} (${p.id}): it is linked to ${repo ?? 'no repository'}, expected ${d.expectRepo}.`,
      );
    }
  }
}

export async function reconcile(opts: ReconcileOptions): Promise<ReconcileResult> {
  const { declaration: d, client, logger } = opts;
  assertValidDeclaration(d);
  const dryRun = !!opts.dryRun;
  const resolved = new Map<string, string>();
  const resolve = async (ref: SecretRef) => {
    const id = `${ref.secretId}#${ref.jsonKey ?? ''}`;
    let v = resolved.get(id);
    if (v === undefined) {
      v = await opts.secrets.resolve(ref);
      client.redactor.add(v);
      resolved.set(id, v);
    }
    return v;
  };

  let changes = 0;
  const write = async (description: Record<string, unknown>, fn: () => Promise<unknown>) => {
    changes++;
    logger.log('info', dryRun ? 'would write' : 'write', { dryRun, ...description });
    if (!dryRun) await fn();
  };

  // 1. Find (or create) the project and check the guards.
  const loaded = await loadProject(opts, write);
  if (!loaded) {
    // Dry-run of a create: nothing exists to diff against yet.
    return {
      projectId: `${DRY_RUN_ID_PREFIX}${d.create!.name}`,
      projectName: d.create!.name,
      dnsTargets: {},
      secretsHash: hashSecrets(resolved, opts.secretsHashKey),
      changes,
      dryRun,
    };
  }
  let project = loaded;
  const pid = project.id;
  const base = `/v9/projects/${encodeURIComponent(pid)}`;
  const ctx = { project: project.name, projectId: pid };
  for (const secret of Object.keys(project.protectionBypass ?? {})) client.redactor.add(secret);
  checkGuards(d, project);

  // 2. Settings.
  const settingDiffs = diffSettings(d.settings, project);
  for (const diff of settingDiffs) {
    logger.log('info', 'setting drift', {
      ...ctx,
      field: diff.field,
      before: diff.actual,
      after: diff.expected,
    });
  }
  const sw = settingsWrites(settingDiffs);
  if (sw.patch) {
    await write({ ...ctx, action: 'update settings', fields: Object.keys(sw.patch) }, async () => {
      project = { ...project, ...(await client.request<LiveProject>('PATCH', base, { body: sw.patch })) };
    });
  }
  if (sw.productionBranch !== undefined) {
    await write({ ...ctx, action: 'set production branch', branch: sw.productionBranch }, () =>
      client.request('PATCH', `${base}/branch`, { body: { branch: sw.productionBranch } }).catch((err) => {
        // This endpoint is not in Vercel's published OpenAPI spec (the Terraform provider uses it).
        if (err instanceof VercelApiError && (err.status === 404 || err.status === 405)) {
          throw new Error(
            `${err.message}. Setting productionBranch uses Vercel's undocumented PATCH /v9/projects/{id}/branch ` +
              'endpoint, which may have changed. Set it in the dashboard and remove productionBranch from the declaration.',
          );
        }
        throw err;
      }),
    );
  }

  // 3. Env vars.
  if (d.env) await reconcileEnv(d, pid, opts, resolve, write, ctx);

  // 4. Domains and DNS targets.
  const dnsTargets: Record<string, DnsTarget> = {};
  if (d.domains) {
    await reconcileDomains(d, pid, opts, write, ctx);
    for (const dom of d.domains) {
      const config = await client.get<object>(`/v6/domains/${encodeURIComponent(dom.name)}/config`, {
        projectIdOrName: pid,
      });
      const t = dnsTargetFromConfig(config);
      if (t.fallback) {
        // A guessed target would end up in Route 53; only tolerate it when nothing is written.
        if (!dryRun) {
          throw new Error(
            `Vercel returned no recommended DNS target for ${dom.name} (GET /v6/domains/${dom.name}/config). ` +
              'Check the domain in the Vercel dashboard and redeploy.',
          );
        }
        logger.log('warn', 'Vercel returned no DNS recommendation; using defaults (dry run)', {
          ...ctx,
          domain: dom.name,
        });
      }
      dnsTargets[dom.name] = { cname: t.cname, ipv4: t.ipv4 };
    }
  }

  // 5. Deployment protection.
  if (d.protection) await reconcileProtection(d, project, opts, resolve, write, ctx);

  logger.log('info', 'reconcile complete', { ...ctx, changes, dryRun });
  return {
    projectId: pid,
    projectName: project.name,
    dnsTargets,
    secretsHash: hashSecrets(resolved, opts.secretsHashKey),
    changes,
    dryRun,
  };
}

type WriteFn = (description: Record<string, unknown>, fn: () => Promise<unknown>) => Promise<void>;

async function loadProject(opts: ReconcileOptions, write: WriteFn): Promise<LiveProject | undefined> {
  const { declaration: d, client } = opts;
  const get = (idOrName: string) =>
    client.getOrUndefined<LiveProject>(`/v9/projects/${encodeURIComponent(idOrName)}`);

  if (d.projectId) {
    const p = await get(d.projectId);
    if (!p)
      throw new Error(
        `Vercel project ${d.projectId} was not found${d.teamId ? ` in team ${d.teamId}` : ''}.`,
      );
    return p;
  }
  const create = d.create!;
  const existingId = opts.existingProjectId?.startsWith(DRY_RUN_ID_PREFIX)
    ? undefined
    : opts.existingProjectId;
  if (existingId) {
    const p = await get(existingId);
    if (!p)
      throw new Error(
        `Vercel project ${existingId} (created by this stack) no longer exists. It was deleted outside CDK.`,
      );
    if (p.name !== create.name) {
      await write({ project: p.name, projectId: p.id, action: 'rename project', to: create.name }, () =>
        client.request('PATCH', `/v9/projects/${encodeURIComponent(p.id)}`, { body: { name: create.name } }),
      );
    }
    return p;
  }
  const existing = await get(create.name);
  if (existing) {
    if (!create.adoptIfExists) {
      throw new Error(
        `A Vercel project named "${create.name}" already exists (${existing.id}). To manage it, adopt it with ` +
          `\`projectId: '${existing.id}'\`, or set \`create.adoptIfExists: true\` (e.g. after a failed create was rolled back).`,
      );
    }
    const repo = linkedRepo(existing);
    if (create.gitRepository && repo?.toLowerCase() !== create.gitRepository.repo.toLowerCase()) {
      throw new Error(
        `Refusing to adopt existing project "${create.name}" (${existing.id}): it is linked to ${repo ?? 'no repository'}, ` +
          `not ${create.gitRepository.repo}.`,
      );
    }
    opts.logger.log('info', 'adopting existing project (create.adoptIfExists)', {
      project: existing.name,
      projectId: existing.id,
    });
    return existing;
  }
  let created: LiveProject | undefined;
  await write({ project: create.name, action: 'create project' }, async () => {
    created = await client.request<LiveProject>('POST', '/v11/projects', {
      body: {
        name: create.name,
        ...(d.settings?.framework !== undefined ? { framework: d.settings.framework } : {}),
        ...(create.gitRepository
          ? { gitRepository: { type: create.gitRepository.type, repo: create.gitRepository.repo } }
          : {}),
      },
    });
  });
  return created ? ((await get(created.id)) ?? created) : undefined;
}

async function reconcileEnv(
  d: VercelProjectDeclaration,
  pid: string,
  opts: ReconcileOptions,
  resolve: (ref: SecretRef) => Promise<string>,
  write: WriteFn,
  ctx: Record<string, unknown>,
): Promise<void> {
  const { client, logger } = opts;
  const p = encodeURIComponent(pid);
  const live = await listAll<LiveEnvVar>(client, `/v10/projects/${p}/env`, 'envs');

  const declaredValues = new Map<VercelEnvVar, string>();
  for (const v of d.env!) declaredValues.set(v, v.secret ? await resolve(v.secret) : v.value!);

  // Encrypted values come back as ciphertext from the list call; decrypt the ones we may compare.
  const declaredKeys = new Set(d.env!.map((v) => v.key));
  const liveValues = new Map<string, string>();
  for (const l of live) {
    if (!declaredKeys.has(l.key)) continue;
    if (l.type === 'plain' && l.value !== undefined) liveValues.set(l.id, l.value);
    if (l.type === 'encrypted') {
      const full = await client.get<LiveEnvVar>(`/v1/projects/${p}/env/${encodeURIComponent(l.id)}`);
      if (full?.value !== undefined && full.decrypted !== false) {
        client.redactor.add(full.value);
        liveValues.set(l.id, full.value);
      }
    }
  }

  const plan = planEnv(d.env!, live, {
    prune: !!d.pruneUndeclaredEnv,
    unknownValue: 'rewrite',
    compareValue: (decl, l): ValueComparison => {
      const lv = liveValues.get(l.id);
      if (lv === undefined) return 'unknown';
      return lv === declaredValues.get(decl) ? 'same' : 'different';
    },
  });

  for (const u of plan.undeclared) {
    logger.log('warn', 'undeclared env var (set pruneUndeclaredEnv to delete)', {
      ...ctx,
      env: envLabel(u, liveTargets(u)),
      type: u.type,
    });
  }
  if (plan.conflicts.length) {
    const list = plan.conflicts.map(
      (c) => `${envLabel(c.live, liveTargets(c.live))} blocks ${envLabel(c.decl, c.decl.targets)}`,
    );
    throw new Error(
      `Env vars on ${ctx.project} overlap declared ones and cannot be reused: ${list.join('; ')}. ` +
        'Delete them in Vercel, or set pruneUndeclaredEnv: true.',
    );
  }

  const base = `/v9/projects/${p}/env`;
  const create = async (decl: VercelEnvVar) => {
    const res = await client.request<{ failed?: { error?: { message?: string } }[] }>(
      'POST',
      `/v10/projects/${p}/env`,
      {
        body: envBody(decl, declaredValues.get(decl)!),
      },
    );
    if (res?.failed?.length) {
      throw new Error(
        `Vercel rejected env var ${decl.key}: ${client.redactor.redactJson(res.failed.map((f) => f.error?.message ?? f))}`,
      );
    }
  };
  for (const a of plan.actions) {
    if (a.op === 'create') {
      await write(
        {
          ...ctx,
          action: 'create env',
          env: envLabel(a.decl, a.decl.targets),
          type: a.decl.type ?? 'encrypted',
        },
        () => create(a.decl),
      );
    } else if (a.op === 'update') {
      const detail = valueDetail(a.decl, a.live, a.changes, declaredValues);
      await write(
        {
          ...ctx,
          action: 'update env',
          env: envLabel(a.decl, a.decl.targets),
          from: envLabel(a.live, liveTargets(a.live)),
          changes: a.changes,
          ...detail,
        },
        () =>
          client.request('PATCH', `${base}/${encodeURIComponent(a.live.id)}`, {
            body: envBody(a.decl, declaredValues.get(a.decl)!),
          }),
      );
    } else if (a.op === 'replace') {
      await write(
        {
          ...ctx,
          action: 'replace env',
          env: envLabel(a.decl, a.decl.targets),
          changes: a.changes,
          before: a.live.type,
          after: a.decl.type ?? 'encrypted',
        },
        async () => {
          await client.request('DELETE', `${base}/${encodeURIComponent(a.live.id)}`);
          await create(a.decl);
        },
      );
    } else {
      await write(
        { ...ctx, action: 'delete env', env: envLabel(a.live, liveTargets(a.live)), reason: a.reason },
        () => client.request('DELETE', `${base}/${encodeURIComponent(a.live.id)}`),
      );
    }
  }
}

/** Before/after values for the audit log, only for plain literal values (never secrets). */
function valueDetail(
  decl: VercelEnvVar,
  live: LiveEnvVar,
  changes: readonly string[],
  values: Map<VercelEnvVar, string>,
) {
  if (!changes.includes('value') || decl.secret || (decl.type ?? 'encrypted') !== 'plain') return {};
  return { before: live.value ?? null, after: values.get(decl) };
}

async function reconcileDomains(
  d: VercelProjectDeclaration,
  pid: string,
  opts: ReconcileOptions,
  write: WriteFn,
  ctx: Record<string, unknown>,
): Promise<void> {
  const { client, logger, dryRun } = opts;
  const p = encodeURIComponent(pid);
  const live = await listAll<LiveProjectDomain>(client, `/v9/projects/${p}/domains`, 'domains', {
    limit: 100,
  });
  const plan = planDomains(d.domains!, live, !!d.pruneUndeclaredDomains);
  for (const u of plan.undeclared) {
    logger.log('warn', 'undeclared project domain (set pruneUndeclaredDomains to detach)', {
      ...ctx,
      domain: u.name,
    });
  }

  const state = new Map(live.map((l) => [l.name.toLowerCase(), l]));
  for (const a of plan.actions) {
    if (a.op === 'add') {
      await write({ ...ctx, action: 'add domain', domain: a.decl.name, ...domainBody(a.decl) }, async () => {
        const res = await client.request<LiveProjectDomain>('POST', `/v10/projects/${p}/domains`, {
          body: { name: a.decl.name, ...stripNulls(domainBody(a.decl)) },
        });
        state.set(a.decl.name.toLowerCase(), res);
      });
    } else if (a.op === 'update') {
      for (const c of a.changes)
        logger.log('info', 'domain drift', {
          ...ctx,
          domain: a.decl.name,
          field: c.field,
          before: c.actual,
          after: c.expected,
        });
      await write({ ...ctx, action: 'update domain', domain: a.decl.name }, () =>
        client.request('PATCH', `/v9/projects/${p}/domains/${encodeURIComponent(a.decl.name)}`, {
          body: domainBody(a.decl),
        }),
      );
    } else {
      await write({ ...ctx, action: 'remove domain', domain: a.live.name }, () =>
        client.request('DELETE', `/v9/projects/${p}/domains/${encodeURIComponent(a.live.name)}`),
      );
    }
  }

  // Ownership verification, when Vercel asks for it. Several subdomains of one apex share a
  // single `_vercel.<apex>` TXT record, so values are collected across all domains per
  // (zone, name) and added to whatever is already there, never replacing it.
  const pendingTxt = new Map<
    string,
    { zoneId: string; name: string; values: Set<string>; domains: string[] }
  >();
  const toVerify: string[] = [];
  for (const dom of d.domains!) {
    const s = state.get(dom.name.toLowerCase());
    if (!s || s.verified) continue;
    const txt = (s.verification ?? []).filter((v) => v.type.toUpperCase() === 'TXT');
    if (!dom.verificationZoneId || !opts.txt || txt.length === 0) {
      logger.log('warn', 'domain needs verification; add these DNS records or set verificationZoneId', {
        ...ctx,
        domain: dom.name,
        records: s.verification ?? [],
      });
      continue;
    }
    for (const r of txt) {
      // Only write what a Vercel ownership record can legitimately be. A malformed or hostile
      // response must not be able to write other TXT records (SPF, DKIM, ...) in the zone.
      if (!isVerificationRecordFor(dom.name, r)) {
        logger.log('warn', 'ignoring unexpected verification record; add it manually if it is genuine', {
          ...ctx,
          domain: dom.name,
          record: r.domain,
        });
        continue;
      }
      const id = `${dom.verificationZoneId}|${r.domain.toLowerCase()}`;
      const entry = pendingTxt.get(id) ?? {
        zoneId: dom.verificationZoneId,
        name: r.domain,
        values: new Set(),
        domains: [],
      };
      entry.values.add(r.value);
      if (!entry.domains.includes(dom.name)) entry.domains.push(dom.name);
      pendingTxt.set(id, entry);
    }
    toVerify.push(dom.name);
  }
  for (const e of pendingTxt.values()) {
    await write(
      { ...ctx, action: 'add verification TXT values', record: e.name, zoneId: e.zoneId, domains: e.domains },
      () => opts.txt!.addTxtValues(e.zoneId, e.name, [...e.values]),
    );
  }
  if (dryRun) return;
  // Verify only after every record is written.
  for (const name of toVerify) {
    try {
      await client.request('POST', `/v9/projects/${p}/domains/${encodeURIComponent(name)}/verify`);
    } catch (err) {
      if (!(err instanceof VercelApiError) || err.status >= 500) throw err;
      logger.log('warn', 'domain not verified yet (DNS may still be propagating); the next deploy retries', {
        ...ctx,
        domain: name,
        error: err.message,
      });
    }
  }
}

/**
 * A Vercel verification record is `_vercel.<suffix>` where `<suffix>` is the domain or one of
 * its parents (normally the apex), with a `vc-domain-verify=` value.
 */
export function isVerificationRecordFor(domain: string, r: { domain: string; value: string }): boolean {
  const name = r.domain.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase();
  if (!name.startsWith('_vercel.')) return false;
  const suffix = name.slice('_vercel.'.length);
  const domainMatches = suffix.includes('.') && (d === suffix || d.endsWith(`.${suffix}`));
  return domainMatches && /^vc-domain-verify=[\x21-\x7e]{1,250}$/.test(r.value);
}

async function reconcileProtection(
  d: VercelProjectDeclaration,
  project: LiveProject,
  opts: ReconcileOptions,
  resolve: (ref: SecretRef) => Promise<string>,
  write: WriteFn,
  ctx: Record<string, unknown>,
): Promise<void> {
  const { client, logger } = opts;
  const prot = d.protection!;
  const p = encodeURIComponent(project.id);

  const patch: Record<string, unknown> = {};
  for (const diff of diffProtection(prot, project)) {
    logger.log('info', 'protection drift', {
      ...ctx,
      field: diff.field,
      before: diff.actual,
      after: diff.expected,
    });
    if (diff.field === 'protection.vercelAuthentication') {
      patch.ssoProtection = prot.vercelAuthentication ? { deploymentType: prot.vercelAuthentication } : null;
    }
    if (diff.field === 'protection.passwordProtection' && prot.passwordProtection === null)
      patch.passwordProtection = null;
  }
  if (Object.keys(patch).length) {
    await write({ ...ctx, action: 'update protection', fields: Object.keys(patch) }, () =>
      client.request('PATCH', `/v9/projects/${p}`, { body: patch }),
    );
  }
  if (prot.passwordProtection) {
    // The password can't be read back, so it is always (re)written. Not counted as drift.
    const password = await resolve(prot.passwordProtection.password);
    logger.log(
      'debug',
      opts.dryRun ? 'would rewrite password protection' : 'rewriting password protection',
      ctx,
    );
    if (!opts.dryRun) {
      await client.request('PATCH', `/v9/projects/${p}`, {
        body: { passwordProtection: { deploymentType: prot.passwordProtection.scope, password } },
      });
    }
  }

  if (prot.automationBypass) {
    const secrets: string[] = [];
    for (const ref of prot.automationBypass.secrets) secrets.push(await resolve(ref));
    const plan = planBypass(secrets, !!prot.automationBypass.pruneUnmanaged, project);
    if (plan.unmanaged) {
      logger.log(
        'warn',
        'automation bypass secrets not managed by cdk-vercel are present (set pruneUnmanaged to revoke)',
        {
          ...ctx,
          count: plan.unmanaged,
        },
      );
    }
    const url = `/v1/projects/${p}/protection-bypass`;
    for (const a of plan.actions) {
      if (a.op === 'generate') {
        await write({ ...ctx, action: 'add automation bypass' }, () =>
          client.request('PATCH', url, {
            body: { generate: { secret: a.secret, note: MANAGED_BYPASS_NOTE } },
          }),
        );
      } else if (a.op === 'make-default') {
        await write({ ...ctx, action: 'make declared automation bypass the default' }, () =>
          client.request('PATCH', url, { body: { update: { secret: a.secret, isEnvVar: true } } }),
        );
      } else {
        await write({ ...ctx, action: 'revoke automation bypass', managed: a.managed }, () =>
          client.request('PATCH', url, { body: { revoke: { secret: a.secret, regenerate: false } } }),
        );
      }
    }
  }
}

function stripNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

/** HMAC, not a bare hash, so low-entropy secrets can't be brute-forced from the attribute. */
function hashSecrets(resolved: Map<string, string>, key = ''): string {
  const h = createHmac('sha256', `cdk-vercel:${key}`);
  for (const [k, v] of [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b)))
    h.update(`${k}\n${v}\n`);
  return h.digest('hex');
}
