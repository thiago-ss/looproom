import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  access,
  realpath,
  stat,
} from "node:fs/promises";
import { join, isAbsolute, basename } from "node:path";
const exec = promisify(execFile);
let compiling: Promise<string> | undefined;
export async function folderPath(path: string) {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("Choose an absolute folder path.");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Drop a folder, rather than a file.");
  return canonical;
}
export function fileURI(uri: string) {
  const url = new URL(uri);
  if (
    url.protocol !== "file:" ||
    (url.hostname && url.hostname !== "localhost") ||
    url.search ||
    url.hash
  )
    throw new Error("Drop a local Finder folder.");
  return decodeURIComponent(url.pathname);
}
async function bridge(appRoot: string, dataDir: string) {
  if (process.platform !== "darwin")
    throw new Error("The native folder picker requires macOS.");
  if (!compiling)
    compiling = (async () => {
      const source = join(appRoot, "native", "FolderBridge.swift");
      const hash = createHash("sha256")
        .update(await readFile(source))
        .digest("hex")
        .slice(0, 16);
      const directory = join(dataDir, "native");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const bundle = join(
        directory,
        "LooproomFolderPicker-" + hash + ".app",
        "Contents",
      );
      await mkdir(join(bundle, "MacOS"), { recursive: true });
      await writeFile(
        join(bundle, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>LooproomFolderPicker</string><key>CFBundleIdentifier</key><string>dev.looproom.folderpicker.${hash}</string><key>CFBundleName</key><string>Looproom Folder Picker</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><false/></dict></plist>`,
      );
      const binary = join(bundle, "MacOS", "LooproomFolderPicker");
      try {
        await access(binary);
      } catch {
        await exec("/usr/bin/xcrun", ["swiftc", source, "-o", binary], {
          timeout: 120000,
        });
      }
      return binary;
    })().catch((error) => {
      compiling = undefined;
      throw new Error(
        "Could not prepare the macOS picker. Install Apple Command Line Tools and try again. " +
          error.message,
      );
    });
  return compiling;
}
// Serializing panels prevents overlapping dialogs; cancel leaves the draft untouched.
let choosing = false;
export async function chooseFolder(
  appRoot: string,
  dataDir: string,
  initial = "",
) {
  if (choosing) throw new Error("A folder picker is already open.");
  choosing = true;
  try {
    const { stdout } = await exec(
      await bridge(appRoot, dataDir),
      ["choose", initial],
      { timeout: 300000 },
    );
    const path = JSON.parse(stdout).path;
    return path ? await folderPath(path) : null;
  } finally {
    choosing = false;
  }
}
export async function droppedFolder(
  appRoot: string,
  dataDir: string,
  names: string[],
  uri?: string,
) {
  if (
    names.length !== 1 ||
    names.some((name) => !name || basename(name) !== name)
  )
    throw new Error("Drop one project folder at a time.");
  if (uri) {
    const path = fileURI(uri);
    if (basename(path) !== names[0])
      throw new Error("The folder name does not match the drop.");
    return folderPath(path);
  }
  const { stdout } = await exec(
    await bridge(appRoot, dataDir),
    ["drop", ...names],
    { timeout: 10000 },
  );
  const path = JSON.parse(stdout).path;
  return path ? await folderPath(path) : null;
}
