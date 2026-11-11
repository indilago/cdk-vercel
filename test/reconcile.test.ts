import { describe, expect, it } from 'vitest';
import type { LiveProject } from '../src/runtime/api-types';
import { VercelApiError } from '../src/runtime/client';
import { memoryLogger } from '../src/runtime/logger';
import { MANAGED_BYPASS_NOTE } from '../src/runtime/protection';
import { reconcile } from '../src/runtime/reconcile';
import { Redactor } from '../src/runtime/redact';
import { fixture, memorySecrets, TOKEN } from './fake-vercel';
import { SECRETS, seededFake, TEAM, WEB_ID, webDeclaration } from './seed';

function run(
  fake: ReturnType<typeof seededFake>,
  declaration = webDeclaration(),
  extra: Partial<Parameters<typeof reconcile>[0]> = {},
) {
  const redactor = new Redactor();
  const logger = memoryLogger();
  const txt = {
    calls: [] as { zoneId: string; name: string; values: readonly string[] }[],
    async addTxtValues(zoneId: string, name: string, values: readonly string[]) {
      this.calls.push({ zoneId, name, values });
    },
  };
  const promise = reconcile({
    declaration,
    client: fake.client({ teamId: declaration.teamId, redactor }),
    secrets: memorySecrets(SECRETS),
    logger,
    txt,
    ...extra,
  });
  return { promise, logger, txt, redactor };
}

const writesExceptSensitive = (fake: ReturnType<typeof seededFake>) =>
  fake.writes.filter(
    (w) => !(w.method === 'PATCH' && w.path.includes('/env/') && w.body?.type === 'sensitive'),
  );

