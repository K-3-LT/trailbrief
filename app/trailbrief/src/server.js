import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runBrief } from './workflow.js';
import { renderBrief,modelExtract } from './core.js';
import {createSessionStore} from './session.js';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
export function createServer({billingPolicy=null}={}){const sessions=createSessionStore({billingPolicy});const server=http.createServer(async(req,res)=>{
 const sessionId=/trailbrief_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 try{
 if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host||'')){res.writeHead(403);return res.end('Host rejected');}
 if(req.method==='GET'&&req.url==='/api/status'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({modelConfigured:sessions.status(sessionId).active,temporarySessionReady:sessions.ready(),session:sessions.status(sessionId)}));}
 if(req.method==='POST'&&req.url==='/api/session/clear'){
 if(req.headers['x-trailbrief-action']!=='session'||(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)){res.writeHead(403);return res.end('Request rejected');}
 sessions.destroy(sessionId);res.setHeader('Set-Cookie','trailbrief_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({active:false}));
 }
 if(req.method==='POST'&&(req.url==='/api/brief'||req.url==='/api/session')){
 const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`){res.writeHead(403);return res.end('Origin rejected');}
 if(!req.headers['content-type']?.startsWith('application/json')){res.writeHead(415);return res.end('Use application/json');}
 let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>40000){res.writeHead(413);return res.end('Input too large');}}
 if(req.url==='/api/session'){
 if(req.headers['x-trailbrief-action']!=='session'){res.writeHead(403);return res.end('Request rejected');}
 const parsed=JSON.parse(data);const id=sessions.create(parsed.key);parsed.key='';data='';sessions.destroy(sessionId);res.setHeader('Set-Cookie',`trailbrief_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1200`);res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(sessions.status(id)));}
 const input=JSON.parse(data);if(input.mode==='model'&&!sessionId)throw new Error('A verified, temporary provider session is required.');const brief=input.mode==='model'&&sessionId?await sessions.run(sessionId,input,env=>runBrief(input,{extract:value=>modelExtract(value,{env})})):await runBrief(input);res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({brief,html:renderBrief(brief)}));
 }
 if(req.method==='GET'&&files[req.url]){const [file,type]=files[req.url];res.setHeader('Content-Type',`${type}; charset=utf-8`);return res.end(await readFile(root+file));}
 res.writeHead(404);res.end('Not found');
 }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error instanceof SyntaxError?'Invalid JSON request.':error.name==='ZodError'?'Check all fields: valid URLs, ISO timestamps, and source text of at least 20 characters are required.':error.message}));}
 });server.on('close',()=>sessions.close());return server;}
if(process.argv[1]===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT||4317);createServer().listen(port,'127.0.0.1',()=>console.log(`TrailBrief: http://127.0.0.1:${port} (local only)`));}
