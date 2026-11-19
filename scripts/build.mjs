import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import typescript from "@rollup/plugin-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "firefox");
const mode = process.argv[2] || "build";

async function removeOutput() {
  await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
}

async function bundle(input, file, name) {
  const build = await rollup({
    input: path.join(root, input),
    plugins: [typescript({ tsconfig: path.join(root, "tsconfig.json"), sourceMap: false })],
  });
  await build.write({ file: path.join(out, file), format: "iife", name, sourcemap: false });
  await build.close();
}

if (mode === "clean") {
  await removeOutput();
  process.exit(0);
}
if (mode !== "build") throw new Error(`Unknown build mode: ${mode}`);

await removeOutput();
await fs.mkdir(path.join(out, "assets"), { recursive: true });
await Promise.all([
  fs.copyFile(path.join(root, "src", "manifest.json"), path.join(out, "manifest.json")),
  fs.copyFile(path.join(root, "src", "assets", "icon.svg"), path.join(out, "assets", "icon.svg")),
]);
await bundle("src/background/index.ts", "background.js", "SpiffyPearsonBackground");
await bundle("src/content/index.ts", "content.js", "SpiffyPearsonContent");

const manifest = JSON.parse(await fs.readFile(path.join(out, "manifest.json"), "utf8"));
const packageInfo = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (manifest.version !== packageInfo.version || manifest.browser_specific_settings?.gecko?.id !== "spiffy-pearson-study-helper@spiffy.local") {
  throw new Error("Built manifest identity does not match the Pearson Study Helper release.");
}
console.log(`Built Firefox extension: ${out}`);
