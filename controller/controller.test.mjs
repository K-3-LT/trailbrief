import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, mkdir, stat, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {POLICY, LEGACY_OUTPUT_POLICY_DIGEST, PRE_SEGMENT_POLICY_DIGEST, reservationForRequest, initializeLedger, inspectLedger, planCases, runBatch} from './controller.mjs';

import {buildSourceSegments} from '../app/trailbrief/src/segments.js';
const allFixtures = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
const fixtures = allFixtures.slice(0,3);
const fourthFixture = allFixtures[3];
const credential = 'synthetic-controller-credential';
const authorization = {roundId: POLICY.roundId, coordinatorApproved: true,
  authenticationDestinationApiOnlyConfirmed: true, userAcceptedCurrentSecretScope: true,
  secretAuthorizationScopeNarrowed: false, userDeclaredKeyLimitUsd: 10, automaticRecharge: false};
const copy = object => structuredClone(object);
function sample(id = 'case-one') { const item = copy(fixtures[0]); item.id = id; return item; }
function response(item, modify = () => {}) {
  const body = {model: POLICY.model,
    usage: {prompt_tokens: 100, completion_tokens: 80, total_tokens: 180,
      prompt_tokens_details: {cached_tokens: 10}, completion_tokens_details: {reasoning_tokens: 20}},
    choices: [{finish_reason: 'stop', message: {content: JSON.stringify({
      selections: item.requiredQuotes.map(required => {const s=buildSourceSegments(item.input).find(s=>s.sourceId===required.sourceId&&s.text.includes(required.text));return {sourceId:s.sourceId,segmentId:s.segmentId};}),
    })}}]};
  modify(body);
  return new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
}
async function context(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trailbrief-controller-test-'));
  try { await initializeLedger(directory); await callback(directory); }
  finally { await rm(directory, {recursive: true, force: true}); }
}
const run = (directory, cases, transport, extra = {}) => runBatch({directory, cases, authorization, getKey: () => credential, transport, ...extra});
const rejectsCode = (operation, code) => assert.rejects(operation, error => error.code === code);

