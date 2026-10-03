import { spawn } from "node:child_process";
const children = [
  spawn("node", ["--import", "tsx", "server/index.ts"], { stdio: "inherit" }),
  spawn("node", ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const pending = children.map((child) => {
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve();
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    return closed;
  });
  const deadline = setTimeout(() => {
    children.forEach((child) => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
  }, 35_000);
  void Promise.all(pending).then(() => {
    clearTimeout(deadline);
    process.exitCode = code;
  });
}
children.forEach((child) => child.on("exit", (code) => stop(code ?? 0)));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
