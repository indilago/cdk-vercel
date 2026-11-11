// Bundles the custom resource handler into assets/handler/index.js so consumers don't
// need esbuild or Docker. The AWS SDK v3 ships with the Lambda Node.js runtime.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/handler/index.ts'],
  outfile: 'assets/handler/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['@aws-sdk/*'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('bundled assets/handler/index.js');
