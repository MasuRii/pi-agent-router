import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getMissingRequiredDelegatedSecurityExtensionError,
  invalidateDelegatedExtensionRuntimeCaches,
  readDelegatedExtensionRuntimeMetadataAsync,
  resolveDelegatedExtensionDirectoryAsync,
} from "../subagent/delegated-extensions";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("delegated extension directory resolution is cached until invalidated", async () => {
  invalidateDelegatedExtensionRuntimeCaches();

  const extensionsRootDir = join(tmpdir(), "pi-agent-router-delegated-cache");
  const installedExtensionDir = join(extensionsRootDir, "installed-extension");
  const existingDirectories = new Set([installedExtensionDir]);
  let probeCount = 0;

  const isDirectoryAsync = async (path: string): Promise<boolean> => {
    probeCount += 1;
    return existingDirectories.has(path);
  };

  const firstResolution = await resolveDelegatedExtensionDirectoryAsync(
    extensionsRootDir,
    ["missing-extension", "installed-extension"],
    isDirectoryAsync,
  );
  assert.equal(firstResolution, installedExtensionDir);
  assert.equal(probeCount, 2);

  existingDirectories.clear();
  const cachedResolution = await resolveDelegatedExtensionDirectoryAsync(
    extensionsRootDir,
    ["missing-extension", "installed-extension"],
    isDirectoryAsync,
  );
  assert.equal(cachedResolution, installedExtensionDir);
  assert.equal(probeCount, 2);

  invalidateDelegatedExtensionRuntimeCaches();
  const refreshedResolution = await resolveDelegatedExtensionDirectoryAsync(
    extensionsRootDir,
    ["missing-extension", "installed-extension"],
    isDirectoryAsync,
  );
  assert.equal(refreshedResolution, undefined);
  assert.equal(probeCount, 4);
});

await runTest("delegated extension metadata reads are cached until invalidated", async () => {
  invalidateDelegatedExtensionRuntimeCaches();
  const extensionDir = mkdtempSync(join(tmpdir(), "pi-agent-router-delegated-metadata-"));
  const packageJsonPath = join(extensionDir, "package.json");

  try {
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify({
        piAgentRouter: {
          delegatedRuntime: {
            skipWhen: ["directEnvAuthAvailable"],
          },
        },
      })}\n`,
      "utf-8",
    );

    const firstRead = await readDelegatedExtensionRuntimeMetadataAsync(extensionDir);
    assert.deepEqual(firstRead.metadata.skipWhen, ["directEnvAuthAvailable"]);

    writeFileSync(packageJsonPath, `${JSON.stringify({})}\n`, "utf-8");
    const cachedRead = await readDelegatedExtensionRuntimeMetadataAsync(extensionDir);
    assert.deepEqual(cachedRead.metadata.skipWhen, ["directEnvAuthAvailable"]);

    invalidateDelegatedExtensionRuntimeCaches();
    const refreshedRead = await readDelegatedExtensionRuntimeMetadataAsync(extensionDir);
    assert.deepEqual(refreshedRead.metadata.skipWhen, []);
  } finally {
    rmSync(extensionDir, { recursive: true, force: true });
    invalidateDelegatedExtensionRuntimeCaches();
  }
});

await runTest("required security delegated extensions fail closed unless explicitly optional", () => {
  const requiredPermissionError = getMissingRequiredDelegatedSecurityExtensionError(
    { candidates: ["pi-permission-system"], skipWhen: [], optional: false },
    "C:/Users/Administrator/.pi/agent/extensions/pi-permission-system",
  );
  assert.match(requiredPermissionError || "", /Required delegated security extension is missing/);
  assert.match(requiredPermissionError || "", /--no-extensions/);

  const requiredSensitiveGuardError = getMissingRequiredDelegatedSecurityExtensionError(
    { candidates: ["pi-sensitive-guard", "env-protection"], skipWhen: [], optional: false },
    "C:/Users/Administrator/.pi/agent/extensions/pi-sensitive-guard",
  );
  assert.match(requiredSensitiveGuardError || "", /permission and sensitive-data controls/);

  const optionalSecurityError = getMissingRequiredDelegatedSecurityExtensionError(
    { candidates: ["pi-permission-system"], skipWhen: [], optional: true },
    "C:/Users/Administrator/.pi/agent/extensions/pi-permission-system",
  );
  assert.equal(optionalSecurityError, undefined);

  const optionalCompanionError = getMissingRequiredDelegatedSecurityExtensionError(
    { candidates: ["pi-fast-mode"], skipWhen: [], optional: false },
    "C:/Users/Administrator/.pi/agent/extensions/pi-fast-mode",
  );
  assert.equal(optionalCompanionError, undefined);
});

console.log("All delegated extension runtime tests passed.");
