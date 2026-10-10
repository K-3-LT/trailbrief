export function candidatePrompt(original) {
  const oldValue = '"sourceId":"route or weather"';
  if (!original.includes(oldValue)) throw Error('EXPECTED_PROMPT_PATTERN_MISSING');
  return original.replace(oldValue, '"sourceId":"route"') +
    ' Contract: claims must contain 1 to 8 objects. sourceId must be exactly route or weather, choosing the ID of the cited input source; never emit the literal string route or weather. Each quote must contain 1 to 1000 characters copied exactly and contiguously from that source, including punctuation and whitespace; do not normalize, paraphrase, concatenate passages or copy the example placeholder. questions must be an array of 0 to 6 strings, each 1 to 300 characters. Both claims and questions are required.';
}
