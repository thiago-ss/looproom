import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  stdio: ["inherit", "pipe", "inherit"],
});
let opened = false;
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  const url = chunk
    .toString()
    .match(/coordinator: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  if (url && !opened) {
    opened = true;
    spawn("/usr/bin/open", [url], { stdio: "ignore" });
  }
});
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
