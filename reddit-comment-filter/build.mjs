// Builds the unpacked extension into dist/ (load it from chrome://extensions).
//
//   node build.mjs [--outdir dist] [--model-id org/name] [--models-dir models] [--local-only] [--split-mb 95]
//
// Model files are hard-linked (not copied) from <models-dir>/<model-id>/ into
// <outdir>/models/, so rebuilding doesn't duplicate hundreds of MB. Files
// larger than --split-mb are written as <file>.partNN pieces plus
// <file>.parts.json instead, so the built extension fits in a Git repository
// (GitHub rejects files over 100 MB); the offscreen document joins them.

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.dirname(new URL(import.meta.url).pathname);
const { values: opts } = parseArgs({
  options: {
    outdir: { type: 'string', default: 'dist' },
    'model-id': { type: 'string', default: process.env.RCF_MODEL_ID || '' },
    'models-dir': { type: 'string', default: 'models' },
    'local-only': { type: 'boolean', default: process.env.RCF_LOCAL_ONLY === '1' },
    'split-mb': { type: 'string', default: '95' },
  },
});
const outdir = path.resolve(root, opts.outdir);
const src = path.join(root, 'src');

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  target: 'chrome116',
  logLevel: 'warning',
  define: {
    'process.env.RCF_MODEL_ID': JSON.stringify(opts['model-id']),
    'process.env.RCF_LOCAL_ONLY': JSON.stringify(opts['local-only'] ? '1' : ''),
  },
};

await Promise.all([
  esbuild.build({ ...common, entryPoints: [path.join(src, 'content/index.js')], outfile: path.join(outdir, 'content.js'), format: 'iife' }),
  esbuild.build({ ...common, entryPoints: [path.join(src, 'background.js')], outfile: path.join(outdir, 'background.js'), format: 'esm' }),
  esbuild.build({
    ...common,
    entryPoints: [path.join(src, 'offscreen.js')],
    outfile: path.join(outdir, 'offscreen.js'),
    format: 'esm',
    // Use ONNX Runtime's build that loads its WASM glue from wasmPaths (the
    // files copied below) rather than the variant with the glue inlined.
    conditions: ['onnxruntime-web-use-extern-wasm'],
  }),
]);

for (const file of ['manifest.json', 'offscreen.html', 'content.css']) {
  fs.copyFileSync(path.join(src, file), path.join(outdir, file));
}

// ONNX Runtime WASM + JS glue, from the exact onnxruntime-web transformers.js uses.
const require = createRequire(import.meta.url);
const requireFromTransformers = createRequire(require.resolve('@huggingface/transformers'));
const ortDist = path.dirname(requireFromTransformers.resolve('onnxruntime-web/webgpu'));
fs.mkdirSync(path.join(outdir, 'ort'));
for (const ext of ['mjs', 'wasm']) {
  const name = `ort-wasm-simd-threaded.asyncify.${ext}`;
  fs.copyFileSync(path.join(ortDist, name), path.join(outdir, 'ort', name));
}

const splitBytes = Math.round(Number(opts['split-mb']) * 1024 * 1024);

function splitFile(a, b) {
  const size = fs.statSync(a).size;
  const fd = fs.openSync(a, 'r');
  const parts = [];
  for (let off = 0, i = 0; off < size; off += splitBytes, i++) {
    const len = Math.min(splitBytes, size - off);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    const name = `${path.basename(b)}.part${String(i).padStart(2, '0')}`;
    fs.writeFileSync(path.join(path.dirname(b), name), buf);
    parts.push(name);
  }
  fs.closeSync(fd);
  fs.writeFileSync(`${b}.parts.json`, JSON.stringify({ size, parts }));
}

function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) linkTree(a, b);
    else if (entry.name.endsWith('.onnx') && fs.statSync(a).size > splitBytes) splitFile(a, b);
    else {
      try {
        fs.linkSync(a, b);
      } catch {
        fs.copyFileSync(a, b);
      }
    }
  }
}

const { CONFIG } = await import(`data:text/javascript,${encodeURIComponent(
  // Evaluate config.js with the same overrides the bundle gets.
  `const process = { env: { RCF_MODEL_ID: ${JSON.stringify(opts['model-id'])} } };\n` +
    fs.readFileSync(path.join(src, 'config.js'), 'utf8'),
)}`);
const modelSrc = path.resolve(root, opts['models-dir'], CONFIG.modelId);
if (fs.existsSync(modelSrc)) {
  linkTree(modelSrc, path.join(outdir, 'models', CONFIG.modelId));
  console.log(`bundled model ${CONFIG.modelId} from ${path.relative(root, modelSrc)}`);
} else {
  console.warn(
    `no model files at ${path.relative(root, modelSrc)}: run scripts/prepare_model.py` +
      (opts['local-only'] ? ' (built --local-only, so the extension will not work without them)' : ' (the extension will download it from the Hub on first use)'),
  );
}
console.log(`built ${path.relative(root, outdir)}/`);
