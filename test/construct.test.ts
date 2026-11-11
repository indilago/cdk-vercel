import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import {
  dnsTargetFromSsm,
  driftGateCommand,
  NONCE_CONTEXT_KEY,
  VercelDnsRecord,
  VercelProject,
} from '../src';
import type { HandlerConfig } from '../src/runtime/types';
import { webDeclaration } from './seed';

function setup(context: Record<string, unknown> = { [NONCE_CONTEXT_KEY]: 'fixed' }) {
  const app = new App({ context });
  const stack = new Stack(app, 'Vercel', { env: { account: '111111111111', region: 'us-east-1' } });
  const tokenSecret = secretsmanager.Secret.fromSecretNameV2(stack, 'Token', 'vercel/token');
  return { app, stack, tokenSecret };
}

const configOf = (template: Template, logicalIdPrefix?: string): HandlerConfig => {
  const resources = template.findResources('Custom::VercelProject');
  const [, r] = Object.entries(resources).find(([id]) => !logicalIdPrefix || id.startsWith(logicalIdPrefix))!;
  return JSON.parse((r as { Properties: { Config: string } }).Properties.Config);
};

describe('VercelProject', () => {
  it('passes the declaration and secret references, never secret values', () => {
    const { stack, tokenSecret } = setup();
    new VercelProject(stack, 'Web', { ...webDeclaration(), tokenSecret });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('Custom::VercelProject', {
      Nonce: 'fixed',
      TokenSecretId: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(':secret:vercel/token$')])] },
    });
    const config = configOf(template);
    expect(config.declaration).toEqual(webDeclaration());
    expect(config.dryRun).toBe(false);
    expect(JSON.stringify(template.toJSON())).not.toContain('abc@o1.ingest.sentry.io');
  });

  it('shares one provider per stack', () => {
    const { stack, tokenSecret } = setup();
    new VercelProject(stack, 'Web', { ...webDeclaration(), tokenSecret });
    new VercelProject(stack, 'Admin', { projectId: 'prj_admin', tokenSecret });
    const template = Template.fromStack(stack);
    template.resourceCountIs('Custom::VercelProject', 2);
    // Our handler plus the Provider framework's onEvent function.
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Handler: 'index.onEvent',
    });
  });

  it('grants GetSecretValue on exactly the token and referenced secrets, and TXT-only Route 53 access', () => {
    const { stack, tokenSecret } = setup();
    new VercelProject(stack, 'Web', {
      ...webDeclaration({ domains: [{ name: 'app.example.com', verificationZoneId: 'Z0123' }] }),
      protection: {
        automationBypass: {
          secrets: [{ secretId: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:bypass' }],
        },
      },
      tokenSecret,
    });
    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const secretResources = statements
      .filter((s: any) => [s.Action].flat().includes('secretsmanager:GetSecretValue'))
      .flatMap((s: any) => [s.Resource].flat())
      .map((r: any) => (typeof r === 'string' ? r : JSON.stringify(r)));
    expect(secretResources.some((r) => r.includes('secret:vercel/token-??????'))).toBe(true);
    expect(secretResources.some((r) => r.includes('secret:app/prod-??????'))).toBe(true);
    expect(secretResources).toContain('arn:aws:secretsmanager:us-east-1:111111111111:secret:bypass');
    expect(secretResources.every((r) => !r.endsWith(':secret:*') && r !== '*')).toBe(true);
    expect(statements).toContainEqual(
      expect.objectContaining({
        Action: 'route53:ChangeResourceRecordSets',
        Condition: {
          'ForAllValues:StringEquals': { 'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'] },
        },
      }),
    );
  });

  it('lets the first project choose the handler runtime', () => {
    const { stack, tokenSecret } = setup();
    new VercelProject(stack, 'Web', {
      projectId: 'prj',
      tokenSecret,
      provider: { runtime: new lambda.Runtime('nodejs26.x', lambda.RuntimeFamily.NODEJS) },
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.onEvent',
      Runtime: 'nodejs26.x',
    });
  });

  it('creates the handler only after its IAM policy, so the first reconcile can read secrets', () => {
    const { stack, tokenSecret } = setup();
    new VercelProject(stack, 'Web', { ...webDeclaration(), tokenSecret });
    const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function', {
      Properties: { Handler: 'index.onEvent' },
    });
    const [fn] = Object.values(fns) as { DependsOn?: string[] }[];
    expect(fn!.DependsOn?.some((d) => /HandlerServiceRoleDefaultPolicy/.test(d))).toBe(true);
  });

  it('adds a deploy-time nonce by default and omits it when disabled', () => {
    const { stack, tokenSecret } = setup({});
    new VercelProject(stack, 'A', { projectId: 'prj_a', tokenSecret });
    new VercelProject(stack, 'B', { projectId: 'prj_b', tokenSecret, reconcileOnEveryDeploy: false });
    const props = Object.values(Template.fromStack(stack).findResources('Custom::VercelProject')).map(
      (r: any) => r.Properties,
    );
    expect(props[0].Nonce).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(props[1].Nonce).toBeUndefined();
  });

  it('rejects an invalid declaration at synth time', () => {
    const { stack, tokenSecret } = setup();
    expect(() => new VercelProject(stack, 'Bad', { tokenSecret })).toThrow(
      /Invalid VercelProject Vercel\/Bad declaration:\n {2}- Set either `projectId`/,
    );
  });

  it('exposes the project ID as a literal when adopting and an attribute when creating', () => {
    const { stack, tokenSecret } = setup();
    const adopted = new VercelProject(stack, 'Web', { projectId: 'prj_web', tokenSecret });
    const created = new VercelProject(stack, 'New', { create: { name: 'acme-new' }, tokenSecret });
    expect(adopted.projectId).toBe('prj_web');
    expect(stack.resolve(created.projectId)).toEqual({
      'Fn::GetAtt': [expect.stringMatching(/^New/), 'ProjectId'],
    });
  });

  it('serializes the same declaration into the drift gate', () => {
    const { stack, tokenSecret } = setup();
    const web = new VercelProject(stack, 'Web', { ...webDeclaration(), tokenSecret });
    const b64 = driftGateCommand([web]).split(' ').at(-1)!;
    expect(JSON.parse(Buffer.from(b64, 'base64').toString())).toEqual([
      configOf(Template.fromStack(stack)).declaration,
    ]);
    expect(web.declarationJson).toBe(JSON.stringify(webDeclaration()));
  });
});

