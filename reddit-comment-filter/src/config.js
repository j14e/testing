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

  // Labels that count as the "flagged" class. The pill next to the username
  // reads "<label>" or "Not <label>" (e.g. "AI" / "Not AI").
  flagLabelPattern: /\b(ai|fake|machine|generated|artificial|llm|gpt|chatgpt|bot|synthetic|toxic)\b|^label_1$/i,
  // Name of the flagged class for models with a single output (a sigmoid
  // score, like Vanguard), whose config names no labels.
  singleOutputLabel: 'AI',
  // Pill colour bands for the flagged-class probability: green below midScore,
  // yellow from midScore, red from highScore. midScore is also the AI/Not AI cut.
  highScore: 0.8,
  midScore: 0.5,
  // Collapse the thread when the AI score is above this (0.3 = 30%); null
  // turns it off. The pill toggles it either way.
  collapseAbove: 0.3,
};