test('planning stays credential-free and bounds all three fixed requests', async () => {
  const plan = await planCases(fixtures);
  assert.equal(plan.length, 3);
  for (const item of plan) {
    assert(item.inputBytes <= 2500); assert(item.requestBytes <= 4096);
    assert.equal(item.reservation.reservedMicroUsd, 250000);
    assert.equal(item.reservation.allInWorstCaseIndependentlyVerified, false);
  }
  assert.deepEqual(POLICY.allowedResponseModels, ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash-0731']);
});

test('inactive coordination gates do not read a credential or dispatch', async () => context(async directory => {
  let reads = 0; let calls = 0;
  await rejectsCode(run(directory, fixtures, () => { calls++; }, {
    authorization: {...authorization, authenticationDestinationApiOnlyConfirmed: false},
    getKey: () => { reads++; return credential; },
  }), 'EXECUTION_NOT_COORDINATED');
  assert.equal(reads, 0); assert.equal(calls, 0); assert.equal((await inspectLedger(directory)).requestCount, 0);
}));

test('user acceptance of current secret scope does not falsely require narrowed authorization domains', async () => context(async directory => {
  const item = sample();
  await run(directory, [item], async () => response(item));
  assert.equal(authorization.secretAuthorizationScopeNarrowed, false);
  assert.equal((await inspectLedger(directory)).requestCount, 1);
}));

test('three successful mocked cases persist counts, reservations and separate usage estimates', async () => context(async directory => {
  let calls = 0;
  const result = await run(directory, fixtures, async (url, options) => {
    assert.equal(url, POLICY.endpoint);
    const body = JSON.parse(options.body);
    assert.equal(body.model, POLICY.model); assert.equal(body.reasoning_effort, 'low'); assert.equal(body.max_tokens, 8192);
    const item = fixtures[calls++];
    const during = await inspectLedger(directory);
    assert.equal(during.requestCount, calls); assert.equal(during.entries.at(-1).state, 'reserved');
    return response(item);
  });
  assert.equal(calls, 3); assert.equal(result.requestCount, 3); assert.equal(result.exposureMicroUsd, 750000);
  const saved = await inspectLedger(directory);
  assert.equal(saved.stopReason, null); assert(saved.usageEstimatedTotalMicroUsd > 0);
  assert(saved.usageEstimatedTotalMicroUsd < saved.reservedTotalMicroUsd);
  assert.equal(saved.entries[0].usage.reasoningTokens, 20);
  assert.equal((await stat(path.join(directory, 'round-ledger.json'))).mode & 0o777, 0o600);
  assert(!(await readFile(path.join(directory, 'round-ledger.json'), 'utf8')).includes(credential));
}));

test('restart does not reset a ledger or repeat completed cases', async () => context(async directory => {
  const item = sample(); await run(directory, [item], async () => response(item));
  await initializeLedger(directory);
  let calls = 0; let reads = 0;
  await run(directory, [item], () => { calls++; }, {getKey: () => {reads++; return credential;}});
  assert.equal(calls, 0); assert.equal(reads, 0); assert.equal((await inspectLedger(directory)).requestCount, 1);
}));

test('20 cumulative requests survive multiple batches and block attempt 21', async () => context(async directory => {
  const all = Array.from({length: 20}, (_, i) => sample('case-' + (i + 1)));
  let calls = 0;
  for (const batch of [all.slice(0, 10), all.slice(10)]) {
    let index = 0; await run(directory, batch, async () => { calls++; return response(batch[index++]); });
    await initializeLedger(directory);
  }
  await rejectsCode(run(directory, [sample('case-21')], () => {calls++;}), 'ATTEMPT_LIMIT_REACHED');
  assert.equal(calls, 20); const saved = await inspectLedger(directory);
  assert.equal(saved.requestCount, 20); assert.equal(saved.exposureMicroUsd, 5000000);
}));

test('first API failure has no retry, retains reservation and stops future batches', async () => context(async directory => {
  let calls = 0;
  await rejectsCode(run(directory, fixtures, async () => {calls++; return new Response(credential, {status: 429});}), 'API_ERROR');
  assert.equal(calls, 1);
  const saved = await inspectLedger(directory);
  assert.equal(saved.requestCount, 1); assert.equal(saved.exposureMicroUsd, 250000); assert.equal(saved.stopReason, 'API_ERROR');
  await assert.rejects(readFile(path.join(directory, 'footbridge-closure-assistant-diagnostic.json')), {code: 'ENOENT'});
  assert(!(await readFile(path.join(directory, 'round-ledger.json'), 'utf8')).includes(credential));
  await rejectsCode(run(directory, [sample('new-case')], () => {calls++;}), 'ROUND_ALREADY_STOPPED');
  assert.equal(calls, 1);
}));

test('transport exceptions never echo their message or credential into the ledger', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => {throw Error(credential);}), 'API_TRANSPORT_ERROR');
  const text = await readFile(path.join(directory, 'round-ledger.json'), 'utf8');
  assert(!text.includes(credential)); assert(text.includes('API_TRANSPORT_ERROR'));
}));

test('unexpected model identity is rejected without persisting the raw identifier', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {body.model = credential;})), 'MODEL_IDENTITY_UNEXPECTED');
  const text = await readFile(path.join(directory, 'round-ledger.json'), 'utf8');
  assert(!text.includes(credential)); assert.equal((await inspectLedger(directory)).requestCount, 1);
}));

test('predeclared official legacy response alias is accepted without changing requested model', async () => context(async directory => {
  const item = sample();
  await run(directory, [item], async (_, options) => {
    assert.equal(JSON.parse(options.body).model, POLICY.model);
    return response(item, body => {body.model = 'deepseek/deepseek-v4-flash-0731';});
  });
  assert.equal((await inspectLedger(directory)).entries[0].state, 'completed');
}));

test('missing usage stops after one request and preserves unresolved charges', async () => context(async directory => {
  let calls = 0;
  await rejectsCode(run(directory, fixtures, async () => {calls++; return response(fixtures[0], body => {delete body.usage;});}), 'USAGE_MISSING');
  assert.equal(calls, 1); const saved = await inspectLedger(directory);
  assert.equal(saved.entries[0].usage, null); assert.equal(saved.exposureMicroUsd, 250000);
}));

test('inconsistent token totals are rejected', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {body.usage.total_tokens = 1;})), 'USAGE_INCONSISTENT');
}));

test('reported USD charge exceeding reserve is retained as exposure and stops', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {body.usage.cost = 0.5; body.usage.currency = 'USD';})), 'RESERVATION_EXCEEDED');
  const saved = await inspectLedger(directory);
  assert.equal(saved.exposureMicroUsd, 500000); assert.equal(saved.entries[0].providerReportedCostMicroUsd, 500000);
}));

