/* eslint-disable @typescript-eslint/no-require-imports -- Node test harness uses CommonJS to inject boundary mocks. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Run production TypeScript with boundary mocks; no live platform writes.
exports.loadSource = function loadSource(entry, mocks = {}, cache = new Map()) {
  const filename = path.resolve(entry);
  if (cache.has(filename)) return cache.get(filename).exports;
  const moduleRecord = { exports: {} };
  cache.set(filename, moduleRecord);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const localRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith('.') || id.startsWith('@/')) {
      const base = id.startsWith('@/') ? path.resolve('src', id.slice(2)) : path.resolve(path.dirname(filename), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      return loadSource(resolved, mocks, cache);
    }
    return require(id);
  };
  new Function('require', 'module', 'exports', code)(localRequire, moduleRecord, moduleRecord.exports);
  return moduleRecord.exports;
};
