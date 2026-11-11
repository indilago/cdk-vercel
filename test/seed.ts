import type { LiveDomainConfig, LiveProject, LiveProjectDomain } from '../src/runtime/api-types';
import type { VercelProjectDeclaration } from '../src/runtime/types';
import { FakeVercel, fixture } from './fake-vercel';

export const TEAM = 'team_acme0000000000000000001';
export const WEB_ID = 'prj_web000000000000000000001';
export const IGNORE_CMD =
  'if [ "$VERCEL_GIT_COMMIT_REF" = "staging" ] || [ "$VERCEL_GIT_COMMIT_REF" = "production" ]; then exit 1; else exit 0; fi';

export function seededFake(): FakeVercel {
  const fake = new FakeVercel();
  fake.addProject(
    fixture<LiveProject>('project-web.json'),
    fixture('env-web.json'),
    fixture<LiveProjectDomain[]>('domains-web.json'),
  );
  const cfg = fixture<LiveDomainConfig>('domain-config-subdomain.json');
  fake.domainConfig.set('app.example.com', cfg);
  fake.domainConfig.set('app.example.dev', cfg);
  return fake;
}

/** A declaration that matches the seeded live project exactly. */
export function webDeclaration(overrides: Partial<VercelProjectDeclaration> = {}): VercelProjectDeclaration {
  return {
    teamId: TEAM,
    projectId: WEB_ID,
    expectRepo: 'acme/web-monorepo',
    settings: {
      framework: 'nextjs',
      rootDirectory: 'packages/web',
      nodeVersion: '24.x',
      outputDirectory: null,
      commandForIgnoringBuildStep: IGNORE_CMD,
      enableAffectedProjectsDeployments: false,
      productionBranch: 'production',
      autoAssignCustomDomains: false,
      sourceFilesOutsideRootDirectory: true,
      serverlessFunctionRegion: 'iad1',
      skewProtectionMaxAge: 43200,
      gitForkProtection: true,
    },
    env: [
      {
        key: 'NEXT_PUBLIC_API_URL',
        targets: ['preview', 'development'],
        value: 'https://api.dev.example.com',
      },
      {
        key: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
        targets: ['preview', 'development'],
        value: 'pk_test_123',
      },
      { key: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', targets: ['production'], value: 'pk_live_456' },
      {
        key: 'NEXT_PUBLIC_SENTRY_DSN',
        targets: ['production'],
        secret: { secretId: 'app/prod', jsonKey: 'sentryDsn' },
      },
      {
        key: 'NEXT_PUBLIC_API_URL',
        targets: ['preview'],
        gitBranch: 'staging',
        type: 'sensitive',
        secret: { secretId: 'app/staging', jsonKey: 'apiUrl' },
      },
      {
        key: 'NEXT_PUBLIC_API_URL',
        targets: ['production'],
        type: 'sensitive',
        secret: { secretId: 'app/prod', jsonKey: 'apiUrl' },
      },
    ],
    domains: [{ name: 'app.example.com' }, { name: 'app.example.dev' }],
    ...overrides,
  };
}

export const SECRETS = {
  'app/prod': JSON.stringify({
    sentryDsn: 'https://abc@o1.ingest.sentry.io/1',
    apiUrl: 'https://api.example.com',
  }),
  'app/staging': JSON.stringify({ apiUrl: 'https://api.staging.example.com' }),
};
