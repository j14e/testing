// Builds the unpacked extension into dist/ (load it from chrome://extensions).
//
//   node build.mjs [--outdir dist] [--model-id org/name] [--models-dir models] [--local-only]
//
// Model files are hard-linked (not copied) from <models-dir>/<model-id>/ into
// <outdir>/models/, so rebuilding doesn't duplicate hundreds of MB.

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

function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) linkTree(a, b);
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
