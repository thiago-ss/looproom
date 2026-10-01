import { readdir, readFile } from "node:fs/promises";
async function check(directory) {
  let failures = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && path !== "src/components/arc")
      failures += await check(path);
    else if (entry.name.endsWith(".tsx")) {
      const source = await readFile(path, "utf8");
      if (/<(?:button|select|input|textarea|details|summary)\b/.test(source)) {
        console.error(`${path}: use Arc control primitives`);
        failures++;
      }
    }
  }
  return failures;
}
process.exitCode = (await check("src")) ? 1 : 0;
