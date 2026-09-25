// Fails when the version numbers spread across the repo disagree. The extension and the MCP
// server share a wire protocol, so they are always released together under one version.
import { readFileSync } from "node:fs";

const json = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const serverSource = readFileSync(new URL("../mcp-server/server.ts", import.meta.url), "utf8");

const versions = {
  "package.json": json("package.json").version,
  "mcp-server/package.json": json("mcp-server/package.json").version,
  "mcp-server/manifest.json": json("mcp-server/manifest.json").version,
  "mcp-server/server.ts": /SERVER_VERSION = "([^"]+)"/.exec(serverSource)?.[1],
  "firefox-extension/package.json": json("firefox-extension/package.json").version,
  "firefox-extension/manifest.json": json("firefox-extension/manifest.json").version,
};

const distinct = new Set(Object.values(versions));
if (distinct.size !== 1) {
  console.error("Version mismatch:");
  for (const [file, version] of Object.entries(versions)) {
    console.error(`  ${file}: ${version}`);
  }
  process.exit(1);
}
console.log(`All versions are ${[...distinct][0]}`);
