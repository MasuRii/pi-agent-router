import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isDelegatedRuntimeArtifactLoadFailure,
  restoreMissingDelegatedRuntimeArtifactsAsync,
  writeDelegatedRuntimeArtifactsAsync,
  type DelegatedRuntimeArtifact,
} from "../subagent/delegated-runtime-artifacts";
import { isFileAsync } from "../subagent/session-paths";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

await runTest("delegated runtime artifacts are restored when temp files disappear", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-router-runtime-artifacts-"));
  const artifactPath = join(tempDir, "delegated-runtime-copilot-initiator.ts");
  const artifacts: DelegatedRuntimeArtifact[] = [
    {
      path: artifactPath,
      source: "export default function runtime() {}\n",
      requiredForLaunch: true,
    },
  ];

  try {
    await writeDelegatedRuntimeArtifactsAsync(artifacts);
    assert.equal(readFileSync(artifactPath, "utf-8"), artifacts[0].source);

    unlinkSync(artifactPath);
    assert.equal(existsSync(artifactPath), false);

    const restoreResult = await restoreMissingDelegatedRuntimeArtifactsAsync(
      artifacts,
      isFileAsync,
    );

    assert.deepEqual(restoreResult, { restoredPaths: [artifactPath] });
    assert.equal(readFileSync(artifactPath, "utf-8"), artifacts[0].source);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

await runTest("delegated runtime load failure detection matches missing runtime extension paths", () => {
  const artifacts: DelegatedRuntimeArtifact[] = [
    {
      path: "C:/Users/ADMINI~1/AppData/Local/Temp/pi-agent-router-test/delegated-runtime-active-agent-identity.ts",
      source: "export default function runtime() {}\n",
      requiredForLaunch: true,
    },
  ];

  assert.equal(
    isDelegatedRuntimeArtifactLoadFailure(
      String.raw`Error: Failed to load extension "C:\Users\ADMINI~1\AppData\Local\Temp\pi-agent-router-test\delegated-runtime-active-agent-identity.ts": Extension path does not exist`,
      artifacts,
    ),
    true,
  );
  assert.equal(
    isDelegatedRuntimeArtifactLoadFailure(
      "Warning: No models match pattern \\\"blazeapi/claude-opus-4-7\\\"",
      artifacts,
    ),
    false,
  );
});

console.log("All delegated runtime artifact tests passed.");
