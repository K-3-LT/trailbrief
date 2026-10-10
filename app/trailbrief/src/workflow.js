import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { normalizeInput,demoExtract,modelExtract,finishBrief } from './core.js';
// The same open-source orchestration runs demo and model modes; only extraction differs.
const bag=z.record(z.string(),z.unknown());
export function createBriefWorkflow({extract=modelExtract,now=()=>new Date()}={}){
 const prepare=createStep({id:'validate-source-snapshots',inputSchema:bag,outputSchema:bag,execute:async({inputData})=>normalizeInput(inputData,now())});
 const select=createStep({id:'select-source-evidence',inputSchema:bag,outputSchema:bag,execute:async({inputData})=>({input:inputData,extraction:inputData.mode==='demo'?demoExtract(inputData):await extract(inputData)})});
 const verify=createStep({id:'verify-quotes-and-build-pocket-brief',inputSchema:bag,outputSchema:bag,execute:async({inputData})=>finishBrief(inputData.input,inputData.extraction)});
 return createWorkflow({id:'trailbrief',inputSchema:bag,outputSchema:bag}).then(prepare).then(select).then(verify).commit();
}
export async function runBrief(raw,options){const run=await createBriefWorkflow(options).createRun();const result=await run.start({inputData:raw});if(result.status!=='success')throw new Error(result.error?.message||'Brief workflow failed. Check input and provider configuration.');return result.result;}