test('a reported cost without verified USD currency is preserved separately and stops', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {body.usage.cost = 0.1;})), 'USAGE_COST_CURRENCY_UNVERIFIED');
  const saved = await inspectLedger(directory);
  assert.equal(saved.entries[0].providerUnverifiedCurrencyCostValue, 0.1);
  assert.equal(saved.entries[0].providerReportedCostMicroUsd, null);
  assert.equal(saved.usageReportedForAttemptCount, 1);
}));

test('output-token envelope and truncated outputs stop the round', async () => {
  await context(async directory => rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {
    body.usage.completion_tokens = 8193; body.usage.total_tokens = 8293;
  })), 'TOKEN_ENVELOPE_EXCEEDED'));
  await context(async directory => rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {
    body.choices[0].finish_reason = 'length';
  })), 'MODEL_OUTPUT_INCOMPLETE'));
});

test('provider content echoing the credential is never exported', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {body.choices[0].message.content = credential;})), 'SECRET_ECHO_REJECTED');
  assert(!(await readFile(path.join(directory, 'round-ledger.json'), 'utf8')).includes(credential));
}));

test('missing required second-paragraph evidence stops without a fallback or next case', async () => context(async directory => {
  let calls = 0;
  await rejectsCode(run(directory, fixtures, async () => {
    calls++; return response(fixtures[0], body => {
      body.choices[0].message.content = JSON.stringify({selections:[{sourceId:'route',segmentId:buildSourceSegments(fixtures[0].input)[0].segmentId}]});
    });
  }), 'ACCEPTANCE_REQUIRED_EVIDENCE_MISSING');
  assert.equal(calls, 1); assert.equal((await inspectLedger(directory)).entries[0].state, 'failed');
}));

test('invalid provider schema becomes a fixed error code before workflow logging', async () => context(async directory => {
  const untrustedText = 'RAW_PROVIDER_TEXT_MUST_NOT_ECHO';
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {
    body.choices[0].message.content = JSON.stringify({selections:[{sourceId:untrustedText,segmentId:buildSourceSegments(fixtures[0].input)[0].segmentId}]});
  })), 'SEGMENT_SELECTION_SCHEMA_REJECTED');
  assert(!(await readFile(path.join(directory, 'round-ledger.json'), 'utf8')).includes(untrustedText));
  const diagnostic = JSON.parse(await readFile(path.join(directory, 'footbridge-closure-assistant-diagnostic.json'), 'utf8'));
  assert.equal(diagnostic.stage, 'selection_schema'); assert.equal(diagnostic.code, 'SEGMENT_SELECTION_SCHEMA_REJECTED');
  assert.deepEqual(diagnostic.schemaIssues[0].path, ['selections', 0, 'sourceId']);
  assert.equal(diagnostic.finishReason, 'stop');
}));

test('invalid JSON retains only approved synthetic assistant text and a parser category', async () => context(async directory => {
  const text = '{invalid synthetic JSON';
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {body.choices[0].message.content = text;})), 'JSON_PARSE_REJECTED');
  const diagnostic = JSON.parse(await readFile(path.join(directory, 'footbridge-closure-assistant-diagnostic.json'), 'utf8'));
  assert.equal(diagnostic.stage, 'json_parse'); assert.equal(diagnostic.assistantText, text);
}));

test('unknown segment ID is rejected without rewriting evidence', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => response(fixtures[0], body => {
    body.choices[0].message.content = JSON.stringify({selections:[{sourceId:'route',segmentId:'route-'+ '0'.repeat(24)}]});
  })), 'SEGMENT_ID_UNKNOWN');
  const diagnostic = JSON.parse(await readFile(path.join(directory, 'footbridge-closure-assistant-diagnostic.json'), 'utf8'));
  assert.equal(diagnostic.stage, 'segment_ids'); assert.deepEqual(diagnostic.selectionPath, ['selections', 0, 'segmentId']);
}));

test('filesystem lock rejects simultaneous controllers before a second dispatch', async () => context(async directory => {
  let resolveResponse; let notifyStarted;
  const started = new Promise(resolve => {notifyStarted = resolve;});
  const first = run(directory, [sample()], async () => {notifyStarted(); return new Promise(resolve => {resolveResponse = resolve;});});
  await started;
  await rejectsCode(run(directory, [sample('other-case')], async () => response(sample('other-case'))), 'ROUND_LOCKED_RECONCILIATION_REQUIRED');
  resolveResponse(response(sample())); await first;
  assert.equal((await inspectLedger(directory)).requestCount, 1);
}));

