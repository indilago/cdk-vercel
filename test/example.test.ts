import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  EnvironmentDnsStack,
  projects,
  promoteStepCommands,
  VercelProjectsStack,
  webEnvParityIssues,
} from '../examples/monorepo-frontends';
import { NONCE_CONTEXT_KEY } from '../src';

describe('examples/monorepo-frontends', () => {
  it('synthesizes: four projects, one provider, DNS from SSM', () => {
    const app = new App({ context: { [NONCE_CONTEXT_KEY]: 'test' } });
    const vercel = new VercelProjectsStack(app, 'VercelProjects');
    const dns = new EnvironmentDnsStack(app, 'StagingDns', {
      zoneName: 'acme.dev',
      hostedZoneId: 'Z1',
      hosts: ['app.acme.dev', 'acme.dev'],
    });
    const t = Template.fromStack(vercel);
    t.resourceCountIs('Custom::VercelProject', 4);
    t.resourceCountIs('AWS::SSM::Parameter', 2 * 10);
    const records = Template.fromStack(dns).findResources('AWS::Route53::RecordSet');
    expect(Object.values(records).map((r: any) => `${r.Properties.Name} ${r.Properties.Type}`)).toEqual([
      'app.acme.dev. CNAME',
      'acme.dev. A',
    ]);
  });

  it('keeps web env parity rules satisfied', () => {
    expect(webEnvParityIssues()).toEqual([]);
  });

  it('puts the drift gate before the deployment waits', () => {
    const cmds = promoteStepCommands('staging');
    expect(cmds[0]).toMatch(/ drift /);
    expect(cmds.slice(1)).toHaveLength(Object.keys(projects).length);
    expect(cmds[1]).toContain('--ref "staging"');
  });
});
