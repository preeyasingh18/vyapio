import { build } from 'esbuild';
import { rm, mkdir, writeFile } from 'node:fs/promises';

/**
 * Bundles the Lambda handler.
 *
 * Bundling rather than shipping node_modules keeps the image small and cold
 * starts short: one file, tree-shaken, with the AWS SDK included. The SDK is
 * deliberately NOT marked external — the Node base image ships v2, and relying
 * on a runtime-provided version is how you get a working local build and a
 * broken deploy.
 */

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

const result = await build({
  entryPoints: ['src/handler.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/handler.mjs',
  sourcemap: true,
  minify: true,
  // esbuild cannot always resolve `require` inside ESM output for transitive
  // CJS deps; this shim restores it.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = new URL(import.meta.url).pathname;',
      "const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));",
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: true,
});

// Lambda resolves `handler.handler`; a package.json marks the output as ESM.
await writeFile('dist/package.json', JSON.stringify({ type: 'module' }, null, 2));

const bytes = Object.values(result.metafile.outputs).reduce(
  (total, output) => total + output.bytes,
  0,
);
console.log(`\nBundle: ${(bytes / 1024 / 1024).toFixed(2)} MB → dist/handler.mjs`);
