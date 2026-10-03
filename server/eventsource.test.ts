import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("a live EventSource reconnect receives a later change on the same subscription", async () => {
  const script = `
    import { createServer } from "node:http";
    let connections = 0;
    const server = createServer((_request, response) => {
      connections++;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (connections === 1) {
        response.end("retry: 25\\ndata: connected\\n\\n");
      } else {
        response.end("data: connected\\n\\ndata: changed\\n\\n");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const source = new EventSource("http://127.0.0.1:" + server.address().port);
      const messages = [];
      const timer = setTimeout(() => finish(1), 5000);
      function finish(code) {
        clearTimeout(timer);
        source.close();
        server.close(() => process.exit(code));
      }
      source.onmessage = (event) => {
        messages.push(event.data);
        if (event.data === "changed") {
          console.log(JSON.stringify({ connections, messages }));
          finish(0);
        }
      };
      source.onerror = () => {};
    });
  `;
  const child = spawn(process.execPath, ["--experimental-eventsource", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    connections: 2,
    messages: ["connected", "connected", "changed"],
  });
});
