/**
 * CloudFormation custom resource handler (CDK Provider framework `onEvent`).
 *
 * Create/Update reconcile the declared project. Delete is a no-op: removing the
 * resource never deletes or modifies the Vercel project.
 */
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { VercelClient } from '../runtime/client';
import { dnsAttributeNames, FALLBACK_DNS_TARGET } from '../runtime/domains';
import { jsonLogger } from '../runtime/logger';
import { reconcile, type SecretResolver, type TxtRecordWriter } from '../runtime/reconcile';
import { Redactor } from '../runtime/redact';
import type { HandlerConfig, SecretRef } from '../runtime/types';

export interface OnEventResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

export function secretsManagerResolver(sm: Pick<SecretsManagerClient, 'send'>): SecretResolver {
  const cache = new Map<string, string>();
  return {
    async resolve(ref: SecretRef): Promise<string> {
      let raw = cache.get(ref.secretId);
      if (raw === undefined) {
        const res = await sm.send(new GetSecretValueCommand({ SecretId: ref.secretId }));
        if (res.SecretString === undefined) throw new Error(`Secret ${ref.secretId} has no string value.`);
        raw = res.SecretString;
        cache.set(ref.secretId, raw);
      }
      if (!ref.jsonKey) return raw;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Secret ${ref.secretId} is not JSON, so jsonKey "${ref.jsonKey}" can't be read.`);
      }
      const v = (parsed as Record<string, unknown>)?.[ref.jsonKey];
      if (typeof v !== 'string' || v === '')
        throw new Error(`Secret ${ref.secretId} has no non-empty string key "${ref.jsonKey}".`);
      return v;
    },
  };
}

/** Route 53 TXT writer that merges with the existing record set instead of replacing it. */
export function route53TxtWriter(r53: Pick<Route53Client, 'send'>): TxtRecordWriter {
  return {
    async addTxtValues(zoneId, name, values) {
      const fqdn = name.endsWith('.') ? name : `${name}.`;
      const listed = await r53.send(
        new ListResourceRecordSetsCommand({
          HostedZoneId: zoneId,
          StartRecordName: fqdn,
          StartRecordType: 'TXT',
          MaxItems: 1,
        }),
      );
      const current = (listed.ResourceRecordSets ?? []).find(
        (r) => r.Type === 'TXT' && r.Name?.toLowerCase() === fqdn.toLowerCase() && !r.SetIdentifier,
      );
      const existing = (current?.ResourceRecords ?? []).map((r) => r.Value!).filter(Boolean);
      const wanted = values.map((v) => JSON.stringify(v));
      const merged = [...existing, ...wanted.filter((v) => !existing.includes(v))];
      if (merged.length === existing.length) return; // already present
      await r53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: zoneId,
          ChangeBatch: {
            Comment: 'Vercel domain verification (cdk-vercel)',
            Changes: [
              {
                Action: 'UPSERT',
                ResourceRecordSet: {
                  Name: fqdn,
                  Type: 'TXT',
                  TTL: current?.TTL ?? 300,
                  ResourceRecords: merged.map((Value) => ({ Value })),
                },
              },
            ],
          },
        }),
      );
    },
  };
}

export interface HandlerDeps {
  readonly secretsManager?: Pick<SecretsManagerClient, 'send'>;
  readonly route53?: Pick<Route53Client, 'send'>;
  readonly fetch?: ConstructorParameters<typeof VercelClient>[0]['fetch'];
  readonly write?: (line: string) => void;
}

export async function handle(
  event: CloudFormationCustomResourceEvent,
  deps: HandlerDeps = {},
): Promise<OnEventResponse> {
  const redactor = new Redactor();
  const logger = jsonLogger(redactor, deps.write);
  const physicalId = event.RequestType === 'Create' ? undefined : event.PhysicalResourceId;

  if (event.RequestType === 'Delete') {
    logger.log('info', 'delete: leaving the Vercel project untouched (retain on delete)', {
      physicalResourceId: physicalId,
    });
    return { PhysicalResourceId: physicalId! };
  }

  try {
    const props = event.ResourceProperties as Record<string, string>;
    const config = JSON.parse(props.Config!) as HandlerConfig;
    const sm = deps.secretsManager ?? new SecretsManagerClient({});
    const secrets = secretsManagerResolver(sm);
    const token = await secrets.resolve({
      secretId: props.TokenSecretId!,
      jsonKey: props.TokenJsonKey || undefined,
    });
    redactor.add(token);

    const client = new VercelClient({
      token,
      teamId: config.declaration.teamId,
      redactor,
      fetch: deps.fetch,
    });
    const result = await reconcile({
      declaration: config.declaration,
      client,
      secrets,
      logger,
      txt: route53TxtWriter(deps.route53 ?? new Route53Client({})),
      dryRun: config.dryRun,
      existingProjectId: physicalId,
      secretsHashKey: token,
    });

    const data: Record<string, string> = {
      ProjectId: result.projectId,
      ProjectName: result.projectName,
      SecretsHash: result.secretsHash,
      Changes: String(result.changes),
    };
    // Every declared domain gets attributes, even in a dry-run create, so Fn::GetAtt never fails.
    for (const dom of config.declaration.domains ?? []) {
      const t = result.dnsTargets[dom.name] ?? FALLBACK_DNS_TARGET;
      const names = dnsAttributeNames(dom.name);
      data[names.cname] = t.cname;
      data[names.ipv4] = t.ipv4;
    }
    return { PhysicalResourceId: result.projectId, Data: data };
  } catch (err) {
    const message = redactor.redact(err instanceof Error ? err.message : String(err));
    logger.log('error', 'reconcile failed', { error: message });
    // The Provider framework reports this message in the CloudFormation event, failing the update visibly.
    throw new Error(message);
  }
}

export const onEvent = (event: CloudFormationCustomResourceEvent) => handle(event);
