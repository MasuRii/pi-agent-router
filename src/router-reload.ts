import { invalidateAgentDiscoveryCaches } from "./agent/agent-discovery";
import { invalidateTaskControlsCache } from "./task/task-controls";
import { invalidateDelegatedExtensionRuntimeCaches } from "./subagent/delegated-extensions";
import { resetProviderEnvKeyCacheState } from "./subagent/subagent-key-distribution";

export function invalidateRouterReloadCaches(): void {
  invalidateAgentDiscoveryCaches();
  invalidateTaskControlsCache();
  resetProviderEnvKeyCacheState();
  invalidateDelegatedExtensionRuntimeCaches();
}
