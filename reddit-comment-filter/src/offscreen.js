// Offscreen document: loads the RoBERTa classifier with transformers.js and
// answers {target: 'offscreen', type: 'classify'} messages from content scripts.
// Runs here rather than in the service worker because ONNX Runtime's WASM
// backend needs dynamic import() (banned in service workers) and the model
// must outlive the worker's 30 s idle shutdown.

import { env, pipeline } from '@huggingface/transformers';
import { CONFIG } from './config.js';

const DEVICE_PREF = new URLSearchParams(location.search).get('device') || 'auto';
const ORT_DIR = chrome.runtime.getURL('ort/');
const MODEL_FILES = { fp32: 'model.onnx', fp16: 'model_fp16.onnx', q8: 'model_quantized.onnx' };

env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
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
  try {
    return (await fetch(url, { method: 'HEAD' })).ok;
  } catch {
    return false; // missing extension resources reject rather than 404
  }
}

// Ordered (device, dtype) pairs to try: WebGPU fp16 > WebGPU fp32 > WASM int8.
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
  if (DEVICE_PREF !== 'webgpu') wanted.push({ device: 'wasm', dtype: 'q8' });

  const bundled = [];
  for (const c of wanted) if (await isBundled(c.dtype)) bundled.push(c);
  if (bundled.length) return { candidates: bundled, bundled: true };
  // Nothing packaged: download from the Hub, but never the ~500 MB fp32 graph.
  return {
    candidates: CONFIG.allowRemoteModels ? wanted.filter((c) => c.dtype !== 'fp32') : [],
    bundled: false,
  };
}

function flaggedLabels(id2label) {
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
      await clf('warm up', { top_k: null });
      Object.assign(status, {
        state: 'ready',
        modelClass: clf.model.constructor.name, // e.g. RobertaForSequenceClassification
        device,
        dtype,
        loadMs: Math.round(performance.now() - t0),
      });
      console.info(`[rcf] ${CONFIG.modelId} (${status.modelClass}) ready on ${device}/${dtype} in ${status.loadMs} ms`);
      return { clf, device, dtype, flagged: flaggedLabels(clf.model.config.id2label) };
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

async function classify(texts) {
  const engine = await getEngine();
  const outputs = await engine.clf(texts, { top_k: null });
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
