import { overlaps } from './compare';
import type { VercelProjectDeclaration } from './types';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TARGETS = new Set(['production', 'preview', 'development']);
const REDIRECT_CODES = new Set([301, 302, 307, 308]);
const SCOPES = new Set([
  'all',
  'preview',
  'prod_deployment_urls_and_all_previews',
  'all_except_custom_domains',
]);

/** Return every problem with a declaration (empty when valid). Used at synth time and in the handler. */
export function validateDeclaration(d: VercelProjectDeclaration): string[] {
  const errors: string[] = [];
  const err = (m: string) => errors.push(m);

  if (!d.projectId && !d.create) err('Set either `projectId` (adopt an existing project) or `create`.');
  if (d.projectId && d.create) err('`projectId` and `create` are mutually exclusive.');
  if (d.create && !d.create.name) err('`create.name` is required.');
  if (d.expectRepo !== undefined && !/^[^/\s]+\/[^\s]+$/.test(d.expectRepo)) {
    err(`\`expectRepo\` must look like "owner/name", got "${d.expectRepo}".`);
  }

  const s = d.settings ?? {};
  if (
    s.skewProtectionMaxAge !== undefined &&
    !(Number.isInteger(s.skewProtectionMaxAge) && s.skewProtectionMaxAge >= 0)
  ) {
    err('`settings.skewProtectionMaxAge` must be a non-negative integer number of seconds.');
  }
  for (const k of Object.keys(s.additionalSettings ?? {})) {
    if (k in s && k !== 'additionalSettings')
      err(`\`settings.additionalSettings.${k}\` duplicates \`settings.${k}\`.`);
  }

  const env = d.env ?? [];
  env.forEach((v, i) => {
    const at = `env[${i}] (${v.key})`;
    if (!ENV_KEY.test(v.key ?? '')) err(`${at}: invalid key.`);
    const hasValue = (v as { value?: unknown }).value !== undefined;
    const hasSecret = (v as { secret?: unknown }).secret !== undefined;
    if (hasValue === hasSecret) err(`${at}: set exactly one of \`value\` or \`secret\`.`);
    if (hasSecret && !(v as { secret: { secretId?: string } }).secret.secretId)
      err(`${at}: \`secret.secretId\` is required.`);
    if (!v.targets?.length) err(`${at}: \`targets\` must not be empty.`);
    for (const t of v.targets ?? []) if (!TARGETS.has(t)) err(`${at}: unknown target "${t}".`);
    if (new Set(v.targets).size !== v.targets?.length) err(`${at}: duplicate targets.`);
    if (v.gitBranch && (v.targets.length !== 1 || v.targets[0] !== 'preview')) {
      err(`${at}: \`gitBranch\` is only allowed with \`targets: ['preview']\`.`);
    }
    if (v.type === 'sensitive' && hasValue) {
      err(
        `${at}: a \`sensitive\` env var must use \`secret\` (Secrets Manager). Literal values are stored in the ` +
          'CloudFormation template; use type `plain` or `encrypted` for values that are not secret.',
      );
    }
    if (v.type === 'sensitive' && v.targets?.includes('development')) {
      err(`${at}: Vercel does not allow \`sensitive\` env vars to target \`development\`.`);
    }
  });
  for (let i = 0; i < env.length; i++) {
    for (let j = i + 1; j < env.length; j++) {
      const a = env[i]!;
      const b = env[j]!;
      if (a.key === b.key && (a.gitBranch ?? '') === (b.gitBranch ?? '') && overlaps(a.targets, b.targets)) {
        err(
          `env: "${a.key}" is declared more than once for the same target and branch (env[${i}], env[${j}]).`,
        );
      }
    }
  }

  const domains = d.domains ?? [];
  const names = new Set<string>();
  for (const dom of domains) {
    const n = dom.name?.toLowerCase();
    if (!n || !/^[a-z0-9.-]+$/.test(n)) err(`domains: invalid name "${dom.name}".`);
    if (names.has(n)) err(`domains: "${dom.name}" is declared more than once.`);
    names.add(n);
    if (dom.redirectStatusCode !== undefined && !dom.redirect)
      err(`domains: "${dom.name}" sets redirectStatusCode without redirect.`);
    if (dom.redirectStatusCode !== undefined && !REDIRECT_CODES.has(dom.redirectStatusCode)) {
      err(`domains: "${dom.name}" redirectStatusCode must be 301, 302, 307 or 308.`);
    }
    if (dom.redirect && dom.redirect.toLowerCase() === n) err(`domains: "${dom.name}" redirects to itself.`);
  }

  const p = d.protection;
  if (p?.vercelAuthentication && !SCOPES.has(p.vercelAuthentication)) {
    err(`protection.vercelAuthentication: unknown scope "${p.vercelAuthentication}".`);
  }
  if (p?.passwordProtection && !SCOPES.has(p.passwordProtection.scope)) {
    err(`protection.passwordProtection: unknown scope "${p.passwordProtection.scope}".`);
  }
  return errors;
}

export function assertValidDeclaration(d: VercelProjectDeclaration, label = 'Vercel project'): void {
  const errors = validateDeclaration(d);
  if (errors.length) throw new Error(`Invalid ${label} declaration:\n  - ${errors.join('\n  - ')}`);
}
