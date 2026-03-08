import { build } from 'esbuild';

await build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/bundle.js',
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  external: [
    'bufferutil',
    'utf-8-validate',
    'zlib-sync',
    '@discordjs/erlpack',
    'sharp',
  ],
  treeShaking: true,
});

console.log('Bundle created: dist/bundle.js');
