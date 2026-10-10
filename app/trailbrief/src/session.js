import {randomBytes} from 'node:crypto';
export const PROVIDER_BASE='https://api.iteracompute.com/v1';
export const PROVIDER_MODEL='deepseek/deepseek-v4.1-flash';
export const MAX_BUDGET_USD=10;
// A verified policy must bound the entire bill for one attempt, including reasoning,
// input, failed requests, conversion and all fees. No public price table alone does so.
export function validBillingPolicy(p){return !!(p?.verified===true&&p.routingVerified===true&&typeof p.routingEvidence==='string'&&p.routingEvidence.length>=10&&typeof p.evidence==='string'&&p.evidence.length>=10&&Number.isSafeInteger(p.maxChargeCents)&&p.maxChargeCents>0&&p.maxChargeCents<=1000&&p.maxRequestBytes===4096&&p.maxOutputTokens===8192);}
export function createSessionStore({billingPolicy=null,now=()=>Date.now(),ttlMs=20*60*1000}={}){
 const sessions=new Map();const ledger={spentReservedCents:0,attempts:0,inFlight:false};
 const destroy=id=>{const s=sessions.get(id);if(s){clearTimeout(s.timer);s.key='';sessions.delete(id);}};
 function get(id){const s=sessions.get(id);if(!s)return null;if(now()>=s.expiresAt){destroy(id);return null;}return s;}
 return {
 ready:()=>validBillingPolicy(billingPolicy),
 create(key){if(!validBillingPolicy(billingPolicy))throw Error('Real calls are locked: verified all-in billing bounds or a provider-enforced budget are required first.');if(typeof key!=='string'||key.length<8||key.length>512||/[\s\r\n]/.test(key))throw Error('Enter a valid API key without spaces.');const id=randomBytes(32).toString('hex');const s={key,expiresAt:now()+ttlMs};s.timer=setTimeout(()=>destroy(id),ttlMs);s.timer.unref?.();sessions.set(id,s);return id;},
 status(id){const s=get(id);return s?{active:true,remainingUsd:(1000-ledger.spentReservedCents)/100,attemptsRemaining:20-ledger.attempts,expiresAt:new Date(s.expiresAt).toISOString()}: {active:false};},
 async run(id,input,operation){const s=get(id);if(!s)throw Error('Temporary provider session is missing or expired.');if(!validBillingPolicy(billingPolicy))throw Error('Real calls remain locked.');if(ledger.inFlight)throw Error('One model request is already running.');if(ledger.attempts>=20||ledger.spentReservedCents+billingPolicy.maxChargeCents>1000)throw Error('Session budget or attempt limit reached. Start no further requests.');if(Buffer.byteLength(JSON.stringify(input),'utf8')>2500)throw Error('This budgeted test accepts at most 2500 UTF-8 bytes of trip input.');ledger.inFlight=true;ledger.attempts++;ledger.spentReservedCents+=billingPolicy.maxChargeCents;try{return await operation({TRAILBRIEF_API_BASE:PROVIDER_BASE,TRAILBRIEF_MODEL:PROVIDER_MODEL,TRAILBRIEF_API_KEY:s.key,TRAILBRIEF_MAX_OUTPUT_TOKENS:'8192',TRAILBRIEF_MAX_REQUEST_BYTES:'4096',TRAILBRIEF_REASONING_EFFORT:'low'});}finally{ledger.inFlight=false;/* Never refund an ambiguous/failed request: it may have been billed. */}},
 destroy,
 close(){for(const id of sessions.keys())destroy(id);}
 };
}
