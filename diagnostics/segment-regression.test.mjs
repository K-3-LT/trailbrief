import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectionSchema,buildSourceSegments} from '../app/trailbrief/src/segments.js';
import {verifySelection} from '../app/trailbrief/src/core.js';
import {diagnoseExtraction,diagnoseSelection} from '../controller/extraction-diagnostics.mjs';
const cases=JSON.parse(await readFile(new URL('../controller/cases.json',import.meta.url),'utf8'));
const second=JSON.parse(await readFile(new URL('../evidence/second-case-assistant-diagnostic.json',import.meta.url),'utf8'));
const third=JSON.parse(await readFile(new URL('../evidence/third-case-assistant-diagnostic.json',import.meta.url),'utf8'));

test('saved second real response remains incomplete with empty text; no historical IDs are invented',()=>{
  assert.equal(second.finishReason,'length');assert.equal(second.assistantText,'');
  assert.throws(()=>JSON.parse(second.assistantText));
});
test('saved third real response remains a rejected legacy quotation and is not converted to ID output',()=>{
  assert.equal(third.finishReason,'stop');const raw=JSON.parse(third.assistantText);
  const legacy=diagnoseExtraction(raw,cases[2].input);
  assert.equal(legacy.code,'EXTRACTION_QUOTE_REJECTED');assert.deepEqual(legacy.path,['claims',1,'quote']);
  assert.equal(selectionSchema.safeParse(raw).success,false);
  assert.equal(diagnoseSelection(raw,cases[2].input).code,'SEGMENT_SELECTION_SCHEMA_REJECTED');
});
test('hand-authored ID mocks for the original fixtures preserve closures, unknown weather and injection isolation',()=>{
  for(const item of cases.slice(0,3)){
    const table=buildSourceSegments(item.input);
    const mock={selections:item.requiredQuotes.map(r=>{
      const s=table.find(s=>s.sourceId===r.sourceId&&s.text.includes(r.text));return {sourceId:s.sourceId,segmentId:s.segmentId};
    })}; // This is newly authored offline input, never a recovered real response.
    const assembled=verifySelection(mock,item.input);
    for(const r of item.requiredQuotes)assert(assembled.claims.some(c=>c.sourceId===r.sourceId&&c.quote.includes(r.text)));
    assert(assembled.claims.every(c=>item.input.sources.find(s=>s.id===c.sourceId).text.includes(c.quote)));
    assert(assembled.claims.every(c=>(item.forbiddenQuoteFragments||[]).every(f=>!c.quote.includes(f))));
  }
});
