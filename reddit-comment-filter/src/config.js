// Shared settings for the content script, service worker and offscreen document.
// build.mjs can override the model with RCF_MODEL_ID / RCF_LOCAL_ONLY.

export const CONFIG = {
  // A Hugging Face text-classification repo (RoBERTa, ModernBERT, DeBERTa-v2
  // and other transformers.js-supported encoders). scripts/prepare_model.py
  // bundles it into dist/models/<id>/. Vanguard: ModernBERT-large, one output
  // = P(AI); see the README for how it compared with other detectors.
  modelId: process.env.RCF_MODEL_ID || 'ShantanuT01/vanguard-ai-text-detector',
  // When the bundled files are missing, fetch them from the Hub once and keep
  // them in the Cache API. Inference is local either way.
  allowRemoteModels: process.env.RCF_LOCAL_ONLY !== '1',

  // Only posts/comments with MORE than this many words are classified.
  minWords: 50,
  // "Near the viewport": how far outside the visible area an item may be and
  // still get classified. Items further away wait until you scroll closer.
  rootMargin: '600px 0px 600px 0px',
  batchSize: 8,
  // Tokens the model reads per text (the window the detectors were compared
  // at), and a cap on the characters sent to the model host.
  maxTokens: 512,
  maxChars: 4000,

  // Labels that count as the model's "AI" class, and the name of that class
  // for models with a single output (a sigmoid score, like Vanguard), whose
  // config names no labels.
  flagLabelPattern: /\b(ai|fake|machine|generated|artificial|llm|gpt|chatgpt|bot|synthetic|toxic)\b|^label_1$/i,
  singleOutputLabel: 'AI',

  // The pill next to the username, by the AI probability: "Human" (green) up
  // to flagAbove, "Maybe AI" (yellow) above it, "AI" (red) from aiAt.
  flagAbove: 0.3,
  aiAt: 0.7,
  pillText: { low: 'Human', medium: 'Maybe AI', high: 'AI' },
  // Collapse flagged threads (above flagAbove) when they're scored. The pill
  // toggles it either way.
  collapseFlagged: true,
};
