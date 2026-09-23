// Shared settings for the content script, service worker and offscreen document.
// build.mjs can override the model with RCF_MODEL_ID / RCF_LOCAL_ONLY.

export const CONFIG = {
  // Any RoBERTa-family (roberta / xlm-roberta) text-classification repo with
  // ONNX weights. scripts/prepare_model.py bundles it into dist/models/<id>/.
  modelId: process.env.RCF_MODEL_ID || 'fakespot-ai/roberta-base-ai-text-detection-v1',
  // When the bundled files are missing, fetch them from the Hub once and keep
  // them in the Cache API. Inference is local either way.
  allowRemoteModels: process.env.RCF_LOCAL_ONLY !== '1',

  // Only posts/comments with MORE than this many words are classified.
  minWords: 50,
  // "Near the viewport": how far outside the visible area an item may be and
  // still get classified. Items further away wait until you scroll closer.
  rootMargin: '600px 0px 600px 0px',
  batchSize: 8,
  // The model only sees 512 tokens; don't ship megabytes of text to it.
  maxChars: 4000,

  // Labels that count as the "flagged" class. The badge shows this class's
  // probability, e.g. "AI 87%".
  flagLabelPattern: /\b(ai|fake|machine|generated|artificial|llm|gpt|chatgpt|bot|synthetic|toxic)\b|^label_1$/i,
  // Badge colour bands for the flagged-class probability.
  highScore: 0.8,
  midScore: 0.5,
  // Hide items at or above this score automatically (null = only when the badge
  // is clicked).
  autoBlockThreshold: null,
};
