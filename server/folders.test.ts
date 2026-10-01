import { testFixture } from "./test-fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { folderPath, fileURI, droppedFolder } from "./folders.ts";
test("folder drops accept only local folder URLs and canonicalize directories", async () => {
  const folder = await testFixture("looproom-folders-");
  try {
    assert.equal(
      fileURI("file:///Users/test/My%20Project"),
      "/Users/test/My Project",
    );
    for (const uri of [
      "https://evil.example/folder",
      "file://remote/folder",
      "file:///tmp/a?query=1",
      "file:///tmp/a#fragment",
    ])
      assert.throws(() => fileURI(uri));
    await assert.rejects(folderPath("relative/path"));
    const file = join(folder, "file.txt");
    await writeFile(file, "fixture");
    await assert.rejects(folderPath(file), /rather than a file/);
    const link = join(folder, "alias");
    await symlink(folder, link);
    assert.equal(await folderPath(link), await realpath(folder));
    assert.equal(
      await droppedFolder(
        "",
        "",
        [folder.split("/").at(-1)!],
        new URL("file://" + folder).href,
      ),
      await realpath(folder),
    );
    await assert.rejects(
      droppedFolder("", "", ["wrong"], "file://" + folder),
      /does not match/,
    );
    await assert.rejects(droppedFolder("", "", ["../escape"]), /one project/);
    await assert.rejects(droppedFolder("", "", ["one", "two"]), /one project/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
