import { readFileSync, writeFileSync } from "node:fs";

const version = (process.argv[2] ?? process.env.TGT_RELEASE_VERSION ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/set-version.mjs <x.y.z>");
  process.exit(1);
}

const replaceIn = (file, pattern, replacement) => {
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) throw new Error(`${file}: nothing matched`);
  writeFileSync(file, after);
};

replaceIn("fxmanifest.lua", /^version '.*'$/m, `version '${version}'`);
replaceIn("src/config.ts", /RESOURCE_VERSION = ".*"/, `RESOURCE_VERSION = "${version}"`);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`version set to ${version}`);
