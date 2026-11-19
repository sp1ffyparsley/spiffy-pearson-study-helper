import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const buildScript = path.join(root, "scripts", "build.mjs");
const webExtScript = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");

function runProcess(args, options = {}) {
  return spawn(node, args, { cwd: root, stdio: "inherit", ...options });
}

async function build() {
  const child = runProcess([buildScript, "build"]);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`Pearson extension build failed (${code}).`);
}

await build();
const webExt = runProcess([
  webExtScript,
  "run",
  "--source-dir", path.join(root, "dist", "firefox"),
  "--firefox", "firefox",
  ...process.argv.slice(2),
]);

let rebuilding = false;
let rebuildAgain = false;
let timer = null;
async function rebuild() {
  if (rebuilding) {
    rebuildAgain = true;
    return;
  }
  rebuilding = true;
  try {
    do {
      rebuildAgain = false;
      try {
        await build();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    } while (rebuildAgain);
  } finally {
    rebuilding = false;
  }
}

const watcher = watch(path.join(root, "src"), { recursive: true }, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 140);
});

function stop() {
  watcher.close();
  if (timer) clearTimeout(timer);
  if (!webExt.killed) webExt.kill();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const code = await new Promise((resolve, reject) => {
  webExt.once("error", reject);
  webExt.once("exit", (value) => resolve(value ?? 0));
});
stop();
process.exit(code);