test('stale lock is not automatically removed', async () => context(async directory => {
  await mkdir(path.join(directory, 'round-ledger.lock'));
  await rejectsCode(run(directory, fixtures, async () => {throw Error('Must not dispatch');}), 'ROUND_LOCKED_RECONCILIATION_REQUIRED');
  assert((await stat(path.join(directory, 'round-ledger.lock'))).isDirectory());
}));

test('unresolved persisted attempt survives restart and blocks new requests', async () => context(async directory => {
  const item = sample(); await run(directory, [item], async () => response(item));
  const state = await inspectLedger(directory); state.entries[0].state = 'reserved'; state.inFlightSequence = 1;
  await writeFile(path.join(directory, 'round-ledger.json'), JSON.stringify(state));
  await rejectsCode(run(directory, [sample('later-case')], async () => {throw Error('Must not dispatch');}), 'UNRESOLVED_PREVIOUS_ATTEMPT');
  const after = await inspectLedger(directory);
  assert.equal(after.requestCount, 1); assert.equal(after.exposureMicroUsd, 250000); assert.equal(after.stopReason, 'UNRESOLVED_PREVIOUS_ATTEMPT');
}));

test('budget guard rejects a new reservation against reconciled prior exposure', async () => context(async directory => {
  const item = sample(); await run(directory, [item], async () => response(item));
  const state = await inspectLedger(directory);
  state.entries[0].providerReportedCostMicroUsd = 9800000; state.exposureMicroUsd = 9800000;
  await writeFile(path.join(directory, 'round-ledger.json'), JSON.stringify(state));
  let calls = 0;
  await rejectsCode(run(directory, [sample('later-case')], async () => {calls++;}), 'BUDGET_LIMIT_REACHED');
  assert.equal(calls, 0); assert.equal((await inspectLedger(directory)).requestCount, 1);
}));

test('missing or symlinked ledger is not silently initialized during execution', async () => {
  await context(async directory => {
    await rm(path.join(directory, 'round-ledger.json'));
    await rejectsCode(run(directory, fixtures, async () => {throw Error('Must not dispatch');}), 'LEDGER_MISSING');
  });
  await context(async directory => {
    await renameLedger(directory);
    await rejectsCode(run(directory, fixtures, async () => {throw Error('Must not dispatch');}), 'STATE_READ_FAILED');
  });
});
async function renameLedger(directory) {
  const file = path.join(directory, 'round-ledger.json');
  const text = await readFile(file, 'utf8'); await rm(file);
  await writeFile(path.join(directory, 'elsewhere.json'), text);
  await symlink(path.join(directory, 'elsewhere.json'), file);
}

async function seedLegacyStoppedFailure(directory) {
  await rejectsCode(run(directory, [fixtures[0]], async () => response(fixtures[0], body => {
    body.choices[0].message.content = JSON.stringify({selections:[{sourceId:'invalid-source',segmentId:buildSourceSegments(fixtures[0].input)[0].segmentId}]});
  })), 'SEGMENT_SELECTION_SCHEMA_REJECTED');
  const state = await inspectLedger(directory);
  // Represent the prior version's aggregate failure in this synthetic-only temporary ledger.
  state.stopReason = 'MODEL_EXTRACTION_REJECTED'; state.entries[0].errorCode = 'MODEL_EXTRACTION_REJECTED';
  await writeFile(path.join(directory, 'round-ledger.json'), JSON.stringify(state));
  return structuredClone(state.entries[0]);
}
const continuationAuthorization = {...authorization, singleContinuation: {approved: true, expectedRequestCount: 1,
  previousStopReason: 'MODEL_EXTRACTION_REJECTED', singleCaseId: 'expired-forecast', maxCumulativeRequests: 2}};

test('single-case continuation preserves original failure and stops after cumulative request two', async () => context(async directory => {
  const originalEntry = await seedLegacyStoppedFailure(directory);
  let calls = 0;
  await run(directory, [fixtures[1]], async () => {calls++; return response(fixtures[1]);}, {authorization: continuationAuthorization});
  const after = await inspectLedger(directory);
  assert.equal(calls, 1); assert.equal(after.requestCount, 2); assert.equal(after.reservedTotalMicroUsd, 500000);
  assert.deepEqual(after.entries[0], originalEntry);
  assert.equal(after.continuationHistory[0].previousStopReason, 'MODEL_EXTRACTION_REJECTED');
  assert.equal(after.stopReason, 'AUTHORIZED_SINGLE_CONTINUATION_COMPLETE');
  await rejectsCode(run(directory, [fixtures[2]], async () => {calls++;}, {authorization: continuationAuthorization}), 'CONTINUATION_SCOPE_REJECTED');
  assert.equal(calls, 1);
}));