describe('DNS', () => {
  it('builds an A record at the apex and a CNAME below it from the handler attributes', () => {
    const { stack, tokenSecret } = setup();
    const site = new VercelProject(stack, 'Site', {
      projectId: 'prj_site',
      domains: [{ name: 'example.com' }, { name: 'www.example.com' }],
      tokenSecret,
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
      hostedZoneId: 'Z1',
      zoneName: 'example.com',
    });
    const apex = new VercelDnsRecord(stack, 'Apex', {
      zone,
      domain: 'example.com',
      target: site.dnsTarget('example.com'),
    });
    const www = new VercelDnsRecord(stack, 'Www', {
      zone,
      domain: 'www.example.com',
      target: site.dnsTarget('www.example.com'),
    });
    expect([apex.recordType, www.recordType]).toEqual(['A', 'CNAME']);
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'example.com.',
      Type: 'A',
      ResourceRecords: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^Site'), 'DnsIpv4_example_com'] }],
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'www.example.com.',
      Type: 'CNAME',
      ResourceRecords: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^Site'), 'DnsCname_www_example_com'] }],
    });
  });

  it('refuses dnsTarget for an undeclared domain', () => {
    const { stack, tokenSecret } = setup();
    const p = new VercelProject(stack, 'P', { projectId: 'prj', tokenSecret });
    expect(() => p.dnsTarget('nope.example.com')).toThrow(/not declared/);
  });

  it('exports targets to SSM and reads them back in another stack', () => {
    const { app, stack, tokenSecret } = setup();
    const help = new VercelProject(stack, 'Help', {
      projectId: 'prj_help',
      domains: [{ name: 'help.example.com' }],
      tokenSecret,
    });
    help.exportDnsTargets('/vercel/dns/');
    const other = new Stack(app, 'Staging', { env: { account: '111111111111', region: 'us-east-1' } });
    const zone = route53.HostedZone.fromHostedZoneAttributes(other, 'Zone', {
      hostedZoneId: 'Z1',
      zoneName: 'example.com',
    });
    new VercelDnsRecord(other, 'Help', {
      zone,
      domain: 'help.example.com',
      target: dnsTargetFromSsm(other, 'vercel/dns', 'help.example.com'),
    });
    Template.fromStack(stack).hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/vercel/dns/help.example.com/cname',
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Help'), 'DnsCname_help_example_com'] },
    });
    const t = Template.fromStack(other).toJSON();
    expect(Object.values(t.Parameters ?? {}).map((p: any) => p.Default)).toContain(
      '/vercel/dns/help.example.com/cname',
    );
  });
});
