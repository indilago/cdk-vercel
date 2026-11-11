import { CustomResource, Token } from 'aws-cdk-lib';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { VercelProvider, type VercelProviderProps } from './provider';
import { dnsAttributeNames } from './runtime/domains';
import type { DnsTarget, HandlerConfig, SecretRef, VercelProjectDeclaration } from './runtime/types';
import { assertValidDeclaration } from './runtime/validate';

/** Context key that fixes the reconcile nonce (useful for snapshot tests). */
export const NONCE_CONTEXT_KEY = 'cdk-vercel:nonce';

const DECLARATION_KEYS = [
  'teamId',
  'projectId',
  'create',
  'expectRepo',
  'settings',
  'env',
  'pruneUndeclaredEnv',
  'domains',
  'pruneUndeclaredDomains',
  'protection',
] as const satisfies readonly (keyof VercelProjectDeclaration)[];

export interface VercelProjectProps extends VercelProjectDeclaration {
  /** Secrets Manager secret holding a Vercel API token with access to the project. */
  readonly tokenSecret: secretsmanager.ISecret;
  /** When the token secret is a JSON object, the key holding the token. */
  readonly tokenSecretJsonKey?: string;
  /** Log the changes the handler would make and skip every write. @default false */
  readonly dryRun?: boolean;
  /**
   * Run the reconcile on every deploy, not only when these props change. This corrects
   * dashboard drift and picks up rotated secret values. It adds a nonce to the resource
   * properties; set the `cdk-vercel:nonce` context value to fix it in snapshot tests.
   * @default true
   */
  readonly reconcileOnEveryDeploy?: boolean;
  /** KMS keys encrypting any referenced secrets that don't use the AWS-managed key. */
  readonly secretEncryptionKeys?: readonly kms.IKey[];
  /** Options for the shared provider. Only used by the first `VercelProject` in a stack. */
  readonly provider?: VercelProviderProps;
}

/**
 * A Vercel project managed by CloudFormation through a Lambda-backed custom resource.
 *
 * - Adopts an existing project by default; creates one only with `create`.
 * - Manages only what is declared. Undeclared settings are never read or reset.
 * - Retains on delete: removing the construct or the stack leaves the project untouched.
 */
export class VercelProject extends Construct {
  /** The project ID. A literal when adopting, a deploy-time token when creating. */
  readonly projectId: string;
  /** The project's name as reported by Vercel. */
  readonly projectName: string;
  /** SHA-256 of the resolved secret values (changes when a secret rotates). */
  readonly secretsHash: string;
  /** The plain declaration, also what the drift gate checks. */
  readonly declaration: VercelProjectDeclaration;
  readonly resource: CustomResource;

  constructor(scope: Construct, id: string, props: VercelProjectProps) {
    super(scope, id);
    const declaration = pickDeclaration(props);
    assertValidDeclaration(declaration, `VercelProject ${this.node.path}`);
    this.declaration = declaration;

    const provider = VercelProvider.getOrCreate(this, props.provider);
    props.tokenSecret.grantRead(provider.handler);
    for (const ref of secretRefsOf(declaration)) provider.grantSecretRef(ref);
    for (const key of props.secretEncryptionKeys ?? []) key.grantDecrypt(provider.handler);
    for (const dom of declaration.domains ?? [])
      if (dom.verificationZoneId) provider.grantTxtRecords(dom.verificationZoneId);

    const config: HandlerConfig = { declaration, dryRun: props.dryRun ?? false };
    const properties: Record<string, string> = {
      Config: JSON.stringify(config),
      TokenSecretId: props.tokenSecret.secretArn,
    };
    if (props.tokenSecretJsonKey) properties.TokenJsonKey = props.tokenSecretJsonKey;
    if (props.reconcileOnEveryDeploy ?? true) {
      properties.Nonce = String(this.node.tryGetContext(NONCE_CONTEXT_KEY) ?? new Date().toISOString());
    }

    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::VercelProject',
      properties,
    });
    this.projectId = declaration.projectId ?? this.resource.getAttString('ProjectId');
    this.projectName = this.resource.getAttString('ProjectName');
    this.secretsHash = this.resource.getAttString('SecretsHash');
  }

  /** The declaration as JSON, for the drift gate. */
  get declarationJson(): string {
    return JSON.stringify(this.declaration);
  }

  /** Vercel's recommended DNS targets for a declared domain, resolved at deploy time. */
  dnsTarget(domain: string): DnsTarget {
    const declared = (this.declaration.domains ?? []).some(
      (d) => d.name.toLowerCase() === domain.toLowerCase(),
    );
    if (!declared) throw new Error(`${this.node.path}: domain "${domain}" is not declared on this project.`);
    const names = dnsAttributeNames(domain);
    return { cname: this.resource.getAttString(names.cname), ipv4: this.resource.getAttString(names.ipv4) };
  }

  /**
   * Write each declared domain's DNS targets to SSM parameters
   * (`<prefix>/<domain>/cname` and `<prefix>/<domain>/ipv4`), so stacks in other stages
   * can build Route 53 records with `dnsTargetFromSsm`.
   */
  exportDnsTargets(parameterPrefix: string): void {
    const prefix = normalizePrefix(parameterPrefix);
    for (const dom of this.declaration.domains ?? []) {
      const t = this.dnsTarget(dom.name);
      new ssm.StringParameter(this, `DnsCname-${dom.name}`, {
        parameterName: `${prefix}/${dom.name}/cname`,
        stringValue: t.cname,
      });
      new ssm.StringParameter(this, `DnsIpv4-${dom.name}`, {
        parameterName: `${prefix}/${dom.name}/ipv4`,
        stringValue: t.ipv4,
      });
    }
  }
}

/** Read a domain's DNS targets from parameters written by `VercelProject.exportDnsTargets`. */
export function dnsTargetFromSsm(scope: Construct, parameterPrefix: string, domain: string): DnsTarget {
  const prefix = normalizePrefix(parameterPrefix);
  return {
    cname: ssm.StringParameter.valueForStringParameter(scope, `${prefix}/${domain}/cname`),
    ipv4: ssm.StringParameter.valueForStringParameter(scope, `${prefix}/${domain}/ipv4`),
  };
}

function normalizePrefix(p: string): string {
  if (Token.isUnresolved(p)) throw new Error('The SSM parameter prefix must be a literal string.');
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function pickDeclaration(props: VercelProjectProps): VercelProjectDeclaration {
  const out: Record<string, unknown> = {};
  for (const k of DECLARATION_KEYS) if (props[k] !== undefined) out[k] = props[k];
  // Round-trip through JSON so the stored declaration is exactly what the handler and gate see.
  return JSON.parse(JSON.stringify(out));
}

/** Every Secrets Manager reference in a declaration (env values, password, bypass secrets). */
export function secretRefsOf(d: VercelProjectDeclaration): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const v of d.env ?? []) if (v.secret) refs.push(v.secret);
  if (d.protection?.passwordProtection) refs.push(d.protection.passwordProtection.password);
  for (const s of d.protection?.automationBypass?.secrets ?? []) refs.push(s);
  return refs;
}