test('continuation refuses a two-case batch or the already dispatched first case', async () => context(async directory => {
  await seedLegacyStoppedFailure(directory);
  let calls = 0;
  await rejectsCode(run(directory, fixtures.slice(1), async () => {calls++;}, {authorization: continuationAuthorization}), 'CONTINUATION_SCOPE_REJECTED');
  await rejectsCode(run(directory, [fixtures[0]], async () => {calls++;}, {authorization: continuationAuthorization}), 'CONTINUATION_SCOPE_REJECTED');
  assert.equal(calls, 0); assert.equal((await inspectLedger(directory)).requestCount, 1);
}));

test('first error in the authorized second case stops without retry and retains both reserves', async () => context(async directory => {
  const originalEntry = await seedLegacyStoppedFailure(directory);
  let calls = 0;
  await rejectsCode(run(directory, [fixtures[1]], async () => {calls++; return new Response('Synthetic unavailable body', {status: 503});},
    {authorization: continuationAuthorization}), 'API_ERROR');
  const after = await inspectLedger(directory);
  assert.equal(calls, 1); assert.equal(after.requestCount, 2); assert.equal(after.exposureMicroUsd, 500000);
  assert.deepEqual(after.entries[0], originalEntry); assert.equal(after.stopReason, 'API_ERROR');
}));

test('oversized provider response is rejected without persisting its content', async () => context(async directory => {
  await rejectsCode(run(directory, fixtures, async () => new Response('x'.repeat(65537), {status: 200})), 'RESPONSE_TOO_LARGE');
  assert.equal((await inspectLedger(directory)).requestCount, 1);
}));

test('8192 output cap remains covered by the unchanged USD 0.25 minimum reservation', () => {
  const reservation = reservationForRequest(POLICY.maxRequestBytes);
  assert.equal(POLICY.outputPolicyVersion, 2); assert.equal(POLICY.maxOutputTokens, 8192);
  assert.equal(POLICY.maxAttempts, 20); assert.equal(POLICY.budgetMicroUsd, 10000000);
  assert.equal(reservation.requestedOutputTokens, 8192);
  assert.equal(reservation.additionalReasoningTokenAllowance, 16384);
  assert.equal(reservation.tokenScenarioMicroUsd, 29845);
  assert(reservation.tokenScenarioMicroUsd * POLICY.reservationSafetyMultiplier < 250000);
  assert.equal(reservation.reservedMicroUsd, 250000);
});
const thirdAuthorization = {...authorization, singleContinuation: {approved: true, expectedRequestCount: 2,
  previousStopReason: 'MODEL_OUTPUT_INCOMPLETE', singleCaseId: 'untrusted-source', maxCumulativeRequests: 3,
  outputPolicyVersion: 2, maxOutputTokens: 8192, previousPolicyDigest: LEGACY_OUTPUT_POLICY_DIGEST}};
