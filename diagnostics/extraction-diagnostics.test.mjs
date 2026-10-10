import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractionSchema, verifyExtraction, modelExtract} from '../app/trailbrief/src/core.js';
import {diagnoseExtraction, safeAssistantObservation} from '../controller/extraction-diagnostics.mjs';
import {selectionSchema, SEGMENT_SYSTEM_PROMPT} from '../app/trailbrief/src/segments.js';
import {candidatePrompt} from './prompt-candidate.mjs';
const cases = JSON.parse(await readFile(new URL('../controller/cases.json', import.meta.url), 'utf8'));
const input = cases[0].input;
const valid = () => ({claims: cases[0].requiredQuotes.map(item => ({sourceId: item.sourceId, quote: item.text})), questions: ['Have you checked actual official sources?']});

test('diagnostic wrapper preserves valid extraction without altering citations', () => {
  const raw = valid(); const checked = diagnoseExtraction(raw, input);
  assert.equal(checked.ok, true); assert.deepEqual(checked.data, verifyExtraction(raw, input));
});
test('live prompt uses only segment IDs; historical quote prompt enum failure remains demonstrable', async () => {
  let original;
  await modelExtract(input, {env: {TRAILBRIEF_API_BASE: 'https://api.iteracompute.com/v1', TRAILBRIEF_MODEL: 'deepseek/deepseek-v4.1-flash'}, fetchFn: async (_, options) => {
    original = JSON.parse(options.body).messages[0].content;
    return {ok: true, json: async () => ({choices: [{message: {content: JSON.stringify(valid())}}]})};
  }});
  const example = prompt => JSON.parse(prompt.match(/Return ONLY JSON (.*?)\. Select up to/s)[1]);
  assert.equal(original,SEGMENT_SYSTEM_PROMPT);
  assert.equal(selectionSchema.safeParse(JSON.parse(original.match(/Return ONLY JSON (.*?)\. Choose/s)[1])).success,true);
  const oldPrompt = await readFile(new URL('./original-system-prompt.txt', import.meta.url), 'utf8');
  const before = extractionSchema.safeParse(example(oldPrompt));
  assert.equal(before.success, false); assert.deepEqual(before.error.issues[0].path, ['claims', 0, 'sourceId']);
  assert.equal(extractionSchema.safeParse(example(candidatePrompt(oldPrompt))).success, true);
  const badResponse = valid(); badResponse.claims[0].sourceId = 'route or weather';
  assert.equal(diagnoseExtraction(badResponse, input).code, 'EXTRACTION_SCHEMA_REJECTED'); // No response remapping.
});
test('schema path distinguishes missing fields, enum errors and length limits', () => {
  const missing = valid(); delete missing.questions;
  assert.deepEqual(diagnoseExtraction(missing, input).schemaIssues[0].path, ['questions']);
  const long = valid(); long.questions = ['x'.repeat(301)];
  assert.deepEqual(diagnoseExtraction(long, input).schemaIssues[0].path, ['questions', 0]);
  const many = valid(); many.claims = Array.from({length: 9}, () => valid().claims[0]);
  assert.equal(diagnoseExtraction(many, input).code, 'EXTRACTION_SCHEMA_REJECTED');
});
test('paraphrase, wrong source and whitespace substitutions remain rejected', () => {
  for (const change of [
    raw => {raw.claims[0].quote = 'The northern bridge is unavailable.';},
    raw => {raw.claims[0].sourceId = 'weather';},
    raw => {raw.claims[0].quote = 'The north\u00a0footbridge is closed';},
  ]) {
    const raw = valid(); change(raw);
    assert.throws(() => verifyExtraction(raw, input));
    const diagnostic = diagnoseExtraction(raw, input);
    assert.equal(diagnostic.code, 'EXTRACTION_QUOTE_REJECTED');
    assert.deepEqual(diagnostic.path, ['claims', 0, 'quote']);
  }
});
test('malformed validator input is a program error, not attributed to model contract', () => {
  assert.equal(diagnoseExtraction(valid(), {sources: null}).code, 'EXTRACTION_VALIDATOR_PROGRAM_ERROR');
});
test('schema issues never retain untrusted values or error messages', () => {
  const raw = valid(); raw.claims[0].sourceId = 'UNTRUSTED_VALUE_MUST_NOT_ENTER_ISSUES';
  const diagnostic = diagnoseExtraction(raw, input);
  assert(!JSON.stringify(diagnostic).includes(raw.claims[0].sourceId));
  assert(!JSON.stringify(diagnostic).includes('message'));
});
test('assistant observation keeps only approved synthetic content and known finish reasons', () => {
  const content = JSON.stringify(valid());
  const kept = safeAssistantObservation({content, finishReason: 'stop', approvedSyntheticInput: true});
  assert.equal(kept.assistantText, content); assert.equal(kept.finishReason, 'stop');
  const omitted = safeAssistantObservation({content, finishReason: 'arbitrary-provider-value', approvedSyntheticInput: false});
  assert.equal(omitted.assistantText, null); assert.equal(omitted.finishReason, 'unrecognized');
});
test('credential-like content is omitted without storing a value or fragment', () => {
  const synthetic = 'synthetic-sensitive-observation';
  const omitted = safeAssistantObservation({content: synthetic, finishReason: 'stop', approvedSyntheticInput: true, credential: synthetic});
  assert.equal(omitted.assistantText, null); assert.equal(omitted.omissionReason, 'secret_like_content');
  assert(!JSON.stringify(omitted).includes(synthetic));
});
