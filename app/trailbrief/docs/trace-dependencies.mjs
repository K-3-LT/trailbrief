import {registerHooks} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const watched=['gray-matter','js-yaml','argparse','sprintf-js'];const hits=[];
registerHooks({resolve(specifier,context,next){const r=next(specifier,context);if(watched.some(name=>r.url.includes(`/node_modules/${name}/`)))hits.push({specifier,resolved:r.url.split('/node_modules/').slice(1).join('/node_modules/'),parent:context.parentURL?.split('/node_modules/').slice(1).join('/node_modules/')||'project'});return r;}});
const {runBrief}=await import('../src/workflow.js');const f=JSON.parse(readFileSync(new URL('./real-model-input.json',import.meta.url)));f.mode='demo';await runBrief(f);f.mode='model';await runBrief(f,{extract:async()=>({claims:[{sourceId:'route',quote:f.sources[0].text.split('\n')[1]}],questions:[]})});
const report={tested:'Actual demo workflow and injected model-path workflow; no real inference',watched,hits,limits:'Module loading is supporting evidence, not proof for untested paths or future versions.'};writeFileSync(new URL('./dependency-trace.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
