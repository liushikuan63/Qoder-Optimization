#!/usr/bin/env node
// link-audit.mjs — 官方链接探活（1.0.5）
// 抽取 references 内 https 链接，SSRF 白名单内做 HEAD 探活；失效/阻断即告警。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ALLOWED = ['developers.weixin.qq.com','developer.open-douyin.com','microapp.bytedance.com','partner.open-douyin.com','www.nppa.gov.cn','www.cac.gov.cn','www.samr.gov.cn','mapservice.bnimd.cn','q.qq.com','open.kuaishou.com','opendocs.alipay.com','smartprogram.baidu.com','open.taobao.com','quickapp.cn'];

function walk(dir) { const out=[]; for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name); if(e.isDirectory())out.push(...walk(p)); else if(/\.(md|mjs|json)$/.test(e.name))out.push(p);} return out; }

function liveness(url){ return new Promise(res=>{ const u=new URL(url); const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:'HEAD',timeout:8000,headers:{'User-Agent':'Mozilla/5.0'}},r=>{r.resume();res(r.statusCode<400?'ok':`http-${r.statusCode}`);}); req.on('error',e=>res(`err-${e.code||'x'}`)); req.setTimeout(8000,()=>{req.destroy();res('timeout');}); }); }

async function main(){
  const files=walk(path.join(ROOT,'references')); const urls=new Set();
  for(const f of files){ const c=fs.readFileSync(f,'utf8'); const ms=c.match(/https:\/\/[^\s)"'\]>]+/g)||[]; for(const u of ms){ try{ const h=new URL(u).hostname; if(ALLOWED.includes(h)) urls.add(u); }catch{} } }
  let bad=0;
  for(const u of urls){ const st=await liveness(u); if(st!=='ok'){ bad++; console.log(`[link-bad] ${u} :: ${st}`); } }
  console.log(`\n链接 ${urls.size} 条；失效 ${bad}`);
  process.exit(0); // 仅告警，不阻断（网络受限环境）
}
main();
