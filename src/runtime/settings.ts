import type { LiveProject } from './api-types';
import { matchesSubset, normalizeEmpty } from './compare';
import type { VercelProjectSettings } from './types';

export interface FieldDiff {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

type SettingKey = Exclude<keyof VercelProjectSettings, 'additionalSettings'>;

interface FieldSpec {
  /** Read the live value off a `GET /v9/projects/{id}` response. */
  read(project: LiveProject): unknown;
  /** How the field is written. */
  write: 'patch' | 'productionBranch';
}

const topLevel = (key: string): FieldSpec => ({ read: (p) => p[key], write: 'patch' });

/** Where each managed setting lives in the Vercel API. */
export const SETTING_FIELDS: Record<SettingKey, FieldSpec> = {
  framework: topLevel('framework'),
  rootDirectory: topLevel('rootDirectory'),
  nodeVersion: topLevel('nodeVersion'),
  buildCommand: topLevel('buildCommand'),
  installCommand: topLevel('installCommand'),
  devCommand: topLevel('devCommand'),
  outputDirectory: topLevel('outputDirectory'),
  commandForIgnoringBuildStep: topLevel('commandForIgnoringBuildStep'),
  enableAffectedProjectsDeployments: topLevel('enableAffectedProjectsDeployments'),
  autoAssignCustomDomains: topLevel('autoAssignCustomDomains'),
  sourceFilesOutsideRootDirectory: topLevel('sourceFilesOutsideRootDirectory'),
  skewProtectionMaxAge: topLevel('skewProtectionMaxAge'),
  gitForkProtection: topLevel('gitForkProtection'),
  autoExposeSystemEnvs: topLevel('autoExposeSystemEnvs'),
  directoryListing: topLevel('directoryListing'),
  previewDeploymentsDisabled: topLevel('previewDeploymentsDisabled'),
  gitLFS: topLevel('gitLFS'),
  protectedSourcemaps: topLevel('protectedSourcemaps'),
  customerSupportCodeVisibility: topLevel('customerSupportCodeVisibility'),
  serverlessFunctionRegion: {
    // Newer API responses report the region under resourceConfig.functionDefaultRegions.
    read: (p) => p.serverlessFunctionRegion ?? p.resourceConfig?.functionDefaultRegions?.[0],
    write: 'patch',
  },
  productionBranch: { read: (p) => p.link?.productionBranch, write: 'productionBranch' },
};

/**
 * Vercel treats these booleans as `false` when absent, so an unset live value matches
 * a declared `false` (otherwise every deploy would "correct" `undefined` to `false`).
 */
const FALSE_WHEN_UNSET = new Set<string>([
  'enableAffectedProjectsDeployments',
  'sourceFilesOutsideRootDirectory',
  'gitForkProtection',
  'autoExposeSystemEnvs',
  'directoryListing',
  'previewDeploymentsDisabled',
  'gitLFS',
  'protectedSourcemaps',
  'customerSupportCodeVisibility',
]);

/** Compare declared settings to the live project. Undeclared fields are skipped (partial management). */
export function diffSettings(declared: VercelProjectSettings | undefined, live: LiveProject): FieldDiff[] {
  if (!declared) return [];
  const diffs: FieldDiff[] = [];
  for (const [key, spec] of Object.entries(SETTING_FIELDS) as [SettingKey, FieldSpec][]) {
    const expected = declared[key];
    if (expected === undefined) continue;
    let actual = spec.read(live);
    if (FALSE_WHEN_UNSET.has(key) && normalizeEmpty(actual) === null) actual = false;
    if (!matchesSubset(expected, actual)) diffs.push({ field: key, expected, actual: actual ?? null });
  }
  for (const [key, expected] of Object.entries(declared.additionalSettings ?? {})) {
    if (expected === undefined) continue;
    const actual = live[key];
    if (!matchesSubset(expected, actual)) diffs.push({ field: key, expected, actual: actual ?? null });
  }
  return diffs;
}

/** Build the API writes that would correct the given diffs. */
export function settingsWrites(diffs: readonly FieldDiff[]): {
  patch: Record<string, unknown> | undefined;
  productionBranch: string | undefined;
} {
  const patch: Record<string, unknown> = {};
  let productionBranch: string | undefined;
  for (const d of diffs) {
    const spec = SETTING_FIELDS[d.field as SettingKey];
    if (spec?.write === 'productionBranch') productionBranch = d.expected as string;
    else patch[d.field] = d.expected;
  }
  return { patch: Object.keys(patch).length ? patch : undefined, productionBranch };
}
