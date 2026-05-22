import { invalidateRouterReloadCaches } from "./router-reload";

export const ROUTER_RELOAD_EVENT_NAME = "resources_discover";

type RouterReloadEvent = {
  reason?: string;
};

type RouterReloadRegistrar = {
  on?: (name: typeof ROUTER_RELOAD_EVENT_NAME, handler: (event: RouterReloadEvent) => Promise<void> | void) => void;
};

export function shouldInvalidateRouterReloadCaches(event: RouterReloadEvent | undefined): boolean {
  return event?.reason === "reload";
}

export function registerRouterReloadHandler(
  pi: RouterReloadRegistrar,
  invalidateCaches: () => void = invalidateRouterReloadCaches,
): void {
  pi.on?.(ROUTER_RELOAD_EVENT_NAME, async (event: RouterReloadEvent) => {
    if (shouldInvalidateRouterReloadCaches(event)) {
      invalidateCaches();
    }
  });
}
