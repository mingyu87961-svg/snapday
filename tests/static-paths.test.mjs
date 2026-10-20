import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import vm from 'node:vm';

const dist = new URL('../dist/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');
const app = await readFile(new URL('app.mjs', dist), 'utf8');

test('HTML entry assets stay inside the deployment folder at root and project subpath', async () => {
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)]
    .map(match => match[1]).filter(value => !value.startsWith('#'));
  assert.ok(references.includes('./app.mjs'));
  assert.ok(references.includes('./styles.css'));
  for (const page of ['http://localhost:4173/', 'https://owner.github.io/snapday/']) {
    for (const reference of references) {
      assert.ok(!reference.startsWith('/'), `Resource escapes deployment folder: ${reference}`);
      const resolved = new URL(reference, page);
      assert.ok(resolved.href.startsWith(page));
      const info = await stat(new URL(resolved.href.slice(page.length), dist));
      assert.ok(info.isFile(), `Referenced asset exists: ${reference}`);
    }
  }
});

// Execute the actual application wiring with a minimal DOM, without a browser
// or OCR engine. Only module loading is adapted so import.meta has a test URL.
function bootApp(moduleURL) {
  const elements = new Map();
  const samples = ['photo', 'camp', 'lecture'].map(example => ({ dataset: { example } }));
  const scripts = [];
  const workerOptions = [];
  const loadedImages = [];
  const node = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: selector === '#timeline-filter' ? 'all' : '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, append() {},
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    URL, Intl, Date, console,
    // A different document URL proves resource paths use their module's base.
    location: { href: 'https://unrelated.invalid/other/page.html' },
    localStorage: { getItem: () => null },
    window: { addEventListener() {} },
    document: {
      querySelector: node,
      querySelectorAll: selector => selector === '[data-example]' ? samples : [],
      addEventListener() {},
      createElement: tag => ({ tag, remove() {} }),
      head: { append(script) {
        scripts.push(script.src);
        context.Tesseract = { async createWorker(languages, mode, options) {
          workerOptions.push({ languages, mode, ...options });
          return { terminate: async () => {} };
        } };
        script.onload();
      } },
    },
  });
  const executable = app.replace(/^import .* from .*;\r?\n/, '')
    .replaceAll('import.meta.url', JSON.stringify(moduleURL));
  vm.runInContext(executable, context, { filename: 'app.mjs' });
  context.rasterize = async src => { loadedImages.push(src); return 'data:image/png;base64,AA=='; };
  return { context, samples, scripts, workerOptions, loadedImages };
}

for (const base of ['http://localhost:4173/', 'https://owner.github.io/snapday/']) {
  test(`OCR and sample actions load complete local assets under ${base}`, async () => {
    const { context, samples, scripts, workerOptions, loadedImages } = bootApp(`${base}app.mjs`);
    await context.getWorker(0);
    assert.deepEqual(scripts, [`${base}vendor/tesseract.min.js`]);
    assert.equal(workerOptions.length, 1);
    const options = workerOptions[0];
    assert.deepEqual(Array.from(options.languages), ['chi_sim', 'eng']);
    assert.equal(options.workerPath, `${base}vendor/worker.min.js`);
    assert.equal(options.corePath, `${base}vendor/`);
    assert.equal(options.langPath, `${base}vendor`);
    assert.equal(options.workerBlobURL, false);
    for (const sample of samples) await sample.onclick();
    assert.deepEqual(loadedImages, samples.map(({ dataset }) => `${base}assets/${dataset.example}.svg`));

    // Check files that Tesseract may choose at runtime, including SIMD fallback.
    const runtimeURLs = [
      ...scripts, options.workerPath, ...loadedImages,
      ...['chi_sim', 'eng'].map(language => `${options.langPath}/${language}.traineddata.gz`),
      ...['', '-lstm', '-simd', '-simd-lstm'].flatMap(variant =>
        ['.wasm.js', '.wasm'].map(extension => `${options.corePath}tesseract-core${variant}${extension}`)),
    ];
    for (const resource of runtimeURLs) {
      assert.ok(resource.startsWith(base), `Runtime resource stays in deployment: ${resource}`);
      const info = await stat(new URL(resource.slice(base.length), dist));
      assert.ok(info.isFile() && info.size > 10, `Runtime asset is packaged: ${resource}`);
    }
  });
}
