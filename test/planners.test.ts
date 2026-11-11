import { describe, expect, it } from 'vitest';
import type { LiveEnvVar, LiveProject } from '../src/runtime/api-types';
import { dnsAttributeNames, dnsTargetFromConfig, planDomains } from '../src/runtime/domains';
import { planEnv } from '../src/runtime/env';
import { MANAGED_BYPASS_NOTE, planBypass } from '../src/runtime/protection';
import { isVerificationRecordFor } from '../src/runtime/reconcile';
import { Redactor } from '../src/runtime/redact';
import { diffSettings, settingsWrites } from '../src/runtime/settings';
import { validateDeclaration } from '../src/runtime/validate';
import { fixture } from './fake-vercel';

const project = () => fixture<LiveProject>('project-web.json');

describe('diffSettings', () => {
  it('ignores undeclared fields (partial management)', () => {
    expect(diffSettings({ nodeVersion: '24.x' }, project())).toEqual([]);
    expect(diffSettings(undefined, project())).toEqual([]);
  });

  it('reports each differing declared field with expected and actual', () => {
    const diffs = diffSettings(
      { nodeVersion: '22.x', enableAffectedProjectsDeployments: true, rootDirectory: 'packages/web' },
      project(),
    );
    expect(diffs).toEqual([
      { field: 'nodeVersion', expected: '22.x', actual: '24.x' },
      { field: 'enableAffectedProjectsDeployments', expected: true, actual: false },
    ]);
  });

  it('treats null, undefined and empty string as unset', () => {
    expect(diffSettings({ buildCommand: null, outputDirectory: null }, project())).toEqual([]);
    expect(diffSettings({ buildCommand: 'pnpm build' }, project())).toEqual([
      { field: 'buildCommand', expected: 'pnpm build', actual: null },
    ]);
  });

  it('treats an absent boolean as false', () => {
    const p = project();
    delete p.enableAffectedProjectsDeployments;
    expect(diffSettings({ enableAffectedProjectsDeployments: false }, p)).toEqual([]);
    expect(diffSettings({ enableAffectedProjectsDeployments: true }, p)).toHaveLength(1);
  });

  it('reads the production branch from the Git link and the region from resourceConfig', () => {
    expect(
      diffSettings({ productionBranch: 'production', serverlessFunctionRegion: 'iad1' }, project()),
    ).toEqual([]);
    expect(diffSettings({ productionBranch: 'main' }, project())).toEqual([
      { field: 'productionBranch', expected: 'main', actual: 'production' },
    ]);
  });

  it('compares additionalSettings as a subset', () => {
    const p = { ...project(), gitProviderOptions: { createDeployments: 'enabled', gitCommitStatus: true } };
    expect(
      diffSettings({ additionalSettings: { gitProviderOptions: { createDeployments: 'enabled' } } }, p),
    ).toEqual([]);
    expect(
      diffSettings({ additionalSettings: { gitProviderOptions: { createDeployments: 'disabled' } } }, p),
    ).toHaveLength(1);
  });

  it('splits writes into a project PATCH and a production-branch call', () => {
    const w = settingsWrites([
      { field: 'nodeVersion', expected: '22.x', actual: '24.x' },
      { field: 'productionBranch', expected: 'main', actual: 'production' },
    ]);
    expect(w).toEqual({ patch: { nodeVersion: '22.x' }, productionBranch: 'main' });
    expect(settingsWrites([])).toEqual({ patch: undefined, productionBranch: undefined });
  });
});

