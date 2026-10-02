import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from './store.ts';
import {testFixture} from './test-fixtures.ts';

test('HTTP state stays complete through concurrent writes, SSE reconnect and a coordinator restart',async()=>{
 const dir=await testFixture('looproom-state-concurrent-');
 const binary=join(dir,'fixture.mjs'),data=join(dir,'data');
 await writeFile(binary,`#!/usr/bin/env node
import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!=null)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='account/read'?{account:null}:m.method==='model/list'?{data:[]}:{}})+'\\n');});`,{mode:0o755});
 const store=new Store(join(data,'looproom.sqlite'));
 store.put('project',{name:'Concurrent fixture',status:'paused',planned:true,checks:[],constraints:'Human approval'},'fixture-project');
 store.put('run',{projectId:'fixture-project',status:'completed',output:'private full output'},'fixture-run');
 store.close();
 let child:ReturnType<typeof spawn>|undefined;
 async function start(){
  child=spawn(process.execPath,['--import','tsx','server/index.ts'],{env:{...process.env,PORT:'0',LOOPROOM_DATA_DIR:data,CODEX_BINARY:binary},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
  return new Promise<string>((resolve,reject)=>{
   let text='';const timer=setTimeout(()=>reject(Error('Server startup timed out: '+stderr)),10000);
   child!.once('error',error=>{clearTimeout(timer);reject(error);});
   child!.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited: '+stderr));});
   child!.stdout!.on('data',chunk=>{text+=chunk;const match=text.match(/coordinator: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
 }
 async function stop(){if(child?.pid && child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'close');}}
 const streams:AbortController[]=[];
 try{
  let url=await start();
  const initial=await fetch(url+'/api/state'),cookie=initial.headers.get('set-cookie')!.split(';')[0];
  const state=await initial.json();assert.equal(state.projects.length,1);assert.equal('output' in state.runs[0],false);
  assert.equal((await fetch(url+'/api/events',{headers:{cookie:'prefix_'+cookie}})).status,403);
  const controller=new AbortController();streams.push(controller);
  const event=await fetch(url+'/api/events',{headers:{cookie},signal:controller.signal});
  const reader=event.body!.getReader();await reader.read();
  const notices=(async()=>{let text='';while(!text.includes('data: changed\n\n')){const item=await reader.read();assert.equal(item.done,false);text+=new TextDecoder().decode(item.value);}return text;})();
  const headers={cookie,'content-type':'application/json','x-looproom-client':'ui'};
  const writes=await Promise.all(Array.from({length:50},(_,i)=>fetch(url+'/api/projects/fixture-project/messages',{method:'POST',headers,body:JSON.stringify({text:'Concurrent '+i})})));
  assert.ok(writes.every(r=>r.status===200));
  await notices;controller.abort();
  const snapshots=await Promise.all(Array.from({length:40},async()=>await(await fetch(url+'/api/state')).json()));
  for(const snapshot of snapshots){assert.equal(snapshot.messages.length,50);assert.equal(new Set(snapshot.messages.map((m:any)=>m.text)).size,50);assert.equal('output' in snapshot.runs[0],false);}
  assert.equal((await fetch(url+'/api/projects/fixture-project/settings',{method:'POST',headers,body:JSON.stringify({checks:['npm test'],constraints:'Current cached boundary',escalationMode:'human'})})).status,200);
  const updated=await(await fetch(url+'/api/state')).json();assert.equal(updated.projects[0].constraints,'Current cached boundary');
  await stop();url=await start();
  const restart=await fetch(url+'/api/state'),newCookie=restart.headers.get('set-cookie')!.split(';')[0];assert.notEqual(newCookie,cookie);
  assert.equal((await restart.json()).messages.length,50);
  assert.equal((await fetch(url+'/api/events',{headers:{cookie}})).status,403);
  const nextController=new AbortController();streams.push(nextController);
  const reconnect=await fetch(url+'/api/events',{headers:{cookie:newCookie},signal:nextController.signal});assert.equal(reconnect.status,200);await reconnect.body!.getReader().read();nextController.abort();
 }finally{streams.forEach(c=>c.abort());await stop();await rm(dir,{recursive:true,force:true});}
});
