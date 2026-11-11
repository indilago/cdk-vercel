/**
 * Declaration types for a managed Vercel project.
 *
 * Everything here is plain, JSON-serializable data with no AWS CDK imports, so one
 * object per project can feed both the `VercelProject` construct (applied at deploy
 * time) and the `cdk-vercel drift` gate (checked in a pipeline step), and can be
 * unit-tested on its own.
 */

/** A Vercel environment variable target. */
export type VercelEnvTarget = 'production' | 'preview' | 'development';

/**
 * How Vercel stores an env var value.
 * - `plain`: readable back from the API and in the dashboard.
 * - `encrypted`: encrypted at rest, decryptable through the API.
 * - `sensitive`: write-only. Cannot be read back, and cannot target `development`.
 */
export type VercelEnvType = 'plain' | 'encrypted' | 'sensitive';

/** Which deployments a Deployment Protection feature applies to. */
export type DeploymentProtectionScope =
  | 'all'
  | 'preview'
  | 'prod_deployment_urls_and_all_previews'
  | 'all_except_custom_domains';

/**
 * A value held in AWS Secrets Manager. It is resolved inside the handler Lambda at
 * deploy time and never written to the CloudFormation template, parameters or outputs.
 */
export interface SecretRef {
  /** Secret name or full ARN, as accepted by `GetSecretValue`'s `SecretId`. */
  readonly secretId: string;
  /** When the secret string is a JSON object, the key to read. Omit for raw string secrets. */
  readonly jsonKey?: string;
}

/**
 * Project settings. Every field is optional: a field you leave `undefined` is not
 * managed and is never read, compared or reset. A field set to `null` is managed and
 * means "unset / let Vercel auto-detect".
 */
export interface VercelProjectSettings {
  readonly framework?: string | null;
  readonly rootDirectory?: string | null;
  readonly nodeVersion?: string;
  readonly buildCommand?: string | null;
  readonly installCommand?: string | null;
  readonly devCommand?: string | null;
  readonly outputDirectory?: string | null;
  /** Shell command Vercel runs to decide whether to skip a Git-triggered build (exit 0 = skip). */
  readonly commandForIgnoringBuildStep?: string | null;
  /** "Skip deployments when there are no changes to the root directory or its dependencies". */
  readonly enableAffectedProjectsDeployments?: boolean;
  /** Git branch whose pushes create production deployments. */
  readonly productionBranch?: string;
  /** Whether production deployments automatically take the project's custom domains when READY. */
  readonly autoAssignCustomDomains?: boolean;
  /** "Include source files outside of the Root Directory in the Build Step". */
  readonly sourceFilesOutsideRootDirectory?: boolean;
  /** Default region for Vercel Functions, e.g. `iad1`. */
  readonly serverlessFunctionRegion?: string;
  /** Skew Protection rolling window in seconds. `0` disables it. */
  readonly skewProtectionMaxAge?: number;
  /** Require team authorization before deploying pull requests from forks. */
  readonly gitForkProtection?: boolean;
  readonly autoExposeSystemEnvs?: boolean;
  readonly directoryListing?: boolean;
  readonly previewDeploymentsDisabled?: boolean;
  readonly gitLFS?: boolean;
  readonly protectedSourcemaps?: boolean;
  readonly customerSupportCodeVisibility?: boolean;
  /**
   * Escape hatch for any other top-level field accepted by `PATCH /v9/projects/{id}`.
   * Compared as a subset: object values only need the declared keys to match.
   */
  readonly additionalSettings?: Readonly<Record<string, unknown>>;
}

interface VercelEnvVarBase {
  readonly key: string;
  readonly targets: readonly VercelEnvTarget[];
  /** Only for `targets: ['preview']`: scope the value to one Git branch's preview deployments. */
  readonly gitBranch?: string;
  /** Defaults to `encrypted`. */
  readonly type?: VercelEnvType;
  readonly comment?: string;
}

/** An env var with a literal value. Use only for values that are not secret. */
export interface VercelEnvVarLiteral extends VercelEnvVarBase {
  readonly value: string;
  readonly secret?: never;
}

/** An env var whose value is read from Secrets Manager inside the handler Lambda. */
export interface VercelEnvVarSecret extends VercelEnvVarBase {
  readonly secret: SecretRef;
  readonly value?: never;
}

export type VercelEnvVar = VercelEnvVarLiteral | VercelEnvVarSecret;

