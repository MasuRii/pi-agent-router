import {
  SPINNER_RENDER_INTERVAL_MS,
  createSpinnerRenderLoop,
} from "../progress-spinner";

type RenderableTui = {
  requestRender: () => void;
};

export type AnimatedRenderSurface = {
  requestRender: () => void;
  dispose: () => void;
};

/**
 * Mirrors Pi TUI's loader pattern for extension-owned animated surfaces:
 * keep spinner state render-time/local and drive redraws with one aligned loop.
 */
export function createAnimatedRenderSurface(
  tui: RenderableTui,
  options: {
    shouldRender?: () => boolean;
    intervalMs?: number;
    now?: () => number;
  } = {},
): AnimatedRenderSurface {
  const requestRender = (): void => {
    tui.requestRender();
  };

  const renderLoop = createSpinnerRenderLoop({
    intervalMs: options.intervalMs ?? SPINNER_RENDER_INTERVAL_MS,
    now: options.now,
    onTick: requestRender,
    shouldRender: options.shouldRender,
  });

  return {
    requestRender,
    dispose(): void {
      renderLoop.stop();
    },
  };
}
