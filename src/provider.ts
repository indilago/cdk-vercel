import * as path from 'node:path';
import { ArnFormat, Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { SecretRef } from './runtime/types';

/** Location of the pre-bundled handler, relative to both `src/` and `dist/`. */
export const HANDLER_ASSET_PATH = path.join(__dirname, '..', 'assets', 'handler');

export interface VercelProviderProps {
  /**
   * Lambda runtime for the handler. The bundle targets Node.js 22+, so any later Node.js
   * runtime works (e.g. Node.js 26 once Lambda offers it).
   * @default Node.js 24.x
   */
  readonly runtime?: lambda.Runtime;
  /** @default lambda.Architecture.ARM_64 */
  readonly architecture?: lambda.Architecture;
  /** @default Duration.minutes(5) */
  readonly timeout?: Duration;
  /** @default logs.RetentionDays.ONE_MONTH */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * The Lambda-backed provider behind every `VercelProject` in a stack. One per stack,
 * shared by all projects; its IAM policy grows to cover exactly the secrets and hosted
 * zones the projects reference.
 */
export class VercelProvider extends Construct {
  static readonly ID = 'CdkVercelProvider';

  /** Return the stack's provider, creating it on first use. `props` only apply on creation. */
  static getOrCreate(scope: Construct, props: VercelProviderProps = {}): VercelProvider {
    const stack = Stack.of(scope);
    return (
      (stack.node.tryFindChild(VercelProvider.ID) as VercelProvider | undefined) ??
      new VercelProvider(stack, VercelProvider.ID, props)
    );
  }

  readonly handler: lambda.Function;
  readonly serviceToken: string;
  private readonly granted = new Set<string>();

  private constructor(scope: Construct, id: string, props: VercelProviderProps) {
    super(scope, id);
    this.handler = new lambda.Function(this, 'Handler', {
      description: 'cdk-vercel: reconciles Vercel projects with their CDK declarations',
      runtime:
        props.runtime ??
        new lambda.Runtime('nodejs24.x', lambda.RuntimeFamily.NODEJS, { supportsInlineCode: true }),
      architecture: props.architecture ?? lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(HANDLER_ASSET_PATH),
      handler: 'index.onEvent',
      timeout: props.timeout ?? Duration.minutes(5),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'HandlerLogs', {
        retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      }),
    });
    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: this.handler,
      logGroup: new logs.LogGroup(this, 'ProviderLogs', {
        retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      }),
    });
    this.serviceToken = provider.serviceToken;
  }

  /** Allow the handler to read one secret given by name or ARN (no wildcard beyond the 6-character ARN suffix). */
  grantSecretRef(ref: SecretRef): void {
    const id = ref.secretId;
    if (this.granted.has(`secret:${id}`)) return;
    this.granted.add(`secret:${id}`);
    const resources = id.startsWith('arn:')
      ? [id, `${id}-??????`]
      : [
          Stack.of(this).formatArn({
            service: 'secretsmanager',
            resource: 'secret',
            resourceName: `${id}-??????`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ];
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources }),
    );
  }

  /** Allow the handler to read one hosted zone's records and write only `_vercel.*` TXT records (domain verification). */
  grantTxtRecords(hostedZoneId: string): void {
    const zoneId = hostedZoneId.replace(/^\/?hostedzone\//, '');
    if (this.granted.has(`zone:${zoneId}`)) return;
    this.granted.add(`zone:${zoneId}`);
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:${Stack.of(this).partition}:route53:::hostedzone/${zoneId}`],
        conditions: {
          'ForAllValues:StringEquals': { 'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'] },
          'ForAllValues:StringLike': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': ['_vercel.*'],
          },
        },
      }),
    );
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['route53:ListResourceRecordSets'],
        resources: [`arn:${Stack.of(this).partition}:route53:::hostedzone/${zoneId}`],
      }),
    );
  }
}
