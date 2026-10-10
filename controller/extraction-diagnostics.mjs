import {extractionSchema, verifyExtraction, verifySelection} from '../app/trailbrief/src/core.js';
import {selectionSchema, SegmentSelectionError} from '../app/trailbrief/src/segments.js';

const allowedPathParts = new Set(['claims', 'questions', 'sourceId', 'quote', 'selections', 'segmentId']);
const allowedIssueCodes = new Set(['invalid_type', 'invalid_value', 'too_small', 'too_big', 'unrecognized_keys', 'invalid_format', 'custom']);
const quoteFailureMessage = 'The model returned a quotation absent from its cited source. Nothing was published.';
const pathForIssue = path => Array.isArray(path) ? path.slice(0, 8).map(part =>
  Number.isSafeInteger(part) && part >= 0 ? part : allowedPathParts.has(part) ? part : '<unknown-field>') : [];

export function diagnoseExtraction(raw, input) {
  try {
    return {ok: true, data: verifyExtraction(raw, input), stage: 'accepted', code: null, schemaIssues: []};
  } catch (error) {
    if (error?.name === 'ZodError' && Array.isArray(error.issues)) {
      return {ok: false, stage: 'schema', code: 'EXTRACTION_SCHEMA_REJECTED',
        schemaIssues: error.issues.slice(0, 16).map(issue => ({
          path: pathForIssue(issue.path),
          code: allowedIssueCodes.has(issue.code) ? issue.code : 'other_validation_issue',
        }))}; // Never retain issue messages, values, input or stack.
    }
    if (error?.message === quoteFailureMessage) {
      const parsed = extractionSchema.safeParse(raw);
      if (parsed.success && Array.isArray(input?.sources)) {
        const index = parsed.data.claims.findIndex(claim => {
          const source = input.sources.find(source => source.id === claim.sourceId);
          return !source || typeof source.text !== 'string' || !source.text.includes(claim.quote);
        });
        if (index >= 0) return {ok: false, stage: 'quotation', code: 'EXTRACTION_QUOTE_REJECTED',
          claimIndex: index, path: ['claims', index, 'quote'], schemaIssues: []};
      }
    }
    return {ok: false, stage: 'validator', code: 'EXTRACTION_VALIDATOR_PROGRAM_ERROR', schemaIssues: []};
  }
}

export function safeAssistantObservation({content, finishReason, approvedSyntheticInput, credential}) {
  const knownReasons = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);
  const reason = knownReasons.has(finishReason) ? finishReason : finishReason === null || finishReason === undefined ? null : 'unrecognized';
  const suspicious = typeof content === 'string' && (
    (typeof credential === 'string' && credential !== '' && content.includes(credential)) ||
    /sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{16,}|(?:api[_-]?key|authorization|access[_-]?token)\s*[:=]|(?:CODEX_SECRET_|NETWORK_SECRET_|secret:\/\/|proxy_secret_)/i.test(content)
  );
  const retain = approvedSyntheticInput === true && typeof content === 'string' && !suspicious;
  return {finishReason: reason, approvedSyntheticInput: approvedSyntheticInput === true,
    assistantText: retain ? content : null, assistantTextRetained: retain,
    omissionReason: retain ? null : suspicious ? 'secret_like_content' : 'non_approved_or_non_text_content',
    stage: 'response_received', schemaIssues: []};
}

export function diagnoseSelection(raw, input) {
  try {
    const data = selectionSchema.parse(raw);
    verifySelection(data, input);
    return {ok: true, data, stage: 'segment_ids_accepted', code: null, schemaIssues: []};
  } catch (error) {
    if (error?.name === 'ZodError' && Array.isArray(error.issues)) return {ok: false, stage: 'selection_schema', code: 'SEGMENT_SELECTION_SCHEMA_REJECTED',
      schemaIssues: error.issues.slice(0, 16).map(issue => ({path: pathForIssue(issue.path), code: allowedIssueCodes.has(issue.code) ? issue.code : 'other_validation_issue'}))};
    if (error instanceof SegmentSelectionError) return {ok: false, stage: Number.isSafeInteger(error.index) ? 'segment_ids' : 'source_segments', code: error.code,
      path: Number.isSafeInteger(error.index) ? ['selections', error.index, 'segmentId'] : null, schemaIssues: []};
    return {ok: false, stage: 'validator', code: 'SEGMENT_VALIDATOR_PROGRAM_ERROR', schemaIssues: []};
  }
}
