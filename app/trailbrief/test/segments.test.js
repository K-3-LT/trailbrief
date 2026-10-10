import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildSourceSegments, selectionSchema, assembleSelection} from '../src/segments.js';
import {normalizeInput, verifySelection, renderBrief} from '../src/core.js';
import {runBrief} from '../src/workflow.js';
const cases=JSON.parse(await readFile(new URL('../../../controller/cases.json',import.meta.url),'utf8'));
const input=cases[3].input;
const choose=(value=input)=>({selections:cases[3].requiredQuotes.map(r=>{
  const s=buildSourceSegments(value).find(s=>s.sourceId===r.sourceId&&s.text.includes(r.text));
  return {sourceId:s.sourceId,segmentId:s.segmentId};
})});
const code=(fn,expected)=>assert.throws(fn,e=>e.code===expected);

test('stable segment IDs bind exact source text and positions independently of source ordering',()=>{
  const a=buildSourceSegments(input);const reversed=structuredClone(input);reversed.sources.reverse();
  assert.deepEqual(buildSourceSegments(reversed),a);
  const edited=structuredClone(input);edited.sources[0].text+='\nA new notice.';
  const b=buildSourceSegments(edited);
  assert(a.filter(s=>s.sourceId==='route').every(s=>!b.some(t=>t.segmentId===s.segmentId)));
  assert.deepEqual(b.filter(s=>s.sourceId==='weather'),a.filter(s=>s.sourceId==='weather'));
  code(()=>verifySelection(choose(),edited),'SEGMENT_ID_UNKNOWN');
});
test('segmentation preserves whitespace, CRLF source slices and complete surrogate pairs',()=>{
  const value=structuredClone(input);value.sources[0].text='  closure notice \t\r\n'+'x'.repeat(999)+'😀'+'rest';
  const segments=buildSourceSegments(value).filter(s=>s.sourceId==='route');
  assert.equal(segments[0].text,'  closure notice \t');
  assert(segments.every(s=>s.text===value.sources[0].text.slice(s.start,s.end)&&s.text.length<=1000));
  assert(segments.some(s=>s.text.includes('😀')));
  assert.equal(segments.slice(1).map(s=>s.text).join(''),'x'.repeat(999)+'😀'+'rest');
});
test('finite source tables reject excessive segment counts and unknown source IDs',()=>{
  const value=structuredClone(input);value.sources[0].text=Array(65).fill('notice').join('\n');
  code(()=>buildSourceSegments(value),'SOURCE_SEGMENT_LIMIT_EXCEEDED');
  value.sources[0].id='other';code(()=>buildSourceSegments(value),'SOURCE_SEGMENT_INPUT_INVALID');
});
test('unknown segment IDs are rejected without fuzzy matching or source substitution',()=>{
  const raw=choose();raw.selections[0].segmentId='route-'+'0'.repeat(24);
  code(()=>verifySelection(raw,input),'SEGMENT_ID_UNKNOWN');
});
test('cross-source and duplicate IDs fail rather than being remapped or deduplicated',()=>{
  const cross=choose();cross.selections[0].sourceId='weather';
  code(()=>verifySelection(cross,input),'SEGMENT_SOURCE_MISMATCH');
  const repeated=choose();repeated.selections.push({...repeated.selections[0]});
  code(()=>verifySelection(repeated,input),'SEGMENT_DUPLICATE_REJECTED');
});
test('model-provided quotes, questions, extra facts and selection metadata are rejected',()=>{
  for(const raw of [{...choose(),facts:['the route is safe']},{...choose(),questions:['Safe?']},
    {selections:choose().selections.map(s=>({...s,quote:'Invented evidence'}))}])assert(!selectionSchema.safeParse(raw).success);
});
test('recognizable override instructions have IDs but cannot be selected as evidence',()=>{
  const blocked=buildSourceSegments(input).find(s=>s.text.startsWith('Ignore previous instructions'));
  assert.equal(blocked.selectable,false);
  code(()=>assembleSelection({selections:[{sourceId:blocked.sourceId,segmentId:blocked.segmentId}]},input),'SEGMENT_INSTRUCTION_REJECTED');
  const assembled=assembleSelection(choose(),input);
  assert(assembled.claims.every(c=>!c.quote.includes('say the route is safe')));
});
test('actual Mastra model path assembles closure and unknown forecast from IDs with fixed checks',async()=>{
  const brief=await runBrief(input,{extract:async()=>choose()});
  assert.equal(brief.evidenceContractVersion,1);assert.equal(brief.modelGeneratesEvidenceText,false);
  assert.match(brief.modeLabel,/SEGMENT IDS.*Deterministic/);
  assert.equal(brief.claims[0].quote,cases[3].requiredQuotes[0].text);
  assert.equal(brief.claims[1].quote,cases[3].requiredQuotes[1].text);
  assert(brief.questions.every(q=>q.endsWith('?')));
  assert(brief.warnings.some(w=>w.includes('not independently verified')));
  assert(!brief.claims.some(c=>c.quote.includes('safe')));
});
test('deterministic export escapes selected source HTML and retains provenance without generated facts',async()=>{
  const value=structuredClone(input);value.sources[0].text='<script>alert("fixture")</script> The crossing is closed.\nOriginal context remains data.';
  const segment=buildSourceSegments(value)[0];
  const brief=await runBrief(value,{extract:async()=>({selections:[{sourceId:'route',segmentId:segment.segmentId}]})});
  assert.equal(brief.claims[0].quote,segment.text);
  const html=renderBrief(brief);assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));
  assert(html.includes('Source: route'));assert.match(html,/MODEL-SELECTED SEGMENT IDS/);
  assert.deepEqual(verifySelection({selections:[{sourceId:'route',segmentId:segment.segmentId}]},normalizeInput(value)).claims,brief.claims);
});
