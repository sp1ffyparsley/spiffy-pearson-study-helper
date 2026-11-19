import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageInfo = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const buildDir = path.join(root, "dist", "firefox");
const packageDir = path.join(root, "dist", "artifacts");
const packageName = `spiffy-pearson-study-helper-${packageInfo.version}-unsigned.xpi`;

// This four-file allowlist stops accidental publication of logs, user
// sessions, screenshots, machine-local state, credentials or source maps.
const expected = [
  "assets/icon.svg",
  "background.js",
  "content.js",
  "manifest.json",
];

async function collectNames(directory, prefix = "") {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectNames(fullPath, name));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`Unexpected linked or special build output: ${name}`);
  }
  return found.sort();
}

assert.deepEqual(await collectNames(buildDir), expected, "Firefox build contains unexpected files");
assert.deepEqual(await fs.readdir(packageDir), [packageName], "Package directory contains duplicate or unexpected releases");

const manifest = JSON.parse(await fs.readFile(path.join(buildDir, "manifest.json"), "utf8"));
assert.equal(manifest.version, packageInfo.version, "Manifest version differs from package.json");
const protocolSource = await fs.readFile(path.join(root, "src", "shared", "protocol.ts"), "utf8");
const protocolVersion = protocolSource.match(/export const EXTENSION_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
assert.equal(protocolVersion, packageInfo.version, "Bridge protocol version differs from package.json");
assert.equal(manifest.manifest_version, 3, "Expected Firefox manifest v3");
assert.equal(manifest.browser_specific_settings?.gecko?.id, "spiffy-pearson-study-helper@spiffy.local");
assert.equal(manifest.incognito, "not_allowed", "Incognito permission boundary changed");
assert.deepEqual(manifest.permissions, ["activeTab", "storage", "webNavigation", "clipboardWrite"]);
assert.deepEqual(manifest.host_permissions, [
  "https://*.pearson.com/*",
  "https://*.pearsoncmg.com/*",
  "https://*.mylabmastering.com/*",
  "https://*.mathxl.com/*",
  "http://127.0.0.1/*",
], "Website access changed; review and update the release gate explicitly");

const bytes = await fs.readFile(path.join(packageDir, packageName));
const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
const zippedFiles = Object.values(zip.files).filter((file) => !file.dir);
assert.deepEqual(zippedFiles.map((file) => file.name).sort(), expected, "XPI contains unexpected entries");
for (const name of expected) {
  const built = await fs.readFile(path.join(buildDir, ...name.split("/")));
  const zipped = await zip.file(name).async("nodebuffer");
  assert.deepEqual(zipped, built, `XPI differs from built file: ${name}`);
}

const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`Release verified: ${packageName} (${expected.length} files, ${bytes.length} bytes, SHA-256 ${sha256})`);