async function seedLegacyTwoAttempts(directory) {
  await seedLegacyStoppedFailure(directory);
  await rejectsCode(run(directory, [fixtures[1]], async () => response(fixtures[1], body => {
    body.choices[0].finish_reason = 'length'; body.choices[0].message.content = '';
  }), {authorization: continuationAuthorization}), 'MODEL_OUTPUT_INCOMPLETE');
  const state = await inspectLedger(directory);
  state.policyDigest = LEGACY_OUTPUT_POLICY_DIGEST; delete state.outputPolicyVersion;
  for (const entry of state.entries) entry.requestedOutputTokens = 2048;
  await writeFile(path.join(directory, 'round-ledger.json'), JSON.stringify(state));
  return structuredClone(state);
}
test('explicit third-only output policy migration preserves both attempts and prior continuation history', async () => context(async directory => {
  const before = await seedLegacyTwoAttempts(directory); let calls = 0;
  await run(directory, [fixtures[2]], async (_, options) => {
    calls++; assert.equal(JSON.parse(options.body).max_tokens, 8192); return response(fixtures[2]);
  }, {authorization: thirdAuthorization});
  const after = await inspectLedger(directory);
  assert.equal(calls, 1); assert.equal(after.requestCount, 3); assert.equal(after.exposureMicroUsd, 750000);
  assert.deepEqual(after.entries.slice(0, 2), before.entries);
  assert.deepEqual(after.continuationHistory.slice(0, 1), before.continuationHistory);
  assert.equal(after.policyMigrationHistory.length, 1);
  assert.equal(after.policyMigrationHistory[0].previousPolicyDigest, LEGACY_OUTPUT_POLICY_DIGEST);
  assert.equal(after.policyMigrationHistory[0].nextMaxOutputTokens, 8192);
  assert.equal(after.stopReason, 'AUTHORIZED_SINGLE_CONTINUATION_COMPLETE');
  await rejectsCode(run(directory, [fixtures[2]], async () => {calls++;}, {authorization: thirdAuthorization}), 'CONTINUATION_SCOPE_REJECTED');
  assert.equal(calls, 1);
}));
test('legacy output policy does not migrate or read credentials without exact third-only scope', async () => context(async directory => {
  await seedLegacyTwoAttempts(directory);
  const before = await readFile(path.join(directory, 'round-ledger.json'), 'utf8'); let calls = 0; let reads = 0;
  for (const selected of [fixtures.slice(1), [fixtures[0]]]) {
    await rejectsCode(run(directory, selected, () => {calls++;}, {authorization: thirdAuthorization, getKey: () => {reads++; return credential;}}), 'CONTINUATION_SCOPE_REJECTED');
  }
  await rejectsCode(run(directory, [fixtures[2]], () => {calls++;}), 'ROUND_ALREADY_STOPPED');
  await rejectsCode(run(directory, [fixtures[2]], () => {calls++;}, {authorization: {...thirdAuthorization,
    singleContinuation: {...thirdAuthorization.singleContinuation, maxOutputTokens: 16384}}}), 'CONTINUATION_SCOPE_REJECTED');
  assert.equal(calls, 0); assert.equal(reads, 0);
  assert.equal(await readFile(path.join(directory, 'round-ledger.json'), 'utf8'), before);
}));
test('third-case API error stops once and preserves USD 0.75 reserve and the original two entries', async () => context(async directory => {
  const before = await seedLegacyTwoAttempts(directory); let calls = 0;
  await rejectsCode(run(directory, [fixtures[2]], async () => {calls++; return new Response('Synthetic failure', {status: 503});},
    {authorization: thirdAuthorization}), 'API_ERROR');
  const after = await inspectLedger(directory);
  assert.equal(calls, 1); assert.equal(after.requestCount, 3); assert.equal(after.exposureMicroUsd, 750000);
  assert.deepEqual(after.entries.slice(0, 2), before.entries); assert.equal(after.stopReason, 'API_ERROR');
}));
test('interruption after clearing a stop cannot silently resume the continuation', async () => context(async directory => {
  await seedLegacyTwoAttempts(directory);
  const state = await inspectLedger(directory); state.stopReason = null;
  await writeFile(path.join(directory, 'round-ledger.json'), JSON.stringify(state)); let reads = 0;
  await rejectsCode(run(directory, [fixtures[2]], () => {throw Error('Must not dispatch');},
    {authorization: thirdAuthorization, getKey: () => {reads++; return credential;}}), 'CONTINUATION_RESUME_REQUIRES_RECONCILIATION');
  assert.equal(reads, 0);
}));

const fourthAuthorization={...authorization,singleContinuation:{approved:true,expectedRequestCount:3,
  previousStopReason:'EXTRACTION_QUOTE_REJECTED',singleCaseId:'segment-ids-new-closure',maxCumulativeRequests:4,
  outputPolicyVersion:2,maxOutputTokens:8192,evidenceContractVersion:1,previousPolicyDigest:PRE_SEGMENT_POLICY_DIGEST}};