describe('planEnv', () => {
  const live = (over: Partial<LiveEnvVar> & { id: string; key: string }): LiveEnvVar => ({
    type: 'plain',
    target: ['production'],
    value: 'v',
    ...over,
  });
  const same = { compareValue: () => 'same' as const, unknownValue: 'rewrite' as const, prune: false };

  it('matches by key, branch and exact target set', () => {
    const plan = planEnv(
      [{ key: 'A', targets: ['production'], value: 'v', type: 'plain' }],
      [live({ id: '1', key: 'A' })],
      same,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.unchanged).toHaveLength(1);
  });

  it('widens an overlapping record whose targets are all declared', () => {
    const plan = planEnv(
      [{ key: 'A', targets: ['production', 'preview'], value: 'v', type: 'plain' }],
      [live({ id: '1', key: 'A', target: ['production'] })],
      same,
    );
    expect(plan.actions).toMatchObject([{ op: 'update', changes: ['targets'] }]);
  });

  it('never narrows a record (dropping undeclared targets) unless pruning', () => {
    const decl = [{ key: 'A', targets: ['production'] as const, value: 'v', type: 'plain' as const }];
    const records = [live({ id: '1', key: 'A', target: ['production', 'preview', 'development'] })];
    const plan = planEnv(decl, records, same);
    expect(plan.actions).toEqual([]);
    expect(plan.conflicts).toMatchObject([{ live: { id: '1' } }]);
    expect(planEnv(decl, records, { ...same, prune: true }).actions).toMatchObject([
      { op: 'update', changes: ['targets'] },
    ]);
  });

  it('reports a second overlapping record as a conflict, or deletes it when pruning', () => {
    const decl = [
      { key: 'A', targets: ['production', 'preview'] as const, value: 'v', type: 'plain' as const },
    ];
    const records = [
      live({ id: '1', key: 'A', target: ['production'] }),
      live({ id: '2', key: 'A', target: ['preview'] }),
    ];
    expect(planEnv(decl, records, same).conflicts).toHaveLength(1);
    const pruned = planEnv(decl, records, { ...same, prune: true });
    expect(pruned.actions[0]).toMatchObject({ op: 'delete', reason: 'conflict' });
  });

  it('never touches integration-owned or system env vars', () => {
    const plan = planEnv(
      [],
      [
        live({ id: '1', key: 'DB', configurationId: 'icfg_1' }),
        live({ id: '2', key: 'VERCEL_URL', type: 'system' }),
      ],
      { ...same, prune: true },
    );
    expect(plan.actions).toEqual([]);
    expect(plan.undeclared).toEqual([]);
  });

  it('reports undeclared vars, and deletes them only when pruning', () => {
    const records = [live({ id: '1', key: 'OLD' })];
    expect(planEnv([], records, same).undeclared).toHaveLength(1);
    expect(planEnv([], records, { ...same, prune: true }).actions).toMatchObject([
      { op: 'delete', reason: 'undeclared' },
    ]);
  });

  it('rewrites unreadable values on apply but ignores them in drift checks', () => {
    const decl = [{ key: 'S', targets: ['production'] as const, value: 'x', type: 'sensitive' as const }];
    const records = [live({ id: '1', key: 'S', type: 'sensitive', value: undefined })];
    expect(planEnv(decl, records, { ...same, compareValue: () => 'unknown' }).actions).toMatchObject([
      { op: 'update', changes: ['value?'] },
    ]);
    expect(
      planEnv(decl, records, { ...same, compareValue: () => 'unknown', unknownValue: 'ignore' }).actions,
    ).toEqual([]);
  });

  it('replaces a record whose type changes', () => {
    const plan = planEnv(
      [{ key: 'A', targets: ['production'], value: 'v', type: 'encrypted' }],
      [live({ id: '1', key: 'A', type: 'sensitive' })],
      same,
    );
    expect(plan.actions).toMatchObject([{ op: 'replace', changes: ['type'] }]);
  });

  it('creates missing vars after deletes', () => {
    const plan = planEnv(
      [{ key: 'NEW', targets: ['production'], value: 'v' }],
      [live({ id: '1', key: 'OLD' })],
      { ...same, prune: true },
    );
    expect(plan.actions.map((a) => a.op)).toEqual(['delete', 'create']);
  });
});

describe('planDomains', () => {
  const live = (name: string, extra = {}) => ({
    name,
    verified: true,
    redirect: null,
    redirectStatusCode: null,
    gitBranch: null,
    ...extra,
  });

  it('adds plain domains before the redirects that point at them', () => {
    const plan = planDomains(
      [
        { name: 'example.com', redirect: 'www.example.com', redirectStatusCode: 308 },
        { name: 'www.example.com' },
      ],
      [],
      false,
    );
    expect(plan.actions.map((a) => (a.op === 'add' ? a.decl.name : ''))).toEqual([
      'www.example.com',
      'example.com',
    ]);
  });

  it('updates redirect and branch differences', () => {
    const plan = planDomains(
      [{ name: 'www.example.dev', gitBranch: 'main' }],
      [live('www.example.dev', { gitBranch: 'develop' })],
      false,
    );
    expect(plan.actions).toMatchObject([
      { op: 'update', changes: [{ field: 'gitBranch', expected: 'main', actual: 'develop' }] },
    ]);
  });

  it('never detaches *.vercel.app and only detaches others when pruning', () => {
    const records = [live('acme.vercel.app'), live('old.example.com')];
    expect(planDomains([], records, false)).toMatchObject({
      actions: [],
      undeclared: [{ name: 'old.example.com' }],
    });
    expect(planDomains([], records, true).actions).toMatchObject([
      { op: 'remove', live: { name: 'old.example.com' } },
    ]);
  });

  it('picks rank-1 DNS recommendations and strips the trailing dot', () => {
    expect(dnsTargetFromConfig(fixture('domain-config-subdomain.json'))).toEqual({
      cname: 'd1d4fc829fe7bc7c.vercel-dns-017.com',
      ipv4: '216.198.79.1',
      fallback: false,
    });
    expect(dnsTargetFromConfig({})).toMatchObject({ fallback: true, cname: 'cname.vercel-dns.com' });
  });

  it('derives stable attribute names', () => {
    expect(dnsAttributeNames('App.Example.com')).toEqual({
      cname: 'DnsCname_app_example_com',
      ipv4: 'DnsIpv4_app_example_com',
    });
  });
});

