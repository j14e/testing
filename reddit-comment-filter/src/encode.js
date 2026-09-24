// Tokenize for the classifier the way the Python tokenizer does.
//
// transformers.js 4.3 truncates *after* adding special tokens, so any text
// longer than the model's window loses RoBERTa's closing </s> (Python keeps
// it, and the model was trained with it): a 480-word post scored 0.512
// instead of 0.476. So we cut the text's own tokens and keep the template.

import { Tensor } from '@huggingface/transformers';

function template(tokenizer) {
  // Special tokens around a single sequence, e.g. [<s>] text [</s>].
  const empty = tokenizer.encode('');
  const probe = tokenizer.encode('a');
  const lead = probe.indexOf(tokenizer.encode('a', { add_special_tokens: false })[0]);
  return { prefix: empty.slice(0, lead), suffix: empty.slice(lead) };
}

// Returns {input_ids, attention_mask} int64 tensors, right-padded to the
// longest row. Each row is prefix + first N text tokens + suffix.
export function encodeBatch(tokenizer, texts, maxLength = tokenizer.model_max_length) {
  const { prefix, suffix } = template(tokenizer);
  const room = maxLength - prefix.length - suffix.length;
  const rows = texts.map((text) => [
    ...prefix,
    ...tokenizer.encode(text, { add_special_tokens: false }).slice(0, room),
    ...suffix,
  ]);
  const width = Math.max(...rows.map((r) => r.length));
  const ids = new BigInt64Array(rows.length * width).fill(BigInt(tokenizer.pad_token_id ?? 0));
  const mask = new BigInt64Array(rows.length * width);
  rows.forEach((row, i) =>
    row.forEach((id, j) => {
      ids[i * width + j] = BigInt(id);
      mask[i * width + j] = 1n;
    }),
  );
  return {
    input_ids: new Tensor('int64', ids, [rows.length, width]),
    attention_mask: new Tensor('int64', mask, [rows.length, width]),
  };
}
