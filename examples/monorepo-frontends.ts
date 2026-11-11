/**
 * Example: four Next.js apps in one monorepo, each a Vercel project, managed from CDK.
 *
 * - `projects.ts`-style declarations as plain objects (one per project), shared by the
 *   constructs, the pipeline drift gate and a parity test.
 * - A "common" stack that owns the Vercel projects and exports DNS targets to SSM.
 * - Per-environment stacks that build Route 53 records from those targets.
 * - Pipeline shell commands for the drift gate and the fail-fast deployment wait.
 *
 * Typecheck with `pnpm typecheck`; synth with your own CDK app entry point.
 */
import { App, Stack, type StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import {
  checkEnvParity,
  dnsTargetFromSsm,
  driftGateCommand,
  VercelDnsRecord,
  VercelProject,
  type VercelProjectDeclaration,
  type VercelProjectSettings,
  waitForDeploymentCommand,
} from '../src';

// ---------------------------------------------------------------------------
// projects.ts: the single source of truth
// ---------------------------------------------------------------------------

const TEAM_ID = 'team_xxxxxxxxxxxxxxxxxxxxxxxx';
const REPO = 'acme/monorepo';

/** Builds of the `staging` and `production` branches only; everything else is skipped. */
const IGNORE_UNLESS_DEPLOY_BRANCH =
  'if [ "$VERCEL_GIT_COMMIT_REF" = "staging" ] || [ "$VERCEL_GIT_COMMIT_REF" = "production" ]; then exit 1; else exit 0; fi';

const common: VercelProjectSettings = {
  framework: 'nextjs',
  nodeVersion: '24.x',
  serverlessFunctionRegion: 'iad1',
  skewProtectionMaxAge: 12 * 60 * 60,
  productionBranch: 'production',
  commandForIgnoringBuildStep: IGNORE_UNLESS_DEPLOY_BRANCH,
  // Must stay off: with it on, a commit that doesn't touch the app gets a CANCELED build,
  // and a pipeline waiting for that commit's deployment never sees READY.
  enableAffectedProjectsDeployments: false,
  sourceFilesOutsideRootDirectory: true,
  gitForkProtection: true,
  // The pipeline, not Vercel, decides when production domains move.
  autoAssignCustomDomains: false,
};

const appSecret = (env: 'staging' | 'prod', jsonKey: string) => ({ secretId: `acme/${env}/app`, jsonKey });

export const projects = {
  web: {
    teamId: TEAM_ID,
    projectId: 'prj_web_xxxxxxxxxxxxxxxxxxxx',
    expectRepo: REPO,
    settings: { ...common, rootDirectory: 'packages/web' },
    env: [
      {
        key: 'NEXT_PUBLIC_API_URL',
        targets: ['preview'],
        gitBranch: 'staging',
        type: 'plain',
        value: 'https://api.acme.dev',
      },
      { key: 'NEXT_PUBLIC_API_URL', targets: ['production'], type: 'plain', value: 'https://api.acme.com' },
      {
        key: 'NEXT_PUBLIC_API_URL',
        targets: ['preview', 'development'],
        type: 'plain',
        value: 'https://api.acme.dev',
      },
      {
        key: 'NEXT_PUBLIC_SENTRY_DSN',
        targets: ['preview'],
        gitBranch: 'staging',
        secret: appSecret('staging', 'sentryDsn'),
      },
      { key: 'NEXT_PUBLIC_SENTRY_DSN', targets: ['production'], secret: appSecret('prod', 'sentryDsn') },
      {
        key: 'NEXT_PUBLIC_MIXPANEL_TOKEN',
        targets: ['production'],
        secret: appSecret('prod', 'mixpanelToken'),
      },
    ],
    pruneUndeclaredEnv: false, // report-only for the first rollout
    domains: [{ name: 'app.acme.com' }, { name: 'app.acme.dev' }],
  },
  admin: {
    teamId: TEAM_ID,
    projectId: 'prj_admin_xxxxxxxxxxxxxxxxxx',
    expectRepo: REPO,
    settings: { ...common, rootDirectory: 'packages/admin', outputDirectory: '.next' },
    env: [
      {
        key: 'NEXT_PUBLIC_API_URL',
        targets: ['preview'],
        gitBranch: 'staging',
        type: 'plain',
        value: 'https://api.acme.dev',
      },
      { key: 'NEXT_PUBLIC_API_URL', targets: ['production'], type: 'plain', value: 'https://api.acme.com' },
    ],
    domains: [{ name: 'admin.acme.com' }, { name: 'admin.acme.dev' }],
  },
  help: {
    teamId: TEAM_ID,
    projectId: 'prj_help_xxxxxxxxxxxxxxxxxxx',
    expectRepo: REPO,
    settings: {
      ...common,
      rootDirectory: 'packages/help',
      buildCommand: 'pnpm build',
      installCommand: 'pnpm install',
    },
    domains: [{ name: 'help.acme.com' }, { name: 'help.acme.dev' }],
    protection: {
      vercelAuthentication: 'all_except_custom_domains',
      // Lets smoke tests reach protected deployment URLs.
      automationBypass: {
        secrets: [
          appSecret('staging', 'vercelAutomationBypassSecret'),
          appSecret('prod', 'vercelAutomationBypassSecret'),
        ],
      },
    },
  },
  site: {
    teamId: TEAM_ID,
    projectId: 'prj_site_xxxxxxxxxxxxxxxxxxx',
    expectRepo: REPO,
    settings: { ...common, rootDirectory: 'packages/site', outputDirectory: '.next' },
    domains: [
      { name: 'www.acme.com' },
      { name: 'acme.com', redirect: 'www.acme.com', redirectStatusCode: 308 },
      { name: 'www.acme.dev', gitBranch: 'staging' },
      { name: 'acme.dev', redirect: 'www.acme.dev', redirectStatusCode: 308 },
    ],
  },
} satisfies Record<string, VercelProjectDeclaration>;

// ---------------------------------------------------------------------------
// Parity test (put this in your test suite)
// ---------------------------------------------------------------------------

export function webEnvParityIssues() {
  return checkEnvParity(projects.web.env, {
    a: { name: 'staging', target: 'preview', gitBranch: 'staging' },
    b: { name: 'production', target: 'production' },
    derivedDivergentKeys: {
      NEXT_PUBLIC_API_URL: 'Each environment calls its own API.',
      NEXT_PUBLIC_SENTRY_DSN: 'Separate Sentry projects per environment.',
    },
    singleSliceKeys: { NEXT_PUBLIC_MIXPANEL_TOKEN: 'No product analytics from staging traffic.' },
  });
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

const DNS_PARAMETER_PREFIX = '/acme/vercel/dns';

/** Deployed once, before the environment stages. Vercel projects are environment-independent. */
export class VercelProjectsStack extends Stack {
  readonly projects: Record<keyof typeof projects, VercelProject>;

  constructor(scope: Construct, id: string, props?: StackProps & { dryRun?: boolean }) {
    super(scope, id, props);
    const tokenSecret = secretsmanager.Secret.fromSecretNameV2(this, 'VercelToken', 'acme/vercel/token');
    const make = (name: keyof typeof projects) => {
      const p = new VercelProject(this, name, { ...projects[name], tokenSecret, dryRun: props?.dryRun });
      p.exportDnsTargets(DNS_PARAMETER_PREFIX);
      return p;
    };
    this.projects = { web: make('web'), admin: make('admin'), help: make('help'), site: make('site') };
  }
}

/** One per environment: Route 53 records from Vercel's own recommended targets. */
export class EnvironmentDnsStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { zoneName: string; hostedZoneId: string; hosts: string[] },
  ) {
    super(scope, id, props);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      zoneName: props.zoneName,
      hostedZoneId: props.hostedZoneId,
    });
    for (const host of props.hosts) {
      new VercelDnsRecord(this, host, {
        zone,
        domain: host,
        target: dnsTargetFromSsm(this, DNS_PARAMETER_PREFIX, host),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline step commands (e.g. CodeBuild `commands`)
// ---------------------------------------------------------------------------

export function promoteStepCommands(env: 'staging' | 'production'): string[] {
  const all = Object.values(projects);
  return [
    // 1. Fail in seconds if anyone changed a managed setting in the dashboard.
    driftGateCommand(all),
    // 2. ...trigger the Git build of $SHA on the `staging`/`production` branch...
    // 3. Wait for each build; fail at once on CANCELED/ERROR with the inspector URL.
    ...all.map(
      (p) =>
        `url=$(${waitForDeploymentCommand({ projectId: p.projectId, teamId: p.teamId, sha: '$SHA', ref: env, timeoutSeconds: 600 })})`,
    ),
  ];
}

if (require.main === module) {
  const app = new App();
  new VercelProjectsStack(app, 'VercelProjects', { dryRun: true });
  new EnvironmentDnsStack(app, 'StagingDns', {
    zoneName: 'acme.dev',
    hostedZoneId: 'Z_STAGING',
    hosts: ['app.acme.dev', 'admin.acme.dev', 'help.acme.dev', 'www.acme.dev', 'acme.dev'],
  });
  app.synth();
}
