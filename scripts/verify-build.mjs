import { readFile, stat } from 'node:fs/promises';

// This static build is independent of a hosting provider or project account.
const root = new URL('../', import.meta.url);
const paths = [
  'dist/index.html', 'dist/styles.css', 'dist/app.mjs', 'dist/lib/engine.mjs', 'dist/lib/api-client.mjs',
  'dist/assets/favicon.svg', 'dist/assets/photo.svg', 'dist/assets/camp.svg', 'dist/assets/lecture.svg',
  'dist/vendor/tesseract.min.js', 'dist/vendor/worker.min.js',
  'dist/vendor/tesseract-core.wasm.js', 'dist/vendor/tesseract-core.wasm',
  'dist/vendor/tesseract-core-lstm.wasm.js', 'dist/vendor/tesseract-core-lstm.wasm',
  'dist/vendor/tesseract-core-simd.wasm.js', 'dist/vendor/tesseract-core-simd.wasm',
  'dist/vendor/tesseract-core-simd-lstm.wasm.js', 'dist/vendor/tesseract-core-simd-lstm.wasm',
  'dist/vendor/chi_sim.traineddata.gz', 'dist/vendor/eng.traineddata.gz',
  'dist/vendor/TESSERACT-LICENSE.txt', 'dist/vendor/TESSERACT-CORE-LICENSE.txt',
  'dist/vendor/TESSDATA-LICENSE.txt', 'dist/vendor/THIRD-PARTY.md',
];
for (const file of paths) {
  const info = await stat(new URL(file, root));
  if (!info.isFile() || info.size < 10) throw new Error(`Missing or empty: ${file}`);
}
const html = await readFile(new URL('dist/index.html', root), 'utf8');
if (!/<script\b[^>]*type="module"[^>]*src="\.\/app\.mjs"/.test(html)) {
  throw new Error('Relative application module is missing');
}
for (const [, attribute, value] of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
  if (value.startsWith('/')) throw new Error(`Root-absolute ${attribute} breaks subpath hosting: ${value}`);
}
await stat(new URL('dist/.nojekyll', root));
console.log(`Verified ${paths.length} application assets and static hosting entry point.`);
