/** The subset of Vercel API response shapes this library reads. */

export interface LiveProjectLink {
  type?: string;
  org?: string;
  repo?: string;
  repoId?: number;
  productionBranch?: string;
  // GitLab
  projectNamespace?: string;
  projectName?: string;
  // Bitbucket
  owner?: string;
  slug?: string;
}

export interface LiveProtectionBypassEntry {
  scope: 'automation-bypass' | 'integration-automation-bypass' | string;
  note?: string;
  isEnvVar?: boolean;
  createdAt?: number;
}

export interface LiveProject {
  id: string;
  name: string;
  accountId: string;
  link?: LiveProjectLink;
  ssoProtection?: { deploymentType: string } | null;
  passwordProtection?: { deploymentType: string } | null;
  protectionBypass?: Record<string, LiveProtectionBypassEntry>;
  resourceConfig?: { functionDefaultRegions?: string[] } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface LiveEnvVar {
  id: string;
  key: string;
  value?: string;
  type: 'system' | 'secret' | 'encrypted' | 'plain' | 'sensitive';
  target?: string[] | string;
  gitBranch?: string | null;
  comment?: string;
  configurationId?: string | null;
  system?: boolean;
  decrypted?: boolean;
}

export interface LiveProjectDomain {
  name: string;
  apexName?: string;
  projectId?: string;
  redirect?: string | null;
  redirectStatusCode?: number | null;
  gitBranch?: string | null;
  customEnvironmentId?: string | null;
  verified: boolean;
  verification?: { type: string; domain: string; value: string; reason: string }[];
}

export interface LiveDomainConfig {
  misconfigured?: boolean;
  recommendedCNAME?: { rank: number; value: string }[];
  recommendedIPv4?: { rank: number; value: string[] }[];
}

export interface LiveDeployment {
  uid: string;
  url?: string;
  name?: string;
  state?: string;
  readyState?: string;
  target?: string | null;
  inspectorUrl?: string | null;
  created?: number;
  createdAt?: number;
  errorMessage?: string | null;
  meta?: Record<string, string | undefined>;
}
