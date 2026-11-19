import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist", "firefox");
const artifacts = path.join(root, "dist", "artifacts");
const fixedPackageTime = new Date("2000-01-01T00:00:00.000Z");
const packageInfo = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const builtManifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
if (packageInfo.version !== builtManifest.version) {
  throw new Error("Refusing to package a manifest whose version differs from package.json.");
}
const xpiName = `spiffy-pearson-study-helper-${packageInfo.version}-unsigned.xpi`;

async function collectFiles(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath, archivePath));
    else if (entry.isFile()) files.push({ archivePath, fullPath });
    else throw new Error(`Refusing non-file package entry: ${fullPath}`);
  }
  return files;
}

const files = await collectFiles(source);
if (!files.some(({ archivePath }) => archivePath === "manifest.json")) {
  throw new Error("Built extension is missing root manifest.json.");
}

const archive = new JSZip();
for (const { archivePath, fullPath } of files) {
  archive.file(archivePath, await fs.readFile(fullPath), {
    binary: true,
    createFolders: false,
    date: fixedPackageTime,
    unixPermissions: 0o100644,
  });
}

const bytes = await archive.generateAsync({
  type: "nodebuffer",
  platform: "UNIX",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
  streamFiles: false,
});
const sha256 = createHash("sha256").update(bytes).digest("hex");

await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(artifacts, xpiName), bytes);
console.log(`Packaged ${xpiName}: ${files.length} files, ${bytes.length} bytes, sha256 ${sha256}`);
