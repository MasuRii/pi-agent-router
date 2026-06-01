import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(testDir, "..", "..");
const testEntries = [
  join(testDir, "..", "test.ts"),
  ...readdirSync(testDir)
    .filter((entry) => entry.endsWith("-test.ts"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => join(testDir, entry)),
];
const runnerArgs = process.execArgv;

for (const testEntry of testEntries) {
  const result = spawnSync(process.execPath, [...runnerArgs, testEntry], {
    cwd: extensionRoot,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
