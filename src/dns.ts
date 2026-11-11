import { type Duration, Token } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import type { DnsTarget } from './runtime/types';

export interface VercelDnsRecordProps {
  readonly zone: route53.IHostedZone;
  /** Fully-qualified domain, e.g. `app.example.com` or the zone apex `example.com`. */
  readonly domain: string;
  /** From `VercelProject.dnsTarget()` or `dnsTargetFromSsm()`. */
  readonly target: DnsTarget;
  /**
   * `A` for the zone apex, `CNAME` otherwise. Required when the zone name is a token.
   * Switching an existing name between an alias/A record and a CNAME needs two deploys
   * (remove the old record, then add the new one); do not change it in one step.
   */
  readonly recordType?: 'A' | 'CNAME';
  /** @default Duration.minutes(5) */
  readonly ttl?: Duration;
  readonly comment?: string;
}

/** A Route 53 record pointing a domain at Vercel, using Vercel's own recommended target. */
export class VercelDnsRecord extends Construct {
  readonly record: route53.RecordSet;
  readonly recordType: 'A' | 'CNAME';

  constructor(scope: Construct, id: string, props: VercelDnsRecordProps) {
    super(scope, id);
    const domain = props.domain.replace(/\.$/, '').toLowerCase();
    let type = props.recordType;
    if (!type) {
      if (Token.isUnresolved(props.zone.zoneName)) {
        throw new Error(
          `${this.node.path}: the zone name is not known at synth time; set recordType explicitly.`,
        );
      }
      type = domain === props.zone.zoneName.replace(/\.$/, '').toLowerCase() ? 'A' : 'CNAME';
    }
    this.recordType = type;
    const common = {
      zone: props.zone,
      recordName: `${domain}.`,
      ttl: props.ttl,
      comment: props.comment ?? 'Vercel (cdk-vercel)',
    };
    this.record =
      type === 'A'
        ? new route53.ARecord(this, 'Record', {
            ...common,
            target: route53.RecordTarget.fromIpAddresses(props.target.ipv4),
          })
        : new route53.CnameRecord(this, 'Record', { ...common, domainName: props.target.cname });
  }
}
