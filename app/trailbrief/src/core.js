import { z } from 'zod';
import {assembleSelection, buildSourceSegments, SEGMENT_SYSTEM_PROMPT, EVIDENCE_CONTRACT_VERSION} from './segments.js';
export const sourceSchema = z.object({id:z.enum(['route','weather']),label:z.string().trim().min(1).max(120),url:z.string().url().max(2000).refine(s=>/^https?:\/\//.test(s),'Use an http or https source URL'),text:z.string().trim().min(20).max(10000),observedAt:z.string().datetime({offset:true})});
export const inputSchema = z.object({title:z.string().trim().min(1).max(100),departure:z.string().datetime({offset:true}),mode:z.enum(['demo','model']).default('demo'),sources:z.array(sourceSchema).length(2)}).refine(v=>new Set(v.sources.map(s=>s.id)).size===2,'Provide one route and one weather source');
export const claimSchema=z.object({sourceId:z.enum(['route','weather']),quote:z.string().min(1).max(1000)});
export const extractionSchema=z.object({claims:z.array(claimSchema).min(1).max(8),questions:z.array(z.string().min(1).max(300)).max(6)});
export function normalizeInput(raw,now=new Date()) {
 const input=inputSchema.parse(raw); const warnings=[];
 for(const s of input.sources){const age=now-new Date(s.observedAt);if(age< -300000)warnings.push(`${s.label}: source timestamp is in the future.`);if(age>24*3600000)warnings.push(`${s.label}: source snapshot is more than 24 hours old.`);}
 if(new Date(input.departure)<now)warnings.push('Departure is in the past. Update the plan before using it.');
 warnings.push('Source dates are supplied by you and are not independently verified.','Weather coverage, route conditions and closures must be checked with official sources before departure.');
 return {...input,warnings};
}
export function demoExtract(input){return {claims:input.sources.map(s=>({sourceId:s.id,quote:s.text.split(/\n/).map(x=>x.trim()).filter(Boolean)[0].slice(0,1000)})),questions:['Does the weather forecast cover your departure time and the full route?','Have you checked current closures, daylight and return transport?']};}
export function verifyExtraction(raw,input){
 const data=extractionSchema.parse(raw);
 for(const c of data.claims){const source=input.sources.find(s=>s.id===c.sourceId);if(!source||!source.text.includes(c.quote))throw new Error('The model returned a quotation absent from its cited source. Nothing was published.');}
 return data;
}
export function verifySelection(raw,input){const assembled=assembleSelection(raw,input);verifyExtraction(assembled,input);return assembled;}
export async function modelExtract(input,{env=process.env,fetchFn=fetch}={}){
 if(!env.TRAILBRIEF_API_BASE||!env.TRAILBRIEF_MODEL)throw new Error('Model mode is not configured. Use the labeled demo or configure a provider on the server.');
 const base=new URL(env.TRAILBRIEF_API_BASE);if(base.username||base.password||base.search||base.hash)throw new Error('Provider URL must not contain credentials, query parameters or fragments.');if(base.protocol!=='https:'&&!(['localhost','127.0.0.1','[::1]'].includes(base.hostname)&&base.protocol==='http:'))throw new Error('Provider must use HTTPS or a loopback HTTP endpoint.');
 const maxTokens=Number(env.TRAILBRIEF_MAX_OUTPUT_TOKENS||2048);
 if(!Number.isInteger(maxTokens)||maxTokens<128||maxTokens>8192)throw new Error('Output token limit must be an integer between 128 and 8192.');
 const effort=env.TRAILBRIEF_REASONING_EFFORT;if(effort&&!['low','medium','high','max','xhigh'].includes(effort))throw new Error('Invalid reasoning effort.');
 const table=buildSourceSegments(input);
 const sources=input.sources.map(({text,...source})=>({...source,segments:table.filter(s=>s.sourceId===source.id)}));
 const requestBody=JSON.stringify({model:env.TRAILBRIEF_MODEL,temperature:0,max_tokens:maxTokens,...(effort?{reasoning_effort:effort}:{}),messages:[{role:'system',content:SEGMENT_SYSTEM_PROMPT},{role:'user',content:JSON.stringify({title:input.title,departure:input.departure,sources})}]});
 if(env.TRAILBRIEF_MAX_REQUEST_BYTES&&Buffer.byteLength(requestBody)>Number(env.TRAILBRIEF_MAX_REQUEST_BYTES))throw new Error('Request exceeds the verified billing envelope.');
 const response=await fetchFn(`${base.href.replace(/\/$/,'')}/chat/completions`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',...(env.TRAILBRIEF_API_KEY?{Authorization:`Bearer ${env.TRAILBRIEF_API_KEY}`}:{})},body:requestBody});
 if(!response.ok)throw new Error(`Provider request failed (${response.status}). Try again or use demo mode.`);
 const body=await response.json();const text=body.choices?.[0]?.message?.content;if(typeof text!=='string')throw new Error('Provider returned no text.');
 try{return JSON.parse(text);}catch{throw new Error('Provider output was not valid JSON. No brief was created.');}
}
export function finishBrief(input,extraction){const checked=input.mode==='model'?verifySelection(extraction,input):verifyExtraction(extraction,input);return {title:input.title,departure:input.departure,generatedAt:new Date().toISOString(),mode:input.mode,modeLabel:input.mode==='demo'?'DETERMINISTIC DEMO · No AI call':'MODEL-SELECTED SEGMENT IDS · Deterministic source quotes · Verify before use',evidenceContractVersion:input.mode==='model'?EVIDENCE_CONTRACT_VERSION:null,modelGeneratesEvidenceText:false,claims:checked.claims,questions:checked.questions,warnings:input.warnings,sources:input.sources,checklist:['Check official closures and a current forecast.','Carry an offline map, water, layers and a charged phone.','Tell someone your route and expected return time.'],disclaimer:'A planning aid, not navigation, live weather, or a safety assessment. Missing evidence does not mean safe conditions.'};}
export function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function renderBrief(b){const h=escapeHtml;return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(b.title)} · TrailBrief</title><style>body{font:17px/1.6 system-ui;max-width:760px;margin:40px auto;padding:0 24px;color:#173d31;background:#fcfaf3}h1{font-size:42px}h2{margin-top:32px}blockquote{margin:16px 0;padding:16px;border-left:4px solid #42745a;background:#edf2e8}small{display:block}a{color:#235d45}li{margin:8px 0}footer{border-top:1px solid #b9c8b8;margin-top:35px;padding-top:20px}@media print{body{font-size:12px;margin:0}h1{font-size:26px}}</style><p>TRAILBRIEF / POCKET EDITION</p><h1>${h(b.title)}</h1><p>${h(b.modeLabel)}</p><p>Departure: ${h(b.departure)}<br>Created: ${h(b.generatedAt)}</p><h2>Evidence to take with you</h2>${b.claims.map(c=>`<blockquote>${h(c.quote)}<small>Source: ${h(c.sourceId)}</small></blockquote>`).join('')}<h2>Uncertainties & checks</h2><ul>${[...b.warnings,...b.questions].map(x=>`<li>${h(x)}</li>`).join('')}</ul><h2>Before you leave</h2><ul>${b.checklist.map(x=>`<li>${h(x)}</li>`).join('')}</ul><h2>Source snapshots</h2>${b.sources.map(s=>`<p><a href="${h(s.url)}" rel="noreferrer">${h(s.label)}</a><br>Recorded: ${h(s.observedAt)}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${h(s.text)}</pre>`).join('')}<footer>${h(b.disclaimer)}<p>This file is self-contained. Source links require internet.</p></footer></html>`;}
