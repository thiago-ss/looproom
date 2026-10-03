import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from './runtime.ts';
import { testFixture } from './test-fixtures.ts';

const protocol = `#!/usr/bin/env node
import {createInterface} from 'node:readline';
let count=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id==null)return;
 if(m.method==='never-answer')return;
 let result={};
 if(m.method==='account/read')result={account:{type:'chatgpt',email:'fixture@local.invalid'}};
 if(m.method==='thread/start')result={thread:{id:'thread-'+(++count)},model:m.params.model};
 if(m.method==='turn/start'){
  const threadId=m.params.threadId, text=m.params.input[0].text;
  send({id:m.id,result:{turn:{id:'turn-'+threadId}}});
  setTimeout(()=>{
   send({method:'item/completed',params:{threadId,item:{type:'agentMessage',phase:'commentary',text:'commentary '+text}}});
   send({method:'item/completed',params:{threadId,item:{type:'agentMessage',phase:'final_answer',text}}});
   send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
  },Number(text.split(':')[1])||1);return;
 }
 send({id:m.id,result});
});`;

async function fixture() {
 const dir=await testFixture('looproom-runtime-lifecycle-');
 const binary=join(dir,'codex.mjs');
 await writeFile(binary,protocol,{mode:0o755});
 return {dir,runtime:new Runtime(binary,join(dir,'home'))};
}

test('disconnected requests reject immediately without leaving 45-second pending timers',async()=>{
 const {dir,runtime}=await fixture();
 try {
  await assert.rejects(runtime.request('account/read'),/disconnected/);
  assert.equal(runtime.pending.size,0);
 } finally {runtime.close();await rm(dir,{recursive:true,force:true});}
});

test('closing the runtime promptly rejects in-flight protocol requests',async()=>{
 const {dir,runtime}=await fixture();
 try {
  await runtime.start();
  const rejected=assert.rejects(runtime.request('never-answer'),/closed/);
  assert.equal(runtime.pending.size,1);
  runtime.close();
  await rejected;
  assert.equal(runtime.pending.size,0);
 } finally {runtime.close();await rm(dir,{recursive:true,force:true});}
});

test('late exit from a replaced child cannot disconnect its successor across repeated reconnects',async()=>{
 const {dir,runtime}=await fixture();
 try {
  for(let i=0;i<8;i++){
   await runtime.start();
   const previous=runtime.child!;
   runtime.close();
   await runtime.start();
   assert.notEqual(runtime.child?.pid,previous.pid);
   previous.emit('exit',0,null); // deterministic late OS event from the replaced process
   assert.equal((await runtime.account()).account.type,'chatgpt');
   assert.equal(runtime.pending.size,0);
  }
 } finally {runtime.close();await rm(dir,{recursive:true,force:true});}
});

test('24 turns in four-way interleaved batches retain final output and release all listeners',async()=>{
 const {dir,runtime}=await fixture();
 try {
  const prompts=Array.from({length:24},(_,i)=>'task-'+i+':'+(24-i));
  const result: string[]=[];
  for(let batch=0;batch<prompts.length;batch+=4)result.push(...await Promise.all(prompts.slice(batch,batch+4).map(prompt=>runtime.run({model:'gpt-6-sol',effort:'medium',cwd:dir,prompt,onThread:()=>{},onEvent:()=>{}}))));
  assert.deepEqual(result,prompts);
  assert.equal(runtime.pending.size,0);
  for(const name of ['notification','gate','disconnected'])assert.equal(runtime.listenerCount(name),0);
 } finally {runtime.close();await rm(dir,{recursive:true,force:true});}
});


test('closing during asynchronous startup cannot spawn an orphan or clear the replacement connection',async()=>{
 const {dir,runtime}=await fixture();
 try {
  const startup=runtime.start();
  const rejected=assert.rejects(startup,/closed during startup/);
  runtime.close();
  const replacement=runtime.start();
  await rejected;
  await replacement;
  const child=runtime.child;
  assert.equal((await runtime.account()).account.type,'chatgpt');
  assert.equal(runtime.child,child);
  assert.equal(runtime.pending.size,0);
 }finally{runtime.close();await rm(dir,{recursive:true,force:true});}
});