describe('planBypass', () => {
  const S1 = 'a'.repeat(32);
  const S2 = 'b'.repeat(32);
  const withBypass = (map: LiveProject['protectionBypass']) => ({ ...project(), protectionBypass: map });

  it('adds declared secrets that are missing and keeps existing ones', () => {
    const p = withBypass({ [S1]: { scope: 'automation-bypass' } });
    expect(planBypass([S1, S2], false, p).actions).toEqual([{ op: 'generate', secret: S2 }]);
  });

  it('revokes a rotated managed secret after making the new one the default', () => {
    const p = withBypass({ [S1]: { scope: 'automation-bypass', note: MANAGED_BYPASS_NOTE, isEnvVar: true } });
    expect(planBypass([S2], false, p).actions).toEqual([
      { op: 'generate', secret: S2 },
      { op: 'make-default', secret: S2 },
      { op: 'revoke', secret: S1, managed: true },
    ]);
  });

  it('leaves unmanaged secrets alone unless pruneUnmanaged', () => {
    const p = withBypass({
      [S1]: { scope: 'automation-bypass', isEnvVar: false },
      x: { scope: 'integration-automation-bypass' },
    });
    expect(planBypass([], false, p)).toEqual({ actions: [], unmanaged: 1 });
    expect(planBypass([], true, p).actions).toEqual([{ op: 'revoke', secret: S1, managed: false }]);
  });
});

describe('validateDeclaration', () => {
  it('accepts a valid declaration', () => {
    expect(
      validateDeclaration({
        projectId: 'prj_1',
        env: [{ key: 'A', targets: ['preview'], gitBranch: 'staging', value: 'x' }],
      }),
    ).toEqual([]);
  });

  it('collects every problem', () => {
    const errors = validateDeclaration({
      projectId: 'prj_1',
      create: { name: 'x' },
      expectRepo: 'not-a-slug',
      settings: { skewProtectionMaxAge: -1 },
      env: [
        { key: '1BAD', targets: [], value: 'x' },
        { key: 'S', targets: ['development'], type: 'sensitive', value: 'x' },
        { key: 'B', targets: ['production'], gitBranch: 'main', value: 'x' },
        { key: 'D', targets: ['production'], value: 'x' },
        { key: 'D', targets: ['production', 'preview'], value: 'y' },
        { key: 'N', targets: ['production'] } as never,
      ],
      domains: [
        { name: 'a.com', redirectStatusCode: 301 },
        { name: 'A.com' },
        { name: 'b.com', redirect: 'b.com' },
      ],
    });
    expect(errors.join('\n')).toMatchInlineSnapshot(`
      "\`projectId\` and \`create\` are mutually exclusive.
      \`expectRepo\` must look like "owner/name", got "not-a-slug".
      \`settings.skewProtectionMaxAge\` must be a non-negative integer number of seconds.
      env[0] (1BAD): invalid key.
      env[0] (1BAD): \`targets\` must not be empty.
      env[1] (S): a \`sensitive\` env var must use \`secret\` (Secrets Manager). Literal values are stored in the CloudFormation template; use type \`plain\` or \`encrypted\` for values that are not secret.
      env[1] (S): Vercel does not allow \`sensitive\` env vars to target \`development\`.
      env[2] (B): \`gitBranch\` is only allowed with \`targets: ['preview']\`.
      env[5] (N): set exactly one of \`value\` or \`secret\`.
      env: "D" is declared more than once for the same target and branch (env[3], env[4]).
      domains: "a.com" sets redirectStatusCode without redirect.
      domains: "A.com" is declared more than once.
      domains: "b.com" redirects to itself."
    `);
  });
});

describe('Redactor', () => {
  it('redacts secrets in their JSON-escaped form too', () => {
    const r = new Redactor();
    const secret = 'pa"ss\\word\nwith-escapes';
    r.add(secret);
    const line = r.redactJson({ error: `bad value ${secret}` });
    expect(line).not.toContain('pa\\"ss');
    expect(line).toBe('{"error":"bad value [REDACTED]"}');
  });
});

describe('isVerificationRecordFor', () => {
  const rec = (domain: string, value = 'vc-domain-verify=help.example.dev,0a1b2c') => ({ domain, value });
  it('accepts _vercel.<apex or parent> with a vc-domain-verify value', () => {
    expect(isVerificationRecordFor('help.example.dev', rec('_vercel.example.dev'))).toBe(true);
    expect(isVerificationRecordFor('example.dev', rec('_vercel.example.dev.'))).toBe(true);
  });
  it('rejects other names, unrelated zones and other values', () => {
    expect(isVerificationRecordFor('help.example.dev', rec('example.dev'))).toBe(false);
    expect(isVerificationRecordFor('help.example.dev', rec('_vercel.attacker.com'))).toBe(false);
    expect(isVerificationRecordFor('help.example.dev', rec('_vercel.dev'))).toBe(false);
    expect(
      isVerificationRecordFor('help.example.dev', rec('_vercel.example.dev', 'v=spf1 include:evil -all')),
    ).toBe(false);
    expect(
      isVerificationRecordFor('help.example.dev', rec('_vercel.example.dev', 'vc-domain-verify=a b')),
    ).toBe(false);
  });
});
