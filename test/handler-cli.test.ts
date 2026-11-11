import type { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli';
import { driftGateCommand, waitForDeploymentCommand } from '../src/commands';
import { handle, route53TxtWriter } from '../src/handler';
import type { LiveDeployment } from '../src/runtime/api-types';
import { checkEnvParity } from '../src/runtime/parity';
import type { HandlerConfig } from '../src/runtime/types';
import { fixture, TOKEN } from './fake-vercel';
import { SECRETS, seededFake, TEAM, WEB_ID, webDeclaration } from './seed';

const fakeSecretsManager = (values: Record<string, string>) => ({
  sent: [] as string[],
  async send(cmd: GetSecretValueCommand) {
    const id = cmd.input.SecretId!;
    this.sent.push(id);
    if (!(id in values)) throw new Error(`ResourceNotFoundException: ${id}`);
    return { SecretString: values[id] };
  },
});

type TestConfig = HandlerConfig & { tokenSecretId: string; tokenJsonKey?: string };

function event(
  type: 'Create' | 'Update' | 'Delete',
  config: TestConfig,
  physicalId?: string,
): CloudFormationCustomResourceEvent {
  const { tokenSecretId, tokenJsonKey, ...rest } = config;
  return {
    RequestType: type,
    ServiceToken: 'arn',
    ResponseURL: 'https://example.com',
    StackId: 'stack',
    RequestId: 'req',
    LogicalResourceId: 'Web',
    ResourceType: 'Custom::VercelProject',
    ResourceProperties: {
      ServiceToken: 'arn',
      Config: JSON.stringify(rest),
      TokenSecretId: tokenSecretId,
      ...(tokenJsonKey ? { TokenJsonKey: tokenJsonKey } : {}),
    },
    ...(type === 'Create' ? {} : { PhysicalResourceId: physicalId!, OldResourceProperties: {} }),
  } as CloudFormationCustomResourceEvent;
}

const config = (over: Partial<TestConfig> = {}): TestConfig => ({
  declaration: webDeclaration(),
  tokenSecretId: 'vercel/token',
  ...over,
});

describe('route53TxtWriter', () => {
  const r53 = (existing?: string[]) => ({
    sent: [] as any[],
    async send(cmd: any) {
      this.sent.push(cmd.input);
      if ('StartRecordName' in cmd.input) {
        return {
          ResourceRecordSets: existing
            ? [
                {
                  Name: '_vercel.example.dev.',
                  Type: 'TXT',
                  TTL: 60,
                  ResourceRecords: existing.map((Value) => ({ Value })),
                },
              ]
            : [{ Name: 'zzz.example.dev.', Type: 'TXT', ResourceRecords: [{ Value: '"other"' }] }],
        };
      }
      return {};
    },
  });

  it('adds values to an existing record set without removing what is there', async () => {
    const client = r53(['"google-site-verification=xyz"']);
    await route53TxtWriter(client as never).addTxtValues('Z1', '_vercel.example.dev', [
      'vc-domain-verify=a,1',
    ]);
    expect(client.sent[1].ChangeBatch.Changes[0].ResourceRecordSet).toEqual({
      Name: '_vercel.example.dev.',
      Type: 'TXT',
      TTL: 60,
      ResourceRecords: [{ Value: '"google-site-verification=xyz"' }, { Value: '"vc-domain-verify=a,1"' }],
    });
  });

  it('writes nothing when the values are already present, and ignores other names', async () => {
    const present = r53(['"vc-domain-verify=a,1"']);
    await route53TxtWriter(present as never).addTxtValues('Z1', '_vercel.example.dev', [
      'vc-domain-verify=a,1',
    ]);
    expect(present.sent).toHaveLength(1);
    const fresh = r53();
    await route53TxtWriter(fresh as never).addTxtValues('Z1', '_vercel.example.dev', ['v']);
    expect(fresh.sent[1].ChangeBatch.Changes[0].ResourceRecordSet.ResourceRecords).toEqual([
      { Value: '"v"' },
    ]);
  });
});

describe('handler', () => {
  it('returns the project ID as the physical ID and DNS targets as attributes', async () => {
    const fake = seededFake();
    const sm = fakeSecretsManager({ 'vercel/token': TOKEN, ...SECRETS });
    const lines: string[] = [];
    const res = await handle(event('Create', config()), {
      fetch: fake.fetch,
      secretsManager: sm,
      route53: { send: async () => ({}) } as never,
      write: (l) => lines.push(l),
    });
    expect(res.PhysicalResourceId).toBe(WEB_ID);
    expect(res.Data).toMatchObject({
      ProjectId: WEB_ID,
      ProjectName: 'acme-web',
      DnsCname_app_example_com: 'd1d4fc829fe7bc7c.vercel-dns-017.com',
      DnsIpv4_app_example_com: '216.198.79.1',
    });
    expect(res.Data!.SecretsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('changes SecretsHash when a secret value changes', async () => {
    const run = async (dsn: string) => {
      const sm = fakeSecretsManager({
        ...SECRETS,
        'vercel/token': TOKEN,
        'app/prod': JSON.stringify({ sentryDsn: dsn, apiUrl: 'https://api.example.com' }),
      });
      return (
        await handle(event('Update', config(), WEB_ID), {
          fetch: seededFake().fetch,
          secretsManager: sm,
          write: () => {},
        })
      ).Data!.SecretsHash;
    };
    expect(await run('https://a@sentry/1')).not.toBe(await run('https://b@sentry/2'));
  });

  it('does nothing on Delete (retain on delete)', async () => {
    const fake = seededFake();
    const sm = fakeSecretsManager({});
    const res = await handle(event('Delete', config(), WEB_ID), {
      fetch: fake.fetch,
      secretsManager: sm,
      write: () => {},
    });
    expect(res).toEqual({ PhysicalResourceId: WEB_ID });
    expect(fake.requests).toEqual([]);
    expect(sm.sent).toEqual([]);
  });

  it('throws a redacted error so the stack update fails visibly', async () => {
    const fake = seededFake();
    fake.queued.push({
      status: 403,
      body: { error: { code: 'forbidden', message: `token ${TOKEN} lacks scope` } },
    });
    const sm = fakeSecretsManager({ 'vercel/token': TOKEN, ...SECRETS });
    const err = await handle(event('Create', config()), {
      fetch: fake.fetch,
      secretsManager: sm,
      write: () => {},
    }).catch((e) => e);
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toContain(TOKEN);
  });

  it('reads a token from a JSON secret key', async () => {
    const sm = fakeSecretsManager({ 'vercel/json': JSON.stringify({ token: TOKEN }), ...SECRETS });
    const res = await handle(
      event('Create', config({ tokenSecretId: 'vercel/json', tokenJsonKey: 'token' })),
      { fetch: seededFake().fetch, secretsManager: sm, write: () => {} },
    );
    expect(res.PhysicalResourceId).toBe(WEB_ID);
  });
});

function io(fake: ReturnType<typeof seededFake>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      env: { VERCEL_TOKEN: TOKEN },
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      fetch: fake.fetch,
      sleep: async () => {},
    },
  };
}

describe('cdk-vercel drift', () => {
  it('passes when live state matches', async () => {
    const fake = seededFake();
    const t = io(fake);
    const code = await runCli(['drift', '--declarations', JSON.stringify([webDeclaration()])], t.io);
    expect(t.err.join('')).toBe('');
    expect(code).toBe(0);
    expect(t.out.join('')).toContain('No drift in 1 Vercel project(s).');
    expect(fake.writes).toEqual([]);
  });

  it('fails naming project / field / expected / actual', async () => {
    const fake = seededFake();
    const p = fake.projects.get(WEB_ID)!;
    p.enableAffectedProjectsDeployments = true;
    fake.env
      .get(WEB_ID)!
      .find(
        (e) =>
          e.key === 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY' && (e.target as string[]).includes('production'),
      )!.plain = 'pk_live_WRONG';
    fake.domains.get(WEB_ID)!.find((d) => d.name === 'app.example.dev')!.gitBranch = 'develop';
    const t = io(fake);
    const b64 = Buffer.from(JSON.stringify(webDeclaration())).toString('base64');
    const code = await runCli(['drift', '--declarations-base64', b64], t.io);
    expect(code).toBe(1);
    const out = t.out.join('');
    expect(out).toContain(
      'DRIFT acme-web / settings.enableAffectedProjectsDeployments / expected false / actual true',
    );
    expect(out).toContain(
      'DRIFT acme-web / env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY[production].value / expected (declared value) / actual (different value)',
    );
    expect(out).toContain(
      'DRIFT acme-web / domains.app.example.dev.gitBranch / expected null / actual develop',
    );
    expect(out).not.toContain('pk_live');
  });

  it('warns about undeclared env vars without failing, unless pruning is on', async () => {
    const decl = webDeclaration({
      env: webDeclaration().env!.filter((e) => e.key !== 'NEXT_PUBLIC_SENTRY_DSN'),
    });
    let t = io(seededFake());
    expect(await runCli(['drift', '--declarations', JSON.stringify(decl)], t.io)).toBe(0);
    expect(t.out.join('')).toContain(
      'WARN  acme-web / env.NEXT_PUBLIC_SENTRY_DSN[production] / expected undeclared / actual present',
    );
    t = io(seededFake());
    expect(
      await runCli(['drift', '--declarations', JSON.stringify({ ...decl, pruneUndeclaredEnv: true })], t.io),
    ).toBe(1);
  });

  it('reports a guard failure as drift', async () => {
    const t = io(seededFake());
    expect(
      await runCli(
        ['drift', '--declarations', JSON.stringify(webDeclaration({ expectRepo: 'acme/other' }))],
        t.io,
      ),
    ).toBe(1);
    expect(t.out.join('')).toContain('/ guard /');
  });

  it('exits 2 on usage errors', async () => {
    const t = io(seededFake());
    expect(await runCli(['drift'], t.io)).toBe(2);
    expect(await runCli(['nope'], t.io)).toBe(2);
    expect(await runCli(['drift', '--declarations', '{"teamId":"x"}'], t.io)).toBe(2);
    expect(t.err.join('')).toContain('Set either `projectId`');
  });

  it('round-trips declarations through driftGateCommand', async () => {
    const cmd = driftGateCommand([webDeclaration()], { packageSpec: 'cdk-vercel@9.9.9' });
    expect(cmd).toMatch(
      /^npx --yes cdk-vercel@9\.9\.9 drift --token-env VERCEL_TOKEN --declarations-base64 [A-Za-z0-9+/=]+$/,
    );
    const b64 = cmd.split(' ').at(-1)!;
    expect(JSON.parse(Buffer.from(b64, 'base64').toString())).toEqual([webDeclaration()]);
    const t = io(seededFake());
    expect(await runCli(cmd.split(' ').slice(3), t.io)).toBe(0);
  });
});

describe('cdk-vercel wait-deployment', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  it('fails at once when the deployment for the ref was CANCELED, with the inspector URL', async () => {
    const fake = seededFake();
    fake.deployments = fixture<LiveDeployment[]>('deployments.json');
    const t = io(fake);
    const code = await runCli(
      ['wait-deployment', '--project', 'prj_help', '--team', TEAM, '--sha', SHA, '--ref', 'staging'],
      t.io,
    );
    expect(code).toBe(1);
    expect(fake.requests).toHaveLength(1);
    expect(t.err.join('')).toContain('is CANCELED. Inspect: https://vercel.com/acme/acme-help/dpl_new');
  });

  it('prints the URL of a READY deployment', async () => {
    const fake = seededFake();
    fake.deployments = fixture<LiveDeployment[]>('deployments.json');
    const t = io(fake);
    const code = await runCli(
      ['wait-deployment', '--project', 'prj_help', '--sha', SHA, '--ref', 'production'],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.out.join('')).toBe('acme-help-zzz.vercel.app\n');
  });

  it('keeps polling while building, then times out with the last state', async () => {
    const fake = seededFake();
    fake.deployments = [
      { uid: 'dpl_b', state: 'BUILDING', meta: { githubCommitSha: SHA, githubCommitRef: 'staging' } },
    ];
    const t = io(fake);
    const code = await runCli(
      [
        'wait-deployment',
        '--project',
        'p',
        '--sha',
        SHA,
        '--ref',
        'staging',
        '--timeout',
        '60',
        '--interval',
        '15',
      ],
      t.io,
    );
    expect(code).toBe(1);
    expect(fake.requests.length).toBe(5); // t = 0, 15, 30, 45, 60s
    expect(t.err.join('')).toContain('Last state: BUILDING');
  });

  it('builds a quoted command line', () => {
    expect(
      waitForDeploymentCommand({
        projectId: 'prj_1',
        teamId: TEAM,
        sha: '$CODEBUILD_RESOLVED_SOURCE_VERSION',
        ref: 'staging',
        packageSpec: 'cdk-vercel@1.0.0',
      }),
    ).toBe(
      `npx --yes cdk-vercel@1.0.0 wait-deployment --token-env VERCEL_TOKEN --project "prj_1" --team "${TEAM}" --sha "$CODEBUILD_RESOLVED_SOURCE_VERSION" --ref "staging"`,
    );
  });
});

describe('checkEnvParity', () => {
  const staging = { name: 'staging', target: 'preview' as const, gitBranch: 'staging' };
  const production = { name: 'production', target: 'production' as const };

  it('flags production-only keys and undeclared divergence', () => {
    const issues = checkEnvParity(webDeclaration().env!, { a: staging, b: production });
    expect(issues.map((i) => `${i.problem}:${i.key}`).sort()).toEqual([
      'missing:NEXT_PUBLIC_SENTRY_DSN',
      'undeclared-divergence:NEXT_PUBLIC_API_URL',
      'undeclared-divergence:NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    ]);
  });

  it('passes when every difference is listed with a reason, and flags stale entries', () => {
    const opts = {
      a: staging,
      b: production,
      derivedDivergentKeys: {
        NEXT_PUBLIC_API_URL: 'per-environment API',
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'test vs live mode',
      },
      singleSliceKeys: { NEXT_PUBLIC_SENTRY_DSN: 'no error reporting in staging' },
    };
    expect(checkEnvParity(webDeclaration().env!, opts)).toEqual([]);
    expect(
      checkEnvParity(webDeclaration().env!, { ...opts, behaviouralDivergentKeys: { GONE: 'x' } }),
    ).toMatchObject([{ key: 'GONE', problem: 'stale-exception' }]);
  });
});
