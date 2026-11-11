import type { LiveDomainConfig, LiveProjectDomain } from './api-types';
import { normalizeEmpty } from './compare';
import type { DnsTarget, VercelDomain } from './types';

export type DomainAction =
  | { readonly op: 'add'; readonly decl: VercelDomain }
  | {
      readonly op: 'update';
      readonly decl: VercelDomain;
      readonly live: LiveProjectDomain;
      readonly changes: readonly DomainChange[];
    }
  | { readonly op: 'remove'; readonly live: LiveProjectDomain };

export interface DomainChange {
  readonly field: 'redirect' | 'redirectStatusCode' | 'gitBranch';
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface DomainPlan {
  readonly actions: readonly DomainAction[];
  readonly undeclared: readonly LiveProjectDomain[];
}

/** Vercel's own `<project>.vercel.app` hostnames are never detached. */
export function isVercelOwnedDomain(name: string): boolean {
  return name.endsWith('.vercel.app');
}

const DEFAULT_REDIRECT_STATUS = 307;

export function planDomains(
  declared: readonly VercelDomain[],
  live: readonly LiveProjectDomain[],
  prune: boolean,
): DomainPlan {
  const liveByName = new Map(live.map((d) => [d.name.toLowerCase(), d]));
  const declaredNames = new Set(declared.map((d) => d.name.toLowerCase()));
  const adds: DomainAction[] = [];
  const updates: DomainAction[] = [];

  for (const d of declared) {
    const l = liveByName.get(d.name.toLowerCase());
    if (!l) {
      adds.push({ op: 'add', decl: d });
      continue;
    }
    const changes: DomainChange[] = [];
    const cmp = (field: DomainChange['field'], expected: unknown, actual: unknown) => {
      if (normalizeEmpty(expected) !== normalizeEmpty(actual))
        changes.push({ field, expected: expected ?? null, actual: actual ?? null });
    };
    cmp('redirect', d.redirect, l.redirect);
    // Vercel stores a redirect created without a status code as `null` and serves it as 307,
    // so a live `null` on a redirecting domain is the default, not drift.
    if (d.redirect)
      cmp(
        'redirectStatusCode',
        d.redirectStatusCode ?? DEFAULT_REDIRECT_STATUS,
        l.redirect ? (l.redirectStatusCode ?? DEFAULT_REDIRECT_STATUS) : l.redirectStatusCode,
      );
    cmp('gitBranch', d.gitBranch, l.gitBranch);
    if (changes.length) updates.push({ op: 'update', decl: d, live: l, changes });
  }

  // A redirect can only point at a domain that is already attached: add plain domains first.
  adds.sort(
    (a, b) =>
      Number(!!(a as { decl: VercelDomain }).decl.redirect) -
      Number(!!(b as { decl: VercelDomain }).decl.redirect),
  );

  const removes: DomainAction[] = [];
  const undeclared: LiveProjectDomain[] = [];
  for (const l of live) {
    if (declaredNames.has(l.name.toLowerCase()) || isVercelOwnedDomain(l.name)) continue;
    if (prune) removes.push({ op: 'remove', live: l });
    else undeclared.push(l);
  }
  // Remove redirecting domains before the domains they point at.
  removes.sort(
    (a, b) =>
      Number(!(a as { live: LiveProjectDomain }).live.redirect) -
      Number(!(b as { live: LiveProjectDomain }).live.redirect),
  );

  return { actions: [...adds, ...updates, ...removes], undeclared };
}

export function domainBody(d: VercelDomain): Record<string, unknown> {
  return {
    redirect: d.redirect ?? null,
    redirectStatusCode: d.redirect ? (d.redirectStatusCode ?? DEFAULT_REDIRECT_STATUS) : null,
    gitBranch: d.gitBranch ?? null,
  };
}

/** Vercel's documented defaults, used only if the config endpoint returns no recommendation. */
export const FALLBACK_DNS_TARGET: DnsTarget = { cname: 'cname.vercel-dns.com', ipv4: '76.76.21.21' };

/** Pick the rank-1 recommendations out of a `GET /v6/domains/{domain}/config` response. */
export function dnsTargetFromConfig(config: LiveDomainConfig): DnsTarget & { fallback: boolean } {
  const byRank = <T extends { rank: number }>(xs: T[] | undefined) =>
    [...(xs ?? [])].sort((a, b) => a.rank - b.rank)[0];
  const cname = byRank(config.recommendedCNAME)?.value?.replace(/\.$/, '');
  const ipv4 = byRank(config.recommendedIPv4)?.value?.[0];
  return {
    cname: cname || FALLBACK_DNS_TARGET.cname,
    ipv4: ipv4 || FALLBACK_DNS_TARGET.ipv4,
    fallback: !cname || !ipv4,
  };
}

/** CloudFormation attribute names for a domain's DNS targets. */
export function dnsAttributeNames(domain: string): { cname: string; ipv4: string } {
  const s = domain.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return { cname: `DnsCname_${s}`, ipv4: `DnsIpv4_${s}` };
}