describe('reconcile', () => {
  it('makes no writes when the declaration matches live state, apart from write-only sensitive values', async () => {
    const fake = seededFake();
    const { promise } = run(fake);
    const result = await promise;
    expect(writesExceptSensitive(fake)).toEqual([]);
    // Sensitive values can't be read back, so they are rewritten with the same value (a no-op write).
    expect(fake.writes).toHaveLength(2);
    expect(result).toMatchObject({ projectId: WEB_ID, projectName: 'acme-web', dryRun: false });
    expect(result.dnsTargets['app.example.com']).toEqual({
      cname: 'd1d4fc829fe7bc7c.vercel-dns-017.com',
      ipv4: '216.198.79.1',
    });
  });

  it('is idempotent: a second run with identical props writes nothing new', async () => {
    const fake = seededFake();
    const decl = webDeclaration({ env: webDeclaration().env!.filter((e) => e.type !== 'sensitive') });
    await run(fake, decl).promise;
    expect(fake.writes).toEqual([]);
    await run(fake, decl).promise;
    expect(fake.writes).toEqual([]);
  });

  it('corrects drifted settings with only the changed fields, logging before and after', async () => {
    const fake = seededFake();
    const p = fake.projects.get(WEB_ID)!;
    p.enableAffectedProjectsDeployments = true; // someone flipped it in the dashboard
    p.link!.productionBranch = 'main';
    const { promise, logger } = run(fake, webDeclaration({ env: undefined, domains: undefined }));
    await promise;

    expect(fake.writes).toEqual([
      {
        method: 'PATCH',
        path: `/v9/projects/${WEB_ID}`,
        query: { teamId: TEAM },
        body: { enableAffectedProjectsDeployments: false },
      },
      {
        method: 'PATCH',
        path: `/v9/projects/${WEB_ID}/branch`,
        query: { teamId: TEAM },
        body: { branch: 'production' },
      },
    ]);
    expect(logger.entries.filter((e) => e.message === 'setting drift')).toMatchObject([
      { project: 'acme-web', field: 'enableAffectedProjectsDeployments', before: true, after: false },
      { project: 'acme-web', field: 'productionBranch', before: 'main', after: 'production' },
    ]);
    expect(p.enableAffectedProjectsDeployments).toBe(false);
  });

  it('never writes undeclared settings', async () => {
    const fake = seededFake();
    fake.projects.get(WEB_ID)!.nodeVersion = '22.x';
    await run(
      fake,
      webDeclaration({ settings: { rootDirectory: 'packages/app' }, env: undefined, domains: undefined }),
    ).promise;
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]!.body).toEqual({ rootDirectory: 'packages/app' });
  });

  it('refuses a project linked to a different repository, before any write', async () => {
    const fake = seededFake();
    const { promise } = run(
      fake,
      webDeclaration({ expectRepo: 'acme/other', settings: { nodeVersion: '22.x' } }),
    );
    await expect(promise).rejects.toThrow(/linked to acme\/web-monorepo, expected acme\/other/);
    expect(fake.writes).toEqual([]);
  });

  it('refuses a project in a different team', async () => {
    const fake = seededFake();
    fake.projects.get(WEB_ID)!.accountId = 'team_someone_else';
    await expect(run(fake).promise).rejects.toThrow(/belongs to team_someone_else, not team team_acme/);
    expect(fake.writes).toEqual([]);
  });

  it('fails with the HTTP status and Vercel error body, with the token redacted', async () => {
    const fake = seededFake();
    fake.projects.get(WEB_ID)!.nodeVersion = '22.x';
    fake.queued.push({ status: 200, body: fake.projects.get(WEB_ID) }); // GET project
    fake.queued.push({
      status: 400,
      body: { error: { code: 'bad_request', message: `Invalid nodeVersion (token ${TOKEN})` } },
    });
    const err = await run(fake, webDeclaration({ env: undefined, domains: undefined })).promise.catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(VercelApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('PATCH /v9/projects/prj_web000000000000000000001 failed: HTTP 400');
    expect(err.message).toContain('Invalid nodeVersion');
    expect(err.message).not.toContain(TOKEN);
  });

  it('logs and makes no writes in dry-run mode', async () => {
    const fake = seededFake();
    fake.projects.get(WEB_ID)!.nodeVersion = '22.x';
    const { promise, logger } = run(fake, webDeclaration({ pruneUndeclaredEnv: true }), { dryRun: true });
    const result = await promise;
    expect(fake.writes).toEqual([]);
    expect(result.changes).toBeGreaterThan(0);
    expect(logger.entries.some((e) => e.message === 'would write' && e.action === 'update settings')).toBe(
      true,
    );
  });

  describe('env vars', () => {
    it('upserts declared vars, resolving secrets inside the handler', async () => {
      const fake = seededFake();
      const decl = webDeclaration({
        env: [
          ...webDeclaration().env!.filter((e) => e.key !== 'NEXT_PUBLIC_SENTRY_DSN'),
          {
            key: 'NEXT_PUBLIC_SENTRY_DSN',
            targets: ['production'],
            secret: { secretId: 'app/prod', jsonKey: 'newDsn' },
          },
          {
            key: 'NEXT_PUBLIC_MIXPANEL_TOKEN',
            targets: ['production', 'preview'],
            type: 'plain',
            value: 'mp_1',
          },
        ],
      });
      const secrets = memorySecrets({
        ...SECRETS,
        'app/prod': JSON.stringify({
          newDsn: 'https://new@o1.ingest.sentry.io/2',
          apiUrl: 'https://api.example.com',
        }),
      });
      const { promise } = run(fake, decl, { secrets });
      await promise;
      const env = fake.env.get(WEB_ID)!;
      expect(env.find((e) => e.key === 'NEXT_PUBLIC_SENTRY_DSN')!.plain).toBe(
        'https://new@o1.ingest.sentry.io/2',
      );
      expect(env.find((e) => e.key === 'NEXT_PUBLIC_MIXPANEL_TOKEN')).toMatchObject({
        type: 'plain',
        target: ['production', 'preview'],
        plain: 'mp_1',
      });
      expect(secrets.calls).toContain('app/prod');
    });

    it('never logs secret or encrypted values, only plain literal before/after', async () => {
      const fake = seededFake();
      const decl = webDeclaration({
        env: [
          {
            key: 'NEXT_PUBLIC_SENTRY_DSN',
            targets: ['production'],
            secret: { secretId: 'app/prod', jsonKey: 'sentryDsn' },
          },
          { key: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', targets: ['production'], value: 'pk_live_CHANGED' },
        ],
      });
      fake.env.get(WEB_ID)!.find((e) => e.key === 'NEXT_PUBLIC_SENTRY_DSN')!.plain = 'https://old@sentry/0';
      const lines: string[] = [];
      const { jsonLogger } = await import('../src/runtime/logger');
      const redactor = new Redactor();
      await reconcile({
        declaration: decl,
        client: fake.client({ teamId: TEAM, redactor }),
        secrets: memorySecrets(SECRETS),
        logger: jsonLogger(redactor, (l) => lines.push(l)),
      });
      const out = lines.join('\n');
      expect(out).not.toContain('abc@o1.ingest.sentry.io'); // resolved secret
      expect(out).not.toContain('old@sentry'); // decrypted live value
      expect(out).not.toContain('pk_live_CHANGED'); // encrypted literal
      expect(out).not.toContain(TOKEN);
      expect(out).toContain('undeclared env var');
    });

    it('reports undeclared vars by default and deletes them when pruning, sparing integration vars', async () => {
      const fake = seededFake();
      const decl = webDeclaration({
        env: webDeclaration().env!.filter((e) => e.key !== 'NEXT_PUBLIC_SENTRY_DSN'),
      });
      const { promise, logger } = run(fake, decl);
      await promise;
      expect(
        logger.entries.filter((e) => e.message.startsWith('undeclared env var')).map((e) => e.env),
      ).toEqual(['NEXT_PUBLIC_SENTRY_DSN[production]']);
      expect(fake.env.get(WEB_ID)!.some((e) => e.key === 'NEXT_PUBLIC_SENTRY_DSN')).toBe(true);

      await run(fake, { ...decl, pruneUndeclaredEnv: true }).promise;
      const keys = fake.env.get(WEB_ID)!.map((e) => e.key);
      expect(keys).not.toContain('NEXT_PUBLIC_SENTRY_DSN');
      expect(keys).toContain('MARKETPLACE_DATABASE_URL');
    });

    it('fails on an overlapping var it may not delete, naming both', async () => {
      const fake = seededFake();
      const decl = webDeclaration({
        env: [{ key: 'NEXT_PUBLIC_API_URL', targets: ['production', 'preview', 'development'], value: 'x' }],
      });
      await expect(run(fake, decl).promise).rejects.toThrow(
        /NEXT_PUBLIC_API_URL\[development,preview\] blocks NEXT_PUBLIC_API_URL\[development,preview,production\]/,
      );
    });
  });

  describe('domains', () => {
    it('collects TXT values shared by several subdomains into one write, then verifies', async () => {
      const fake = seededFake();
      for (const sub of ['help', 'docs']) {
        fake.needsVerification.set(`${sub}.example.dev`, [
          {
            type: 'TXT',
            domain: '_vercel.example.dev',
            value: `vc-domain-verify=${sub}.example.dev,abc`,
            reason: 'pending',
          },
        ]);
        fake.domainConfig.set(`${sub}.example.dev`, fixture('domain-config-subdomain.json'));
      }
      const decl = webDeclaration({
        domains: [
          ...webDeclaration().domains!,
          { name: 'help.example.dev', verificationZoneId: 'Z123' },
          { name: 'docs.example.dev', verificationZoneId: 'Z123' },
        ],
      });
      const { promise, txt } = run(fake, decl);
      const result = await promise;
      expect(txt.calls).toEqual([
        {
          zoneId: 'Z123',
          name: '_vercel.example.dev',
          values: ['vc-domain-verify=help.example.dev,abc', 'vc-domain-verify=docs.example.dev,abc'],
        },
      ]);
      const domains = fake.domains.get(WEB_ID)!;
      expect(domains.filter((d) => d.name.endsWith('.example.dev') && !d.verified)).toEqual([]);
      expect(result.dnsTargets['help.example.dev']!.cname).toBe('d1d4fc829fe7bc7c.vercel-dns-017.com');
    });

    it('fails rather than writing a guessed DNS target when Vercel gives no recommendation', async () => {
      const fake = seededFake();
      fake.domainConfig.delete('app.example.dev');
      await expect(run(fake).promise).rejects.toThrow(/no recommended DNS target for app\.example\.dev/);
      // In dry-run (e.g. before a domain exists) the defaults are acceptable.
      await expect(run(fake, webDeclaration(), { dryRun: true }).promise).resolves.toBeDefined();
    });

    it('sets a redirect and Git branch on an existing domain', async () => {
      const fake = seededFake();
      const decl = webDeclaration({
        domains: [
          { name: 'app.example.com' },
          { name: 'app.example.dev', redirect: 'app.example.com', redirectStatusCode: 308 },
        ],
      });
      await run(fake, decl).promise;
      expect(fake.writes.filter((w) => w.path.includes('/domains/'))).toMatchObject([
        {
          method: 'PATCH',
          path: `/v9/projects/${WEB_ID}/domains/app.example.dev`,
          body: { redirect: 'app.example.com', redirectStatusCode: 308, gitBranch: null },
        },
      ]);
    });
  });

  describe('protection', () => {
    it('enables Vercel Authentication and registers bypass secrets', async () => {
      const fake = seededFake();
      const bypass = 'b'.repeat(32);
      const decl = webDeclaration({
        env: undefined,
        domains: undefined,
        protection: {
          vercelAuthentication: 'all_except_custom_domains',
          automationBypass: { secrets: [{ secretId: 'bypass' }] },
        },
      });
      await run(fake, decl, { secrets: memorySecrets({ bypass }) }).promise;
      const p = fake.projects.get(WEB_ID) as LiveProject;
      expect(p.ssoProtection).toEqual({ deploymentType: 'all_except_custom_domains' });
      expect(p.protectionBypass![bypass]).toMatchObject({
        scope: 'automation-bypass',
        note: MANAGED_BYPASS_NOTE,
      });
      expect(p.protectionBypass!['existingBypassSecret000000000001']).toBeDefined(); // unmanaged one kept
    });
  });

  describe('create mode', () => {
    it('creates a project when told to, then applies settings', async () => {
      const fake = seededFake();
      const decl = {
        create: { name: 'acme-docs', gitRepository: { type: 'github' as const, repo: 'acme/web-monorepo' } },
        expectRepo: 'acme/web-monorepo',
        settings: { rootDirectory: 'packages/docs' },
      };
      const result = await run(fake, decl).promise;
      expect(result.projectName).toBe('acme-docs');
      expect(fake.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
        'POST /v11/projects',
        `PATCH /v9/projects/${result.projectId}`,
      ]);
    });

    it('refuses to create over an existing project name', async () => {
      const fake = seededFake();
      await expect(run(fake, { create: { name: 'acme-web' } }).promise).rejects.toThrow(
        /already exists \(prj_web\w+\)\. To manage it, adopt it with `projectId: 'prj_web\w+'`, or set `create.adoptIfExists: true`/,
      );
      expect(fake.writes).toEqual([]);
    });

    it('recovers from a rolled-back create with adoptIfExists, checking the repository', async () => {
      const fake = seededFake();
      const result = await run(fake, {
        create: {
          name: 'acme-web',
          adoptIfExists: true,
          gitRepository: { type: 'github', repo: 'acme/web-monorepo' },
        },
      }).promise;
      expect(result.projectId).toBe(WEB_ID);
      expect(fake.writes).toEqual([]);
      await expect(
        run(fake, {
          create: {
            name: 'acme-web',
            adoptIfExists: true,
            gitRepository: { type: 'github', repo: 'acme/other' },
          },
        }).promise,
      ).rejects.toThrow(/Refusing to adopt existing project "acme-web".*linked to acme\/web-monorepo/);
    });

    it('reuses the created project on update', async () => {
      const fake = seededFake();
      const first = await run(fake, { create: { name: 'acme-docs' } }).promise;
      const before = fake.writes.length;
      await run(fake, { create: { name: 'acme-docs' } }, { existingProjectId: first.projectId }).promise;
      expect(fake.writes.length).toBe(before);
    });
  });
});

describe('VercelClient', () => {
  it('retries 429 using Retry-After, and adds teamId to every request', async () => {
    const fake = seededFake();
    const sleeps: number[] = [];
    fake.queued.push({
      status: 429,
      body: { error: { code: 'rate_limited' } },
      headers: { 'Retry-After': '2' },
    });
    const { VercelClient } = await import('../src/runtime/client');
    const client = new VercelClient({
      token: TOKEN,
      teamId: TEAM,
      fetch: fake.fetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
    const p = await client.get<LiveProject>(`/v9/projects/${WEB_ID}`);
    expect(p.name).toBe('acme-web');
    expect(sleeps).toEqual([2000]);
    expect(fake.requests.every((r) => r.query.teamId === TEAM)).toBe(true);
  });

  it('does not retry a POST on a 5xx (it may have been applied)', async () => {
    const fake = seededFake();
    fake.queued.push({ status: 502, body: { error: { message: 'bad gateway' } } });
    const client = fake.client();
    await expect(client.request('POST', '/v11/projects', { body: { name: 'x' } })).rejects.toThrow(
      /HTTP 502/,
    );
    expect(fake.requests).toHaveLength(1);
  });
});
