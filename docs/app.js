'use strict';
const data=window.TRAILBRIEF_RECORDS;
const $=id=>document.getElementById(id);
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const labels={1:'1 · First quotation attempt — rejected, body unavailable',2:'2 · Quotation attempt — truncated empty answer',3:'3 · Quotation attempt — altered quote rejected',4:'4 · IDs — closure + unknown forecast, accepted',5:'5 · IDs — supplied coverage + no closure, accepted',6:'6 · IDs — missing information, transport error'};
const outcomes={1:'Aggregate extraction failure; original body unavailable',2:'Completion allowance exhausted; empty answer',3:'One weather quotation was rewritten',4:'IDs verified; source text copied exactly',5:'IDs verified; supplied access/coverage evidence retained',6:'No body or usage; transport failure, possible charge unresolved'};
const statusText=record=>record.acceptedBrief?'Accepted recorded result':record.state==='uncertain'?'Uncertain transport result':'Rejected recorded result';

for(const record of data.records){const option=node('option',labels[record.attempt]);option.value=String(record.attempt);$('case-picker').append(option);const row=document.createElement('tr');for(const value of [record.attempt,record.evidenceContract,statusText(record),outcomes[record.attempt]])row.append(node('td',String(value)));$('history').append(row);}
$('cost-note').textContent=`Known reported-usage estimate: $${data.knownReportedUsageEstimateUsd.toFixed(6)} across attempts 1–5. Attempt 6 has unknown usage and possible charges. Retained reserve: $${data.retainedReserveUsd.toFixed(2)}; reserve is not actual spending. None of these estimates is a final invoice.`;

function render(record){
  $('run-status').textContent=statusText(record);$('run-status').className=record.acceptedBrief?'pill':'pill failure';
  $('run-model').textContent=`${record.requestedModel} · low · ${record.maxOutputTokens} max output tokens`;
  $('run-time').textContent=record.apiResponseBodyElapsedMs===null?'Complete-response API timing unavailable':`API request → complete body: ${(record.apiResponseBodyElapsedMs/1000).toFixed(3)} s`;
  $('brief-heading').textContent=record.input.title;$('departure').textContent=`Synthetic planned departure: ${record.input.departure}`;
  const brief=record.acceptedBrief;$('accepted-panel').hidden=!brief;$('failed-panel').hidden=!!brief;
  $('claims').replaceChildren();$('questions').replaceChildren();$('warnings').replaceChildren();
  if(brief){for(const claim of brief.claims){const block=node('blockquote',claim.quote);block.append(node('small',`${claim.sourceId} · ${claim.segmentId}`));$('claims').append(block);}for(const text of brief.questions)$('questions').append(node('li',text));for(const text of brief.warnings)$('warnings').append(node('li',text));$('download-html').href=`./briefs/${record.caseId}.html`;$('download-json').href=`./briefs/${record.caseId}.json`;}
  else $('failure-message').textContent=`${record.errorCode}. ${record.bodyAvailability}`;
  const steps=brief?['Validate the two supplied synthetic snapshots','Send the bounded source segment table to the model','Receive only sourceId/segmentId selections','Verify IDs, ownership, duplicates and instruction flags','Copy original source slices; add fixed checks','Retain the accepted brief for human review']:['Validate the supplied synthetic snapshots',`Dispatch one real request (attempt ${record.attempt})`,`Stop: ${record.errorCode}`,'No accepted brief, fallback or retry'];
  $('trace-steps').replaceChildren(...steps.map(text=>node('li',text)));
  $('assistant-output').textContent=record.assistantObservation?.assistantText===undefined?record.bodyAvailability:record.assistantObservation.assistantText===''?'[Recorded assistant text is empty]':record.assistantObservation.assistantText;
  $('usage').textContent=JSON.stringify({attempt:record.attempt,finishReason:record.finishReason,usage:record.usage,apiResponseBodyElapsedMs:record.apiResponseBodyElapsedMs,attemptSeconds:record.attemptSeconds,conventionalCostEstimateUsd:record.conventionalCostEstimateUsd,conservativeCostEstimateUsd:record.conservativeCostEstimateUsd,costIsFinalInvoice:false},null,2);
  $('expectations').replaceChildren(...record.expectedEvidence.map(e=>node('p',`${e.sourceId}: ${e.text}`,'small')));
  $('source-snapshots').replaceChildren();for(const source of record.input.sources){const box=node('article',undefined,'snapshot');box.append(node('h3',`${source.id} / ${source.label}`),node('p',`Supplied timestamp: ${source.observedAt} · Fixture URL: ${source.url}`,'small'),node('pre',source.text));$('source-snapshots').append(box);}
  $('segments').replaceChildren();if(record.sourceSegments){for(const segment of record.sourceSegments){const box=node('div',undefined,'segment');box.append(node('code',`${segment.sourceId} / ${segment.segmentId} · original positions ${segment.start}–${segment.end} · ${segment.selectable?'selectable':'blocked override directive'}`,segment.selectable?'':'blocked'),node('p',segment.text));$('segments').append(box);}}else $('segments').append(node('p','The legacy quotation contract did not use a segment table.','small'));
}
$('case-picker').value='4';render(data.records.find(r=>r.attempt===4));
$('case-picker').addEventListener('change',()=>render(data.records.find(r=>r.attempt===Number($('case-picker').value))));
