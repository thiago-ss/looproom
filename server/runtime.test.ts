import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Runtime } from "./runtime.ts";
import { testFixture } from "./test-fixtures.ts";

const fixture = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id==null || !m.method)return;
 let result={};
 if(m.method==='account/read')result={account:{type:'chatgpt',email:'fixture@example.test'}};
 if(m.method==='model/list')result={data:[{model:'gpt-6-sol'}]};
 if(m.method==='thread/start'){if(m.params.config.permissions.looproom.network.enabled!==false||m.params.config.permissions.looproom.filesystem[':root']!=='deny'){send({id:m.id,error:{message:'Incorrect permissions'}});return;} result={thread:{id:'thread'}};}
 if(m.method==='turn/start') {
  if(m.params.model!=='gpt-6-sol'||m.params.effort!=='medium'||m.params.sandboxPolicy){send({id:m.id,error:{message:'Incorrect run contract'}});return;}
  result={turn:{id:'turn'}}; send({id:m.id,result});
  if(m.params.input[0].text==='disconnect'){process.exit(1);return;}
  setTimeout(()=>{
   send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',phase:'commentary',text:'Not final'}}});
   send({method:'item/agentMessage/delta',params:{threadId:'thread',delta:'final'}});
   send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',phase:'final_answer',text:'{"summary":"verified fixture"}'}}});
   send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
  },10);return;
 }
 send({id:m.id,result});
});`;

test("Codex transport applies the requested profile and isolates final output from commentary", async () => {
  const dir = await testFixture("looproom-runtime-");
  const binary = join(dir, "codex.mjs");
  await writeFile(binary, fixture, { mode: 0o755 });
  const runtime = new Runtime(binary, join(dir, "home"));
  try {
    let thread = "",
      delta = "";
    const output = await runtime.run({
      model: "gpt-6-sol",
      effort: "medium",
      cwd: dir,
      prompt: "fixture",
      onThread: (id) => {
        thread = id;
      },
      onEvent: (method, data) => {
        if (method === "item/agentMessage/delta") delta += data.delta;
      },
    });
    assert.equal(thread, "thread");
    assert.equal(delta, "final");
    assert.deepEqual(JSON.parse(output), { summary: "verified fixture" });
    await assert.rejects(
      runtime.run({
        model: "gpt-6-sol",
        effort: "medium",
        cwd: dir,
        prompt: "disconnect",
        onThread: () => {},
        onEvent: () => {},
      }),
      /disconnected/,
    );
  } finally {
    runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
