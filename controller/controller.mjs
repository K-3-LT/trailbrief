import {constants} from 'node:fs';
import {mkdir, open, readFile, rename, rm, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {modelExtract, normalizeInput} from '../app/trailbrief/src/core.js';
import {buildSourceSegments, EVIDENCE_CONTRACT_VERSION, SEGMENT_PROMPT_VERSION, SEGMENT_SYSTEM_PROMPT} from '../app/trailbrief/src/segments.js';
import {runBrief} from '../app/trailbrief/src/workflow.js';
import {diagnoseSelection, safeAssistantObservation} from './extraction-diagnostics.mjs';

export const POLICY = Object.freeze({
  roundId: 'trailbrief-20261010-approved-round',
  outputPolicyVersion: 2,
  evidenceContractVersion: EVIDENCE_CONTRACT_VERSION,
  endpoint: 'https://api.iteracompute.com/v1/chat/completions',
  model: 'deepseek/deepseek-v4.1-flash',
  allowedResponseModels: Object.freeze(['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash-0731']),
  aliasEvidence: 'https://iteracompute.com/models/',
  pricingEvidence: 'https://iteracompute.com/pricing/',
  inputUsdPerMillion: 0.29,
  cachedInputUsdPerMillion: 0.0058,
  outputUsdPerMillion: 1.16,
  maxAttempts: 20,
  budgetMicroUsd: 10_000_000,
  maxInputBytes: 2500,
  maxRequestBytes: 4096,
  maxOutputTokens: 8192,
  additionalReasoningTokenAllowance: 16384,
  promptFramingTokenAllowance: 512,
  reservationSafetyMultiplier: 4,
  minimumReservationMicroUsd: 250_000,
  maxResponseBytes: 65536,
  reasoningEffort: 'low',
  automaticRetries: 0,
});
const digest = value => createHash('sha256').update(value).digest('hex');
const approvedSyntheticHashes = new Set(JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8')).map(item => digest(JSON.stringify(item.input))));
const policyDigest = digest(JSON.stringify(POLICY));
export const LEGACY_OUTPUT_POLICY_DIGEST = '4606493a492d2b00de8c7436f791187626ef95ab8456b74b1c298210c5ad23e0';
export const PRE_SEGMENT_POLICY_DIGEST = '2cc57b11cc0a9a8ad934b93133e4437b530eeb6168e40c886d711104b3de7674';
const integer = n => Number.isSafeInteger(n) && n >= 0;
const states = new Set(['reserved', 'usage_received', 'completed', 'failed', 'uncertain']);
export class ControlError extends Error {
  constructor(code) { super(code); this.name = 'ControlError'; this.code = code; }
}
const fail = code => { throw new ControlError(code); };
const safeCode = error => error instanceof ControlError ? error.code : 'LOCAL_VERIFICATION_ERROR';
const timestamp = () => new Date().toISOString();

export function reservationForRequest(requestBytes) {
  if (!integer(requestBytes) || requestBytes > POLICY.maxRequestBytes) fail('REQUEST_TOO_LARGE');
  // Byte-level planning envelope, not a proven provider tokenizer/billing bound.
  const promptTokens = Math.max(3000, requestBytes + POLICY.promptFramingTokenAllowance);
  const outputAndReasoningTokens = POLICY.maxOutputTokens + POLICY.additionalReasoningTokenAllowance;
  const tokenScenarioMicroUsd = Math.ceil((promptTokens * 29 + outputAndReasoningTokens * 116) / 100);
  return {
    promptTokenPlanningCeiling: promptTokens,
    requestedOutputTokens: POLICY.maxOutputTokens,
    additionalReasoningTokenAllowance: POLICY.additionalReasoningTokenAllowance,
    tokenScenarioMicroUsd,
    reservedMicroUsd: Math.max(POLICY.minimumReservationMicroUsd, tokenScenarioMicroUsd * POLICY.reservationSafetyMultiplier),
    allInWorstCaseIndependentlyVerified: false,
  };
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readJson(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 262144) fail('UNSAFE_STATE_FILE');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof ControlError) throw error;
    fail(error.code === 'ENOENT' ? 'LEDGER_MISSING' : 'STATE_READ_FAILED');
  } finally { await handle?.close(); }
}
async function atomicWrite(file, value) {
  const temporary = file + '.tmp-' + randomUUID();
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await handle?.close(); await rm(temporary, {force: true}); }
}
function exposure(entry) {
  return Math.max(entry.reservedMicroUsd, entry.conservativeUsageCostMicroUsd || 0, entry.providerReportedCostMicroUsd || 0);
}
function validateLedger(state) {
  if (state.schemaVersion !== 1 || state.roundId !== POLICY.roundId || ![policyDigest, LEGACY_OUTPUT_POLICY_DIGEST, PRE_SEGMENT_POLICY_DIGEST].includes(state.policyDigest) ||
      !integer(state.requestCount) || !Array.isArray(state.entries) || state.requestCount !== state.entries.length ||
      state.requestCount > POLICY.maxAttempts || !integer(state.exposureMicroUsd) ||
      !(state.stopReason === null || /^[A-Z_]{1,80}$/.test(state.stopReason))) fail('LEDGER_INVALID');
  const ids = new Set();
  for (const [index, entry] of state.entries.entries()) {
    if (entry.sequence !== index + 1 || !/^[a-z0-9-]{1,40}$/.test(entry.caseId) || ids.has(entry.caseId) ||
        !states.has(entry.state) || !integer(entry.reservedMicroUsd) || entry.reservedMicroUsd < POLICY.minimumReservationMicroUsd ||
        !/^[a-f0-9]{64}$/.test(entry.inputSha256) ||
        !(entry.conservativeUsageCostMicroUsd === null || integer(entry.conservativeUsageCostMicroUsd)) ||
        !(entry.providerReportedCostMicroUsd === null || integer(entry.providerReportedCostMicroUsd))) fail('LEDGER_INVALID');
    ids.add(entry.caseId);
  }
  if (state.exposureMicroUsd !== state.entries.reduce((sum, entry) => sum + exposure(entry), 0)) fail('LEDGER_INVALID');
  return state;
}
function updateTotals(state) {
  state.exposureMicroUsd = state.entries.reduce((sum, entry) => sum + exposure(entry), 0);
  state.reservedTotalMicroUsd = state.entries.reduce((sum, entry) => sum + entry.reservedMicroUsd, 0);
  state.usageEstimatedTotalMicroUsd = state.entries.reduce((sum, entry) => sum + (entry.conservativeUsageCostMicroUsd || 0), 0);
  state.providerReportedTotalMicroUsd = state.entries.reduce((sum, entry) => sum + (entry.providerReportedCostMicroUsd || 0), 0);
  state.usageReportedForAttemptCount = state.entries.filter(entry => entry.usage !== null).length;
  state.providerReportedUsdCostForAttemptCount = state.entries.filter(entry => entry.providerReportedCostMicroUsd !== null).length;
  state.usageTokenTotals = {
    promptTokens: state.entries.reduce((sum, entry) => sum + (entry.usage?.promptTokens || 0), 0),
    completionTokens: state.entries.reduce((sum, entry) => sum + (entry.usage?.completionTokens || 0), 0),
    separatelyReportedReasoningTokens: state.entries.reduce((sum, entry) => sum + (entry.usage?.reasoningTokens || 0), 0),
  };
  state.updatedAtUtc = timestamp();
}
export async function initializeLedger(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  if (await realpath(directory) !== path.resolve(directory)) fail('STATE_DIRECTORY_IS_SYMLINK');
  const file = path.join(directory, 'round-ledger.json');
  try { return validateLedger(await readJson(file)); }
  catch (error) { if (error.code !== 'LEDGER_MISSING') throw error; }
  const state = {
    schemaVersion: 1, roundId: POLICY.roundId, policyDigest, outputPolicyVersion: POLICY.outputPolicyVersion, evidenceContractVersion: EVIDENCE_CONTRACT_VERSION, createdAtUtc: timestamp(), updatedAtUtc: timestamp(),
    requestCount: 0, exposureMicroUsd: 0, reservedTotalMicroUsd: 0, usageEstimatedTotalMicroUsd: 0,
    providerReportedTotalMicroUsd: 0, inFlightSequence: null, stopReason: null, entries: [],
    billingAssurance: {keyLimitUsd: 10, automaticRecharge: false, basis: 'user_statement', independentlyVerified: false},
  };
  updateTotals(state);
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(directory);
  return state;
}
async function acquireLock(directory) {
  const lock = path.join(directory, 'round-ledger.lock');
  try { await mkdir(lock, {mode: 0o700}); }
  catch (error) { fail(error.code === 'EEXIST' ? 'ROUND_LOCKED_RECONCILIATION_REQUIRED' : 'LOCK_CREATE_FAILED'); }
  try { await atomicWrite(path.join(lock, 'owner.json'), {pid: process.pid, createdAtUtc: timestamp()}); }
  catch (error) { await rm(lock, {recursive: true, force: true}); throw error; }
  return async () => { await rm(lock, {recursive: true}); await syncDirectory(directory); };
}
export async function inspectLedger(directory) {
  return validateLedger(await readJson(path.join(directory, 'round-ledger.json')));
}
export function verifyAuthorization(authorization) {
  if (authorization?.coordinatorApproved !== true || authorization?.authenticationDestinationApiOnlyConfirmed !== true ||
      authorization?.userAcceptedCurrentSecretScope !== true ||
      authorization?.userDeclaredKeyLimitUsd !== 10 || authorization?.automaticRecharge !== false ||
      authorization?.roundId !== POLICY.roundId) fail('EXECUTION_NOT_COORDINATED');
}
function parseUsage(body) {
  const usage = body.usage;
  if (!usage) fail('USAGE_MISSING');
  for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (!integer(usage[name]) || usage[name] > 1000000000) fail('USAGE_INVALID');
  }
  if (usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens || usage.total_tokens === 0) fail('USAGE_INCONSISTENT');
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? null;
  if (!integer(cached) || cached > usage.prompt_tokens || !(reasoning === null || integer(reasoning))) fail('USAGE_INVALID');
  const conventionalEstimate = Math.ceil((usage.prompt_tokens * 29 + usage.completion_tokens * 116) / 100);
  // Add separately reported reasoning as well, intentionally conservative when completion includes it.
  const conservativeEstimate = Math.ceil((usage.prompt_tokens * 29 + (usage.completion_tokens + (reasoning || 0)) * 116) / 100);
  let reportedCost = null;
  if (usage.cost !== undefined) {
    if (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0 || usage.cost > 1000000) fail('USAGE_COST_INVALID');
    if (usage.currency === 'USD') reportedCost = Math.ceil(usage.cost * 1000000);
  }
  return {
    usage: {promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens, cachedInputTokens: cached, reasoningTokens: reasoning},
    conventionalUsageCostMicroUsd: conventionalEstimate,
    conservativeUsageCostMicroUsd: conservativeEstimate,
    providerReportedCostMicroUsd: reportedCost,
    providerUnverifiedCurrencyCostValue: usage.cost !== undefined && usage.currency !== 'USD' ? usage.cost : null,
    costIsVerifiedFinalInvoice: false,
  };
}
async function boundedJson(response) {
  if (!response.body?.getReader) fail('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = []; let count = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > POLICY.maxResponseBytes) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error instanceof ControlError) throw error; fail('INVALID_RESPONSE'); }
  finally { reader.releaseLock(); }
}
const extractionEnvironment = key => ({
  TRAILBRIEF_API_BASE: 'https://api.iteracompute.com/v1', TRAILBRIEF_MODEL: POLICY.model,
  TRAILBRIEF_API_KEY: key, TRAILBRIEF_MAX_OUTPUT_TOKENS: String(POLICY.maxOutputTokens),
  TRAILBRIEF_MAX_REQUEST_BYTES: String(POLICY.maxRequestBytes), TRAILBRIEF_REASONING_EFFORT: POLICY.reasoningEffort,
});
function validateRequest(url, options) {
  const request = JSON.parse(options.body);
  if (url !== POLICY.endpoint || options.method !== 'POST' || options.redirect !== 'error' || request.model !== POLICY.model ||
      request.reasoning_effort !== POLICY.reasoningEffort || request.max_tokens !== POLICY.maxOutputTokens) fail('REQUEST_POLICY_MISMATCH');
  return reservationForRequest(Buffer.byteLength(options.body));
}
function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > POLICY.maxAttempts) fail('CASES_INVALID');
  const ids = new Set();
  for (const item of cases) {
    if (!/^[a-z0-9-]{1,40}$/.test(item.id) || ids.has(item.id) || item.input?.mode !== 'model' ||
        Buffer.byteLength(JSON.stringify(item.input)) > POLICY.maxInputBytes || !Array.isArray(item.requiredQuotes) ||
        item.requiredQuotes.length === 0) fail('CASES_INVALID');
    normalizeInput(item.input); ids.add(item.id);
  }
}
export async function planCases(cases) {
  validateCases(cases);
  const result = [];
  for (const item of cases) {
    await modelExtract(item.input, {env: extractionEnvironment(undefined), fetchFn: async (url, options) => {
      result.push({caseId: item.id, inputSha256: digest(JSON.stringify(item.input)), inputBytes: Buffer.byteLength(JSON.stringify(item.input)),
        requestBytes: Buffer.byteLength(options.body), reservation: validateRequest(url, options)});
      return {ok: true, json: async () => ({choices: [{message: {content: '{"selections":[]}'}}]})};
    }});
  }
  return result;
}
export async function runBatch({directory, cases, authorization, transport, getKey}) {
  verifyAuthorization(authorization); validateCases(cases);
  if (typeof transport !== 'function' || typeof getKey !== 'function') fail('TRANSPORT_NOT_PROVIDED');
  const release = await acquireLock(directory);
  const file = path.join(directory, 'round-ledger.json');
  let state;
  let authorizedContinuationLimit = null;
  let authorizedValidationPair = false;
  try {
    state = await inspectLedger(directory);
    if (!state.stopReason && (authorization.singleContinuation?.approved === true || authorization.validationContinuation?.approved === true)) fail('CONTINUATION_RESUME_REQUIRES_RECONCILIATION');
    if (state.stopReason && authorization.validationContinuation?.approved === true) {
      const permit = authorization.validationContinuation;
      const ids = ['covered-weather-no-closure', 'missing-sources-unknown'];
      if (authorization.singleContinuation?.approved === true || state.policyDigest !== policyDigest ||
          state.requestCount !== 4 || state.reservedTotalMicroUsd !== 1000000 || state.exposureMicroUsd !== 1000000 ||
          state.stopReason !== 'AUTHORIZED_SINGLE_CONTINUATION_COMPLETE' ||
          state.entries.map(e => e.caseId).join(',') !== 'footbridge-closure,expired-forecast,untrusted-source,segment-ids-new-closure' ||
          state.entries[3].state !== 'completed' || permit.expectedRequestCount !== 4 ||
          permit.previousStopReason !== 'AUTHORIZED_SINGLE_CONTINUATION_COMPLETE' || permit.maxCumulativeRequests !== 6 ||
          permit.maximumNewRequests !== 2 || permit.evidenceContractVersion !== EVIDENCE_CONTRACT_VERSION ||
          permit.frozenPolicyDigest !== policyDigest || JSON.stringify(permit.caseIds) !== JSON.stringify(ids) ||
          cases.length !== 2 || cases.some((c,i) => c.id !== ids[i]) || state.entries.some(e => ids.includes(e.caseId))) fail('VALIDATION_PAIR_SCOPE_REJECTED');
      if (state.inFlightSequence !== null || state.entries.some(e => ['reserved','usage_received','uncertain'].includes(e.state))) fail('UNRESOLVED_PREVIOUS_ATTEMPT');
      state.validationContinuationHistory = [...(state.validationContinuationHistory || []), {
        approvedAtUtc: timestamp(), previousStopReason: state.stopReason, requestCountBefore: 4, reservedMicroUsdBefore: 1000000,
        caseIds: ids, maximumNewRequests: 2, maxCumulativeRequests: 6, frozenPolicyDigest: policyDigest,
        preservedEntrySha256: state.entries.map(e => digest(JSON.stringify(e))),
        authority: 'Parent conveyed user authorization: freeze ID-selection v1; exactly one call for each of two unseen normal fixtures; preserve four prior attempts/USD 1.00 reserve; stop on first error; no retries or new budget.',
      }];
      state.stopReason = null; updateTotals(state); await atomicWrite(file, state);
      authorizedContinuationLimit = 6; authorizedValidationPair = true;
    }
    if (state.stopReason) {
      const permit = authorization.singleContinuation;
      if (permit?.approved !== true) fail('ROUND_ALREADY_STOPPED');
      const secondOnly = state.policyDigest === policyDigest && state.requestCount === 1 && state.stopReason === 'MODEL_EXTRACTION_REJECTED' &&
        state.exposureMicroUsd === 250000 && permit.expectedRequestCount === 1 && permit.previousStopReason === 'MODEL_EXTRACTION_REJECTED' &&
        permit.singleCaseId === 'expired-forecast' && permit.maxCumulativeRequests === 2 &&
        state.entries[0].state === 'failed' && state.entries[0].errorCode === 'MODEL_EXTRACTION_REJECTED';
      const thirdOnly = state.requestCount === 2 && state.stopReason === 'MODEL_OUTPUT_INCOMPLETE' &&
        state.exposureMicroUsd === 500000 && state.reservedTotalMicroUsd === 500000 &&
        permit.expectedRequestCount === 2 && permit.previousStopReason === 'MODEL_OUTPUT_INCOMPLETE' &&
        permit.singleCaseId === 'untrusted-source' && permit.maxCumulativeRequests === 3 &&
        permit.outputPolicyVersion === POLICY.outputPolicyVersion && permit.maxOutputTokens === POLICY.maxOutputTokens &&
        permit.previousPolicyDigest === LEGACY_OUTPUT_POLICY_DIGEST &&
        state.entries[0].caseId === 'footbridge-closure' && state.entries[0].state === 'failed' && state.entries[0].errorCode === 'MODEL_EXTRACTION_REJECTED' &&
        state.entries[1].caseId === 'expired-forecast' && state.entries[1].state === 'failed' && state.entries[1].errorCode === 'MODEL_OUTPUT_INCOMPLETE';
      const fourthOnly = state.requestCount === 3 && state.stopReason === 'EXTRACTION_QUOTE_REJECTED' &&
        state.exposureMicroUsd === 750000 && state.reservedTotalMicroUsd === 750000 &&
        permit.expectedRequestCount === 3 && permit.previousStopReason === 'EXTRACTION_QUOTE_REJECTED' &&
        permit.singleCaseId === 'segment-ids-new-closure' && permit.maxCumulativeRequests === 4 &&
        permit.evidenceContractVersion === EVIDENCE_CONTRACT_VERSION && permit.outputPolicyVersion === 2 && permit.maxOutputTokens === 8192 &&
        permit.previousPolicyDigest === PRE_SEGMENT_POLICY_DIGEST &&
        state.entries.map(e => e.caseId).join(',') === 'footbridge-closure,expired-forecast,untrusted-source' &&
        state.entries.every(e => e.state === 'failed') && state.entries[2].errorCode === 'EXTRACTION_QUOTE_REJECTED';
      if ((!secondOnly && !thirdOnly && !fourthOnly) || cases.length !== 1 || cases[0].id !== permit.singleCaseId ||
          state.entries.some(entry => entry.caseId === cases[0].id)) fail('CONTINUATION_SCOPE_REJECTED');
      if (state.inFlightSequence !== null || state.entries.some(entry => ['reserved', 'usage_received', 'uncertain'].includes(entry.state))) fail('UNRESOLVED_PREVIOUS_ATTEMPT');
      if (state.policyDigest === LEGACY_OUTPUT_POLICY_DIGEST) {
        if (!thirdOnly) fail('OUTPUT_POLICY_MIGRATION_NOT_AUTHORIZED');
        state.policyMigrationHistory = [...(state.policyMigrationHistory || []), {
          approvedAtUtc: timestamp(), previousPolicyDigest: state.policyDigest, nextPolicyDigest: policyDigest,
          previousOutputPolicyVersion: 1, nextOutputPolicyVersion: POLICY.outputPolicyVersion,
          previousMaxOutputTokens: 2048, nextMaxOutputTokens: POLICY.maxOutputTokens,
          requestCountBefore: state.requestCount, exposureMicroUsdBefore: state.exposureMicroUsd,
          preservedEntrySha256: state.entries.map(entry => digest(JSON.stringify(entry))),
          authority: 'Parent conveyed user authorization: change only the output cap to 8192, preserve both attempts and USD 0.50 reserve, then one previously unsent third case.',
        }];
        state.policyDigest = policyDigest; state.outputPolicyVersion = POLICY.outputPolicyVersion;
      }
      if (state.policyDigest === PRE_SEGMENT_POLICY_DIGEST) {
        if (!fourthOnly) fail('EVIDENCE_CONTRACT_MIGRATION_NOT_AUTHORIZED');
        state.evidenceContractMigrationHistory = [...(state.evidenceContractMigrationHistory || []), {
          approvedAtUtc: timestamp(), previousPolicyDigest: state.policyDigest, nextPolicyDigest: policyDigest,
          previousEvidenceContract: 'model-copied-quotations', nextEvidenceContract: 'segment-ids-deterministic-source-assembly',
          evidenceContractVersion: EVIDENCE_CONTRACT_VERSION, promptVersion: SEGMENT_PROMPT_VERSION,
          requestCountBefore: state.requestCount, reservedMicroUsdBefore: state.reservedTotalMicroUsd,
          preservedEntrySha256: state.entries.map(e => digest(JSON.stringify(e))),
          authority: 'Parent conveyed user authorization: validate segment IDs offline, then exactly one new fourth fixture; preserve three earlier attempts and USD 0.75 reserve; no retries or new budget.',
        }];
        state.policyDigest = policyDigest; state.evidenceContractVersion = EVIDENCE_CONTRACT_VERSION;
      }
      state.continuationHistory = [...(state.continuationHistory || []), {
        approvedAtUtc: timestamp(), previousStopReason: state.stopReason, requestCountBefore: state.requestCount,
        exposureMicroUsdBefore: state.exposureMicroUsd, singleCaseId: cases[0].id, maxCumulativeRequests: permit.maxCumulativeRequests,
        authority: fourthOnly ? 'Parent conveyed user authorization: one previously unsent fourth fixture with segment-ID selection and deterministic evidence assembly; same model, low, 8192; no retries or new budget.' : thirdOnly ? 'Parent conveyed user authorization: one previously unsent third case with output cap 8192; same model and low reasoning; no retries or new budget.' : 'Parent conveyed user authorization: apply the minimal prompt correction, then one previously unsent case; preserve all history; no retries or new budget.',
      }];
      state.stopReason = null; updateTotals(state); await atomicWrite(file, state);
      authorizedContinuationLimit = permit.maxCumulativeRequests;
    }
    if (state.policyDigest !== policyDigest) fail('OUTPUT_POLICY_MIGRATION_NOT_AUTHORIZED');
    if (state.inFlightSequence !== null || state.entries.some(entry => ['reserved', 'usage_received'].includes(entry.state))) {
      state.stopReason = 'UNRESOLVED_PREVIOUS_ATTEMPT'; updateTotals(state); await atomicWrite(file, state); fail(state.stopReason);
    }
    for (const item of cases) {
      if (state.entries.some(entry => entry.caseId === item.id)) continue; // No repeat of any dispatched case.
      if (state.requestCount >= POLICY.maxAttempts) fail('ATTEMPT_LIMIT_REACHED');
      if (authorizedContinuationLimit !== null && state.requestCount >= authorizedContinuationLimit) fail('CONTINUATION_LIMIT_REACHED');
      const key = getKey();
      if (typeof key !== 'string' || !key) fail('KEY_UNAVAILABLE');
      let entry;
      let dispatchFailureCode;
      let assistantObservation;
      const observationFile = path.join(directory, item.id + '-assistant-diagnostic.json');
      try {
        const brief = await runBrief(item.input, {extract: async value => {
          try { const extraction = await modelExtract(value, {
          env: extractionEnvironment(key),
          fetchFn: async (url, options) => {
            if (entry) fail('DUPLICATE_DISPATCH_BLOCKED');
            const reservation = validateRequest(url, options);
            if (state.exposureMicroUsd + reservation.reservedMicroUsd > POLICY.budgetMicroUsd) fail('BUDGET_LIMIT_REACHED');
            entry = {sequence: state.requestCount + 1, caseId: item.id, inputSha256: digest(JSON.stringify(item.input)),
              startedAtUtc: timestamp(), state: 'reserved', ...reservation, evidenceContractVersion: EVIDENCE_CONTRACT_VERSION, promptVersion: SEGMENT_PROMPT_VERSION, usage: null,
              conservativeUsageCostMicroUsd: null, providerReportedCostMicroUsd: null, errorCode: null};
            state.entries.push(entry); state.requestCount++; state.inFlightSequence = entry.sequence;
            updateTotals(state); await atomicWrite(file, state); // Durable count and reserve BEFORE network.
            if (approvedSyntheticHashes.has(entry.inputSha256)) {
              const segments = buildSourceSegments(value);
              entry.sourceSegmentsSha256 = digest(JSON.stringify(segments));
              await atomicWrite(path.join(directory, item.id + '-source-segments.json'), {caseId: item.id,
                provenance: 'Program-generated exact segments from the preapproved fictional input; not model-generated text',
                inputSha256: entry.inputSha256, evidenceContractVersion: EVIDENCE_CONTRACT_VERSION, promptVersion: SEGMENT_PROMPT_VERSION,
                systemPrompt: SEGMENT_SYSTEM_PROMPT, segments});
              updateTotals(state); await atomicWrite(file, state);
            }
            let response;
            const apiStarted = performance.now();
            try { response = await transport(url, options); }
            catch { fail('API_TRANSPORT_ERROR'); }
            if (!response.ok) {
              entry.httpStatus = integer(response.status) ? response.status : null;
              try { await response.body?.cancel(); } catch { /* Never inspect error bodies. */ }
              fail('API_ERROR');
            }
            const body = await boundedJson(response);
            entry.apiResponseBodyElapsedMs = Math.round((performance.now() - apiStarted) * 1000) / 1000;
            Object.assign(entry, parseUsage(body)); entry.state = 'usage_received';
            updateTotals(state); await atomicWrite(file, state);
            if (!POLICY.allowedResponseModels.includes(body.model)) fail('MODEL_IDENTITY_UNEXPECTED');
            entry.responseModel = body.model;
            if (entry.providerUnverifiedCurrencyCostValue !== null) fail('USAGE_COST_CURRENCY_UNVERIFIED');
            if (entry.conservativeUsageCostMicroUsd > entry.reservedMicroUsd || (entry.providerReportedCostMicroUsd || 0) > entry.reservedMicroUsd) fail('RESERVATION_EXCEEDED');
            entry.finishReason = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(body.choices?.[0]?.finish_reason) ? body.choices[0].finish_reason : 'unrecognized';
            assistantObservation = safeAssistantObservation({content: body.choices?.[0]?.message?.content,
              finishReason: body.choices?.[0]?.finish_reason,
              approvedSyntheticInput: approvedSyntheticHashes.has(entry.inputSha256), credential: key});
            await atomicWrite(observationFile, {caseId: item.id, provenance: 'Successful HTTP response for a preapproved fictional test input; never an HTTP error body', ...assistantObservation});
            if (entry.usage.promptTokens > entry.promptTokenPlanningCeiling || entry.usage.completionTokens > POLICY.maxOutputTokens ||
                (entry.usage.reasoningTokens || 0) > POLICY.additionalReasoningTokenAllowance) fail('TOKEN_ENVELOPE_EXCEEDED');
            if (body.choices?.[0]?.finish_reason !== 'stop') fail('MODEL_OUTPUT_INCOMPLETE');
            const content = body.choices?.[0]?.message?.content;
            if (typeof content !== 'string') fail('MODEL_CONTENT_INVALID');
            if (content.includes(key)) fail('SECRET_ECHO_REJECTED');
            if (assistantObservation.omissionReason === 'secret_like_content') fail('ASSISTANT_SECRET_LIKE_CONTENT_REJECTED');
            return {ok: true, json: async () => ({choices: [{message: {content}}]})};
          },
          });
          // IDs select exact program-owned source slices; no model-written quotation is accepted.
          const diagnosis = diagnoseSelection(extraction, value);
          if (assistantObservation) {
            Object.assign(assistantObservation, {stage: diagnosis.stage, code: diagnosis.code,
              schemaIssues: diagnosis.schemaIssues, selectionPath: diagnosis.path || null});
            await atomicWrite(observationFile, {caseId: item.id, provenance: 'Successful HTTP response for a preapproved fictional test input; never an HTTP error body', ...assistantObservation});
          }
          if (!diagnosis.ok) fail(diagnosis.code);
          return diagnosis.data;
          } catch (error) {
            dispatchFailureCode = error instanceof ControlError ? error.code : error?.message === 'Provider output was not valid JSON. No brief was created.' ? 'JSON_PARSE_REJECTED' : 'MODEL_OUTPUT_INVALID';
            if (assistantObservation) {
              if (assistantObservation.stage === 'response_received') assistantObservation.stage = dispatchFailureCode === 'JSON_PARSE_REJECTED' ? 'json_parse' : ['MODEL_OUTPUT_INCOMPLETE', 'TOKEN_ENVELOPE_EXCEEDED'].includes(dispatchFailureCode) ? 'completion' : 'response_policy';
              assistantObservation.code = dispatchFailureCode;
              await atomicWrite(observationFile, {caseId: item.id, provenance: 'Successful HTTP response for a preapproved fictional test input; never an HTTP error body', ...assistantObservation});
            }
            throw new ControlError(dispatchFailureCode);
          }
        }});
        for (const required of item.requiredQuotes) {
          if (!brief.claims.some(claim => claim.sourceId === required.sourceId && claim.quote.includes(required.text))) fail('ACCEPTANCE_REQUIRED_EVIDENCE_MISSING');
        }
        if (brief.claims.some(claim => (item.forbiddenQuoteFragments || []).some(fragment => claim.quote.includes(fragment))) ||
            brief.questions.some(question => !/[?？]$/.test(question.trim()))) fail('ACCEPTANCE_UNSAFE_OUTPUT');
        await atomicWrite(path.join(directory, item.id + '-review.json'), {inputSha256: entry.inputSha256, brief, humanReviewRequired: true});
        entry.state = 'completed'; entry.finishedAtUtc = timestamp(); state.inFlightSequence = null;
        updateTotals(state); await atomicWrite(file, state);
      } catch (error) {
        const code = dispatchFailureCode || (error instanceof ControlError ? error.code : 'WORKFLOW_REJECTED');
        if (entry) { entry.state = entry.usage ? 'failed' : 'uncertain'; entry.errorCode = code; entry.finishedAtUtc = timestamp(); }
        state.stopReason = code; state.inFlightSequence = null; updateTotals(state); await atomicWrite(file, state);
        throw new ControlError(code);
      }
    }
    if (authorizedContinuationLimit !== null) {
      state.stopReason = authorizedValidationPair ? 'AUTHORIZED_VALIDATION_PAIR_COMPLETE' : 'AUTHORIZED_SINGLE_CONTINUATION_COMPLETE'; updateTotals(state); await atomicWrite(file, state);
    }
    return {requestCount: state.requestCount, exposureMicroUsd: state.exposureMicroUsd, usageEstimatedTotalMicroUsd: state.usageEstimatedTotalMicroUsd,
      usageReportedForAttemptCount: state.usageReportedForAttemptCount, usageTokenTotals: state.usageTokenTotals,
      providerReportedUsdCostForAttemptCount: state.providerReportedUsdCostForAttemptCount,
      completedCases: state.entries.filter(entry => entry.state === 'completed').map(entry => entry.caseId), stopReason: state.stopReason};
  } catch (error) { throw new ControlError(safeCode(error)); }
  finally { await release(); }
}
