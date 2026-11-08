/** Isolated browser acceptance with a protocol fixture, not a model-quality test.
 * Run after `npm run build`: node tools/llamacpp-e2e.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-browser-"));
const base = "http://127.0.0.1:3335";
const exe = path.join(dir, "fixture llama");
fs.writeFileSync(exe, `#!${process.execPath}
const http=require('node:http'); const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('version: 11960 (fixture)'); process.exit(); }
if(args.includes('--help')) { console.log('--model --hf-repo --hf-file --alias --host --port --metrics --reasoning --temp --gpu-layers'); process.exit(); }
console.log('loading model'); let count=0;
const server=http.createServer((req,res)=>{
 if(req.url==='/health') return res.end(JSON.stringify({status:'ok'}));
 if(req.url==='/metrics') return res.end('llamacpp:tokens_predicted_total '+count+'\\nllamacpp:prompt_tokens_total 10\\nllamacpp:requests_processing 0\\nllamacpp:requests_deferred 0');
 let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
  const request=JSON.parse(body); console.log('chat request '+request.model);
  if(!request.stream) return res.end(JSON.stringify({choices:[{message:{content:'Fixture response'}}]}));
  res.writeHead(200,{'content-type':'text/event-stream'});
  let i=0; const timer=setInterval(()=>{ res.write('data: '+JSON.stringify({choices:[{delta:{content:i++===0?'Fixture response ':' token '}}]})+'\\n\\n'); count++;
   if(i>=30){ clearInterval(timer);res.end('data: [DONE]\\n\\n'); }
  },100); res.on('close',()=>clearInterval(timer));
 });
});server.listen(Number(args[args.indexOf('--port')+1]),args[args.indexOf('--host')+1]);
process.on('SIGINT',()=>server.close(()=>process.exit()));
`);
fs.chmodSync(exe, 0o755);
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ vllmBinDir: null, guidellmBinDir: null, llamaExecutable: null, portRangeStart: 19300, portRangeEnd: 19320 }));
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3335"], { env: { ...process.env, VLLM_ADMIN_DATA_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; app.stdout.on("data", c => output += c); app.stderr.on("data", c => output += c);
let browser;
const json = async (url, body) => { const r = await fetch(base + url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined); const data = await r.json(); assert(r.ok, JSON.stringify(data)); return data; };
try {
 for(let i=0;i<100;i++){ try { if((await fetch(base)).ok) break; } catch {} await new Promise(r=>setTimeout(r,200)); }
 browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? path.join(os.homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"), headless: true, args: ["--no-sandbox"] });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
 page.setDefaultTimeout(30000);
 const errors=[]; page.on("pageerror", e=>errors.push(e.message));
 await page.goto(base + "/settings");
 await page.getByLabel("Executable path (blank: discover on PATH)").fill(exe);
 await page.getByLabel("Invocation mode").selectOption("serve");
 await page.getByLabel("llama.cpp cache directory").fill(dir);
 await page.getByRole("button", { name: /save settings/i }).click();
 await page.getByText("saved", { exact: true }).waitFor();
 await page.goto(base + "/deployments/new?backend=llamacpp");
 await page.getByRole("button", { name: "LFM3-Omni preset" }).click();
 await page.getByLabel("name", { exact: true }).fill("Browser LFM fixture");
 await page.getByRole("button", { name: "save profile", exact: true }).click();
 await page.waitForURL("**/deployments");
 const profile = (await json("/api/deployments")).profiles[0];
 assert.equal(profile.backend,"llamacpp"); assert.equal(profile.modelSource.quantization,"Q4_K_M");
 await page.getByRole("button", { name: "edit", exact:true }).click();
 await page.getByLabel("served as").fill("browser-model");
 await page.getByRole("button", { name: "save changes" }).click();
 await page.waitForURL("**/deployments");
 await page.getByRole("button", { name: "start", exact:true }).click();
 await page.getByRole("link", { name:"browser-model", exact:true }).click();
 await page.getByLabel("message").waitFor();
 await page.waitForFunction(()=>!document.querySelector('[aria-label="message"]').disabled);
 await page.getByLabel("message").fill("Hello"); await page.getByLabel("message").press("Enter");
 await page.getByText("Fixture response",{exact:false}).first().waitFor();
 await page.getByRole("button", { name:"stop", exact:true }).last().click();
 await page.getByRole("button", { name:"restart", exact:true }).click();
 await page.getByText("engine", { exact:true }).waitFor();
 await page.getByText("preemptions", { exact:true }).waitFor();
 await page.screenshot({path:path.join(dir,"acceptance.png"),fullPage:true});
 // Exercise local CPU-only source with a second simultaneous deployment.
 const local=path.join(dir,"local model.gguf");fs.writeFileSync(local,"fixture");
 const run=await json("/api/deployments/start",{backend:"llamacpp",name:"local CPU",model:local,modelSource:{kind:"local"},flags:{"gpu-layers":0}});
 await json("/api/deployments/stop",{runId:run.runId});
 await page.getByRole("button", { name:"stop", exact:true }).click();
 assert.deepEqual(errors,[]);
 console.log("Browser acceptance passed: configure, save/edit, launch, streaming chat, cancel, restart, local CPU source.");
 console.log("Screenshot: "+path.join(dir,"acceptance.png"));
} catch(e) { console.error(output); throw e; }
finally {
 try { for(const d of JSON.parse(fs.readFileSync(path.join(dir,"supervised.json"),"utf8"))) await json("/api/deployments/stop", {runId:d.runId}); } catch {}
 // The isolated PID file records only processes created by this test.
 try { for(const d of JSON.parse(fs.readFileSync(path.join(dir,"supervised.json"),"utf8"))) {try{process.kill(-d.pid,"SIGKILL");}catch{}} } catch {}
 await browser?.close(); app.kill("SIGTERM");
}