async function seedLegacyThreeAttempts(directory){
  await seedLegacyTwoAttempts(directory);
  await rejectsCode(run(directory,[fixtures[2]],async()=>response(fixtures[2],body=>{
    body.choices[0].message.content=JSON.stringify({selections:[{sourceId:'route',segmentId:'route-'+'0'.repeat(24)}]});
  }),{authorization:thirdAuthorization}),'SEGMENT_ID_UNKNOWN');
  const state=await inspectLedger(directory);
  // Explicit synthetic representation of the previous quotation-contract ledger, never a recovered response.
  state.policyDigest=PRE_SEGMENT_POLICY_DIGEST;delete state.evidenceContractVersion;
  state.stopReason='EXTRACTION_QUOTE_REJECTED';state.entries[2].errorCode='EXTRACTION_QUOTE_REJECTED';
  await writeFile(path.join(directory,'round-ledger.json'),JSON.stringify(state));return structuredClone(state);
}
test('fourth-only contract migration preserves all three records and assembles actual source text',async()=>context(async directory=>{
  const before=await seedLegacyThreeAttempts(directory);let calls=0;
  await run(directory,[fourthFixture],async(_,options)=>{
    calls++;const body=JSON.parse(options.body);assert.equal(body.max_tokens,8192);assert.equal(body.reasoning_effort,'low');
    const payload=JSON.parse(body.messages[1].content);assert(payload.sources.every(s=>s.text===undefined&&Array.isArray(s.segments)));
    return response(fourthFixture);
  },{authorization:fourthAuthorization});
  const after=await inspectLedger(directory);assert.equal(calls,1);assert.equal(after.requestCount,4);assert.equal(after.reservedTotalMicroUsd,1000000);
  assert.deepEqual(after.entries.slice(0,3),before.entries);assert.deepEqual(after.continuationHistory.slice(0,2),before.continuationHistory);
  assert.equal(after.evidenceContractMigrationHistory.length,1);assert.equal(after.entries[3].evidenceContractVersion,1);
  assert(after.entries[3].apiResponseBodyElapsedMs>=0);
  const table=JSON.parse(await readFile(path.join(directory,'segment-ids-new-closure-source-segments.json'),'utf8'));
  assert.equal(table.promptVersion,1);assert(table.segments.some(s=>!s.selectable));
  const review=JSON.parse(await readFile(path.join(directory,'segment-ids-new-closure-review.json'),'utf8'));
  assert.equal(review.brief.claims[0].quote,fourthFixture.requiredQuotes[0].text);
  assert.equal(review.brief.claims[1].quote,fourthFixture.requiredQuotes[1].text);assert.equal(review.humanReviewRequired,true);
  await rejectsCode(run(directory,[fourthFixture],async()=>{calls++;},{authorization:fourthAuthorization}),'CONTINUATION_SCOPE_REJECTED');assert.equal(calls,1);
}));
test('fourth-only authorization rejects broad batches, old inputs and wrong evidence version before credentials',async()=>context(async directory=>{
  await seedLegacyThreeAttempts(directory);const before=await readFile(path.join(directory,'round-ledger.json'),'utf8');let reads=0,calls=0;
  for(const selected of [[fixtures[2]],[fourthFixture,fixtures[0]]])await rejectsCode(run(directory,selected,()=>{calls++;},
    {authorization:fourthAuthorization,getKey:()=>{reads++;return credential;}}),'CONTINUATION_SCOPE_REJECTED');
  await rejectsCode(run(directory,[fourthFixture],()=>{calls++;},{authorization:{...fourthAuthorization,
    singleContinuation:{...fourthAuthorization.singleContinuation,evidenceContractVersion:2}}}),'CONTINUATION_SCOPE_REJECTED');
  await rejectsCode(run(directory,[fourthFixture],()=>{calls++;}),'ROUND_ALREADY_STOPPED');
  assert.equal(reads,0);assert.equal(calls,0);assert.equal(await readFile(path.join(directory,'round-ledger.json'),'utf8'),before);
}));
test('fourth API error dispatches once and retains all four reserves without changing old records',async()=>context(async directory=>{
  const before=await seedLegacyThreeAttempts(directory);let calls=0;
  await rejectsCode(run(directory,[fourthFixture],async()=>{calls++;return new Response('Synthetic failure',{status:503});},
    {authorization:fourthAuthorization}),'API_ERROR');
  const after=await inspectLedger(directory);assert.equal(calls,1);assert.equal(after.requestCount,4);assert.equal(after.exposureMicroUsd,1000000);
  assert.deepEqual(after.entries.slice(0,3),before.entries);assert.equal(after.stopReason,'API_ERROR');
}));
test('a selected source override ID stops the fourth response before a brief is exported',async()=>context(async directory=>{
  await seedLegacyThreeAttempts(directory);let calls=0;
  const blocked=buildSourceSegments(fourthFixture.input).find(s=>!s.selectable);
  await rejectsCode(run(directory,[fourthFixture],async()=>{calls++;return response(fourthFixture,body=>{
    body.choices[0].message.content=JSON.stringify({selections:[{sourceId:blocked.sourceId,segmentId:blocked.segmentId}]});
  });},{authorization:fourthAuthorization}),'SEGMENT_INSTRUCTION_REJECTED');
  assert.equal(calls,1);assert.equal((await inspectLedger(directory)).requestCount,4);
  await assert.rejects(readFile(path.join(directory,'segment-ids-new-closure-review.json')),{code:'ENOENT'});
}));

