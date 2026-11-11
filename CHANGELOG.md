# Changelog

## 0.1.2 (2026-11-10)

- Published from GitHub Actions with npm trusted publishing, with provenance. No library changes.

## 0.1.1 (2026-11-10)

- Treat a live domain redirect with a null status code as the 307 default, so it no longer
  shows as drift against a planned 307.
- Don't double the period after Vercel's deployment error message in `wait-deployment` output.
- Move pnpm's `onlyBuiltDependencies` setting into `pnpm-workspace.yaml` (no change to the
  published package).

## 0.1.0 (2026-11-10)

Initial release.

- `VercelProject` construct: adopt or create a project; manage settings, env vars (literal or
  Secrets Manager), domains, Deployment Protection and automation bypass secrets. Partial
  management, retain on delete, dry run, reconcile on every deploy, repo/team guards,
  `create.adoptIfExists` recovery.
- `VercelDnsRecord`, `dnsTarget()`, `exportDnsTargets()` / `dnsTargetFromSsm()` for Route 53
  records from Vercel's recommended targets, and TXT domain verification.
- `cdk-vercel drift` and `cdk-vercel wait-deployment` CLI commands, with
  `driftGateCommand()` / `waitForDeploymentCommand()` builders for pipeline steps.
- `checkEnvParity()` for staging/production env var parity tests.
- `cdk-vercel/runtime`: the CDK-free client, planners, reconciler and drift check.
