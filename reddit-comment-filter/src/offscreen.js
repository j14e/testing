// Offscreen document: loads the RoBERTa classifier with transformers.js and
// answers {target: 'offscreen', type: 'classify'} messages from content scripts.
// Runs here rather than in the service worker because ONNX Runtime's WASM
// backend needs dynamic import() (banned in service workers) and the model
// must outlive the worker's 30 s idle shutdown.

import { env, pipeline } from '@huggingface/transformers';
import { CONFIG } from './config.js';
import { encodeBatch } from './encode.js';

const DEVICE_PREF = new URLSearchParams(location.search).get('device') || 'auto';
const ORT_DIR = chrome.runtime.getURL('ort/');
const MODEL_FILES = { fp32: 'model.onnx', fp16: 'model_fp16.onnx', q8: 'model_quantized.onnx' };

env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');

// build.mjs splits model files over GitHub's 100 MB limit into
// <file>.part00, .part01, ... plus <file>.parts.json. Serve such a file by
// streaming its parts back to back, so the rest of the code sees one file.
const baseFetch = env.fetch;
async function partsManifest(url) {
  try {
    const res = await baseFetch(`${url}.parts.json`);
    return res.ok ? await res.json() : null;
  } catch {
    return null; // missing extension resources reject rather than 404
  }
}
env.fetch = async (input, init) => {
  const url = String(input);
  const manifest = url.startsWith(env.localModelPath) && url.endsWith('.onnx') ? await partsManifest(url) : null;
  if (!manifest) return baseFetch(input, init);
  const dir = url.slice(0, url.lastIndexOf('/') + 1);
  let next = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (next === manifest.parts.length) return controller.close();
      const res = await baseFetch(dir + manifest.parts[next++]);
      controller.enqueue(new Uint8Array(await res.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { 'content-length': String(manifest.size) } });
};
env.allowRemoteModels = CONFIG.allowRemoteModels;
// ONNX Runtime ships inside the extension (MV3 forbids remote code), so point
// it at the packaged files instead of the default CDN.
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${ORT_DIR}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${ORT_DIR}ort-wasm-simd-threaded.asyncify.wasm`,
};
// Threads need SharedArrayBuffer, which the manifest's COOP/COEP headers enable.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

const status = {
  state: 'loading',
  modelId: CONFIG.modelId,
  devicePref: DEVICE_PREF,
  modelClass: null,
  device: null,
  dtype: null,
  loadMs: null,
  error: null,
  attempts: [],
  crossOriginIsolated: self.crossOriginIsolated,
  numThreads: env.backends.onnx.wasm.numThreads,
  classified: 0,
};

async function isBundled(dtype) {
  const url = `${env.localModelPath}${CONFIG.modelId}/onnx/${MODEL_FILES[dtype]}`;
  if (await partsManifest(url)) return true;
  try {
    return (await fetch(url, { method: 'HEAD' })).ok;
  } catch {
    return false; // missing extension resources reject rather than 404
  }
}

// Ordered (device, dtype) pairs to try. fp16 comes first on both backends:
// WASM runs the fp16 graph about as fast as fp32 and within ~0.002 of it,
// while int8 (q8) is ~2x faster but moved real Reddit comments' scores by up
// to 0.58 for this detector, so it is only a last resort.
async function backendCandidates() {
  const wanted = [];
  if (DEVICE_PREF !== 'wasm') {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    if (adapter) {
      if (adapter.features.has('shader-f16')) wanted.push({ device: 'webgpu', dtype: 'fp16' });
      wanted.push({ device: 'webgpu', dtype: 'fp32' });
    } else {
      status.attempts.push('webgpu: no adapter');
    }
  }
  if (DEVICE_PREF !== 'webgpu') {
    wanted.push({ device: 'wasm', dtype: 'fp16' }, { device: 'wasm', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' });
  }

  const bundled = [];
  for (const c of wanted) if (await isBundled(c.dtype)) bundled.push(c);
  if (bundled.length) return { candidates: bundled, bundled: true };
  // Nothing packaged: download the fp16 graph from the Hub (never the ~500 MB fp32 one).
  return {
    candidates: CONFIG.allowRemoteModels ? wanted.filter((c) => c.dtype === 'fp16') : [],
    bundled: false,
  };
}

function flaggedLabels(id2label, outputs) {
  if (outputs === 1) return [CONFIG.singleOutputLabel];
  const labels = Object.values(id2label ?? {});
  const hits = labels.filter((l) => CONFIG.flagLabelPattern.test(l));
  // Unnamed binary heads (LABEL_0 / LABEL_1): class 1 is the positive class.
  return hits.length ? hits : [id2label?.[1] ?? labels[0]];
}

async function loadEngine() {
  const { candidates, bundled } = await backendCandidates();
  if (!candidates.length) {
    throw new Error(
      `No model files for ${CONFIG.modelId} in the extension (run scripts/prepare_model.py)` +
        (DEVICE_PREF === 'auto' ? '' : ` or no ${DEVICE_PREF} support`),
    );
  }
  for (const { device, dtype } of candidates) {
    const t0 = performance.now();
    let clf;
    try {
      clf = await pipeline('text-classification', CONFIG.modelId, { device, dtype });
      // First run compiles WebGPU shaders / surfaces unsupported kernels, so a
      // backend only counts as working once it has produced an output.
      const [warm] = await scoreBatch(clf, ['warm up']);
      // A backend that runs but returns NaN (e.g. fp16 overflow in a GPU
      // kernel) must count as failed, not score every comment as garbage.
      if (!warm.every((s) => Number.isFinite(s.score))) throw new Error('non-finite output');
      Object.assign(status, {
        state: 'ready',
        modelClass: clf.model.constructor.name, // e.g. RobertaForSequenceClassification
        device,
        dtype,
        loadMs: Math.round(performance.now() - t0),
      });
      console.info(`[rcf] ${CONFIG.modelId} (${status.modelClass}) ready on ${device}/${dtype} in ${status.loadMs} ms`);
      return { clf, device, dtype, flagged: flaggedLabels(clf.model.config.id2label, warm.length) };
    } catch (err) {
      status.attempts.push(`${device}/${dtype}: ${err?.message || err}`);
      console.warn(`[rcf] ${device}/${dtype} failed`, err);
      await clf?.dispose?.().catch(() => {});
    }
  }
  const hint = bundled ? '' : '\nNo model files are bundled: run scripts/prepare_model.py and rebuild.';
  throw new Error(`Model failed on every backend:\n${status.attempts.join('\n')}${hint}`);
}

let enginePromise = null;
function getEngine() {
  enginePromise ??= loadEngine().catch((err) => {
    Object.assign(status, { state: 'error', error: String(err?.message || err) });
    throw err;
  });
  return enginePromise;
}

// [{label, score}] per text, highest first. Uses the pipeline's tokenizer and
// model but our own encoding (see encode.js) instead of calling the pipeline.
async function scoreBatch(clf, texts) {
  const { config } = clf.model;
  let { logits } = await clf.model(encodeBatch(clf.tokenizer, texts, CONFIG.maxTokens));
  logits = logits.to('float32');
  const [rows, classes] = logits.dims;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const z = Array.from(logits.data.subarray(i * classes, (i + 1) * classes));
    let p;
    if (classes === 1) {
      // One output (e.g. Vanguard): a logit for the flagged class.
      out.push([{ label: CONFIG.singleOutputLabel, score: 1 / (1 + Math.exp(-z[0])) }]);
      continue;
    }
    if (config.problem_type === 'multi_label_classification') {
      p = z.map((v) => 1 / (1 + Math.exp(-v)));
    } else {
      const max = Math.max(...z);
      const e = z.map((v) => Math.exp(v - max));
      const sum = e.reduce((a, b) => a + b);
      p = e.map((v) => v / sum);
    }
    out.push(p.map((score, k) => ({ label: config.id2label?.[k] ?? `LABEL_${k}`, score })).sort((a, b) => b.score - a.score));
  }
  return out;
}

async function classify(texts) {
  const engine = await getEngine();
  let outputs;
  if (engine.dtype === 'q8') {
    // int8 models quantize activations with one scale per batch, so padding
    // and the other texts would shift each score. On CPU, batching buys little
    // anyway: run one text at a time.
    outputs = [];
    for (const text of texts) outputs.push(...(await scoreBatch(engine.clf, [text])));
  } else {
    outputs = await scoreBatch(engine.clf, texts);
  }
  status.classified += texts.length;
  return outputs.map((scores) => {
    const best = scores
      .filter((s) => engine.flagged.includes(s.label))
      .reduce((a, b) => (b.score > a.score ? b : a));
    return { label: best.label, score: best.score, scores };
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'classify') {
    classify(msg.texts).then(
      (results) => sendResponse({ results, device: status.device, dtype: status.dtype, modelId: CONFIG.modelId }),
      (err) => sendResponse({ error: String(err?.message || err) }),
    );
    return true;
  }
  if (msg.type === 'status') sendResponse(status);
});

// Start loading right away so the model is warm by the time text arrives.
getEngine().catch(() => {});