const validationPair=allFixtures.slice(4,6);
const validationAuthorization={...authorization,validationContinuation:{approved:true,expectedRequestCount:4,
  previousStopReason:'AUTHORIZED_SINGLE_CONTINUATION_COMPLETE',caseIds:['covered-weather-no-closure','missing-sources-unknown'],
  maximumNewRequests:2,maxCumulativeRequests:6,evidenceContractVersion:1,
  frozenPolicyDigest:'80fc324e662d93c7e35c22be2fabbba0022e55cd069135daccf154bb873cc55f'}};
async function seedFourCompletedPhase(directory){
  await seedLegacyThreeAttempts(directory);
  await run(directory,[fourthFixture],async()=>response(fourthFixture),{authorization:fourthAuthorization});
  return structuredClone(await inspectLedger(directory));
}
test('frozen ID contract handles both unseen normal fixtures with exact positive and missing-data evidence',async()=>context(async directory=>{
  const before=await seedFourCompletedPhase(directory);let calls=0;
  await run(directory,validationPair,async()=>response(validationPair[calls++]),{authorization:validationAuthorization});
  const after=await inspectLedger(directory);assert.equal(calls,2);assert.equal(after.requestCount,6);assert.equal(after.reservedTotalMicroUsd,1500000);
  assert.deepEqual(after.entries.slice(0,4),before.entries);assert.equal(after.stopReason,'AUTHORIZED_VALIDATION_PAIR_COMPLETE');
  for(const item of validationPair){const {brief}=JSON.parse(await readFile(path.join(directory,item.id+'-review.json'),'utf8'));
    for(const r of item.requiredQuotes)assert(brief.claims.some(c=>c.sourceId===r.sourceId&&c.quote===r.text));
    assert.equal(brief.modelGeneratesEvidenceText,false);assert(brief.warnings.some(w=>w.includes('not independently verified')));
  }
  await rejectsCode(run(directory,validationPair,async()=>{calls++;},{authorization:validationAuthorization}),'VALIDATION_PAIR_SCOPE_REJECTED');assert.equal(calls,2);
}));
test('first validation-pair error stops at request five with USD 1.25 retained reserve',async()=>context(async directory=>{
  const before=await seedFourCompletedPhase(directory);let calls=0;
  await rejectsCode(run(directory,validationPair,async()=>{calls++;return new Response('Synthetic failure',{status:503});},
    {authorization:validationAuthorization}),'API_ERROR');
  const after=await inspectLedger(directory);assert.equal(calls,1);assert.equal(after.requestCount,5);assert.equal(after.exposureMicroUsd,1250000);
  assert.deepEqual(after.entries.slice(0,4),before.entries);assert.equal(after.stopReason,'API_ERROR');
  await assert.rejects(readFile(path.join(directory,'missing-sources-unknown-review.json')),{code:'ENOENT'});
}));
test('validation-pair permission rejects reversed, extra and old cases without reading credentials',async()=>context(async directory=>{
  await seedFourCompletedPhase(directory);const before=await readFile(path.join(directory,'round-ledger.json'),'utf8');let calls=0,reads=0;
  for(const selected of [[...validationPair].reverse(),[...validationPair,fourthFixture],[fourthFixture]])
    await rejectsCode(run(directory,selected,()=>{calls++;},{authorization:validationAuthorization,getKey:()=>{reads++;return credential;}}),'VALIDATION_PAIR_SCOPE_REJECTED');
  await rejectsCode(run(directory,validationPair,()=>{calls++;},{authorization:{...validationAuthorization,
    validationContinuation:{...validationAuthorization.validationContinuation,maximumNewRequests:3}}}),'VALIDATION_PAIR_SCOPE_REJECTED');
  assert.equal(calls,0);assert.equal(reads,0);assert.equal(await readFile(path.join(directory,'round-ledger.json'),'utf8'),before);
}));
