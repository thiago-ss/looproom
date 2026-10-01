import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sandboxCheck, exec } from "./git.ts";

// Native denial tests need a sibling worker sandbox: macOS cannot apply a second
// Seatbelt profile from inside the verification sandbox. This socket offers only
// the unchanged worker policy in a disposable job, never caller-supplied policy.
export async function nativeTestBroker(job: string, binary: string) {
  const socketRoot = join("/private/tmp", "lrv-" + randomUUID().slice(0, 16));
  await mkdir(socketRoot, { mode: 0o700 });
  const socket = join(socketRoot, "s"),
    bin = join(job, "bin");
  await mkdir(bin);
  const pending = new Set<Promise<void>>();
  const connections = new Set<Socket>();
  const server = createServer((connection) => {
    connections.add(connection);
    const controller = new AbortController();
    connection.setTimeout(180_000, () => connection.destroy());
    connection.once("close", () => {
      connections.delete(connection);
      controller.abort();
    });
    let text = "";
    connection.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length > 64_000) {
        connection.destroy();
        return;
      }
      if (!text.includes("\n")) return;
      connection.pause();
      const work = (async () => {
        try {
          const request = JSON.parse(text.slice(0, text.indexOf("\n")));
          const args = request.args;
          if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
            throw new Error("Invalid native check request.");
          let result;
          if (args.length === 1 && args[0] === "--version") {
            const version = await exec(binary, ["--version"]);
            result = { code: 0, output: version.stdout };
          } else {
            if (args[0] !== "sandbox")
              throw new Error("Only native sandbox tests are supported.");
            if (args.indexOf("-C") < 0 || !args[args.indexOf("-C") + 1])
              throw new Error("Native test needs a snapshot working directory.");
            const cwd = await realpath(
              resolve(args[args.indexOf("-C") + 1] ?? ""),
            );
            const delimiter = args.indexOf("--"),
              tail = args.slice(delimiter + 1);
            if (
              ![join(job, "workspace"), join(job, "tmp")].some(
                (root) => cwd === root || cwd.startsWith(root + "/"),
              )
            )
              throw new Error(
                "Native test must stay in its verification workspace.",
              );
            if (
              delimiter < 0 ||
              tail.length !== 4 ||
              tail[0] !== "/bin/zsh" ||
              tail[1] !== "-f" ||
              tail[2] !== "-c" ||
              tail[3].length > 12000
            )
              throw new Error("Unsupported native test command.");
            result = await sandboxCheck(
              binary,
              cwd,
              tail[3],
              join(job, "home/native-codex"),
              controller.signal,
            );
          }
          connection.end(JSON.stringify(result));
        } catch (error) {
          connection.end(JSON.stringify({ code: 1, output: String(error) }));
        }
      })();
      pending.add(work);
      work.finally(() => pending.delete(work));
    });
    connection.on("error", () => {});
  });
  try {
  await new Promise<void>((ok, no) => {
    server.once("error", no);
    server.listen(socket, () => {
      server.off("error", no);
      ok();
    });
  });
  await writeFile(
    join(bin, "codex"),
    `#!/usr/bin/env node
const net=require('node:net');
const connection=net.createConnection(${JSON.stringify(socket)});
let data='';
connection.on('connect',()=>connection.write(JSON.stringify({args:process.argv.slice(2)})+'\\n'));
connection.on('data',chunk=>data+=chunk);
connection.on('end',()=>{try{const result=JSON.parse(data);process.stdout.write(result.output);process.exitCode=result.code;}catch{process.exitCode=1;}});
connection.on('error',error=>{console.error(error.message);process.exitCode=1;});
`,
    { mode: 0o755 },
  );
  } catch (error) {
    for (const connection of connections) connection.destroy();
    server.close();
    await rm(socketRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    socket,
    bin,
    async close() {
      for (const connection of connections) connection.destroy();
      await Promise.allSettled([...pending]);
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(socketRoot, { recursive: true, force: true });
    },
  };
}
