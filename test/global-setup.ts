import { execFileSync } from 'node:child_process';

/** The construct tests synthesize the handler asset, so make sure it is bundled. */
export default function setup(): void {
  execFileSync(process.execPath, ['scripts/bundle-handler.mjs'], { stdio: 'inherit' });
}