export type VercelRedirectStatusCode = 301 | 302 | 307 | 308;

export interface VercelDomain {
  /** Fully-qualified host name, e.g. `app.example.com`. */
  readonly name: string;
  /** Redirect every request on this domain to another domain. */
  readonly redirect?: string;
  /** Defaults to Vercel's default (307) when `redirect` is set. */
  readonly redirectStatusCode?: VercelRedirectStatusCode;
  /** Serve the latest deployment of this Git branch instead of production. */
  readonly gitBranch?: string;
  /**
   * When Vercel requires a TXT ownership record for this domain, the handler writes it
   * to this Route 53 hosted zone and asks Vercel to re-verify.
   */
  readonly verificationZoneId?: string;
}

export interface VercelAutomationBypass {
  /**
   * Bypass secrets to keep registered on the project (Vercel requires 32 characters).
   * Store them in Secrets Manager, for example a `secretsmanager.Secret` with
   * `generateSecretString: { passwordLength: 32, excludePunctuation: true }`.
   */
  readonly secrets: readonly SecretRef[];
  /**
   * Revoke automation bypass secrets this library did not create. Bypasses created
   * by this library and no longer declared (a rotation) are always revoked.
   * @default false
   */
  readonly pruneUnmanaged?: boolean;
}

export interface VercelProtection {
  /** Vercel Authentication. `null` turns it off. */
  readonly vercelAuthentication?: DeploymentProtectionScope | null;
  /** Password Protection. `null` turns it off. The password is rewritten on every reconcile. */
  readonly passwordProtection?: {
    readonly scope: DeploymentProtectionScope;
    readonly password: SecretRef;
  } | null;
  /** Protection Bypass for Automation secrets. */
  readonly automationBypass?: VercelAutomationBypass;
}

export type VercelGitProvider = 'github' | 'gitlab' | 'bitbucket';

export interface VercelProjectCreateOptions {
  readonly name: string;
  /** Connect a Git repository when creating, e.g. `{ type: 'github', repo: 'acme/web' }`. */
  readonly gitRepository?: { readonly type: VercelGitProvider; readonly repo: string };
  /**
   * If a project with this name already exists, adopt it instead of failing. Use this to
   * recover when a create succeeded but a later step failed and the stack rolled back
   * (the project is retained, so the retry finds it). If `gitRepository` is set, the
   * existing project must be linked to that repository.
   * @default false
   */
  readonly adoptIfExists?: boolean;
}

/**
 * The full declaration of one managed Vercel project.
 */
export interface VercelProjectDeclaration {
  /** The Vercel team that owns the project. Omit for a personal-account project. */
  readonly teamId?: string;
  /** Adopt this existing project (the default mode). Mutually exclusive with `create`. */
  readonly projectId?: string;
  /** Create the project instead of adopting one. Mutually exclusive with `projectId`. */
  readonly create?: VercelProjectCreateOptions;
  /**
   * Refuse to touch the project unless it is linked to this repository (`owner/name`).
   * Guards against a pasted-in wrong project ID.
   */
  readonly expectRepo?: string;
  readonly settings?: VercelProjectSettings;
  /** Env vars to upsert. Omit to leave env vars entirely unmanaged. */
  readonly env?: readonly VercelEnvVar[];
  /**
   * Delete env vars present in Vercel but not declared. Integration-owned and system
   * env vars are never deleted.
   * @default false (undeclared vars are reported only)
   */
  readonly pruneUndeclaredEnv?: boolean;
  /** Project domains to attach. Omit to leave domains entirely unmanaged. */
  readonly domains?: readonly VercelDomain[];
  /**
   * Detach project domains not declared. `*.vercel.app` domains are never detached.
   * @default false (undeclared domains are reported only)
   */
  readonly pruneUndeclaredDomains?: boolean;
  readonly protection?: VercelProtection;
}

/**
 * The custom resource's `Config` property (JSON). The token secret is passed separately
 * as `TokenSecretId` / `TokenJsonKey` because its ARN is a deploy-time token.
 */
export interface HandlerConfig {
  readonly declaration: VercelProjectDeclaration;
  readonly dryRun?: boolean;
}

/** DNS records Vercel recommends for a domain. */
export interface DnsTarget {
  /** Rank-1 recommended CNAME target, for subdomains. */
  readonly cname: string;
  /** Rank-1 recommended IPv4 address, for apex domains. */
  readonly ipv4: string;
}
