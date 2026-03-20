/**
 * Model reference parsing and resolution utilities.
 */

import type { Agent } from "./types";

type ModelReference = {
  provider: string;
  id: string;
};

type ModelRegistryContext<TModel extends ModelReference> = {
  modelRegistry: {
    getAll(): TModel[];
    getAvailable(): TModel[];
    find(provider: string, modelId: string): TModel | undefined;
  };
};

export function parseModelReference(modelReference: string | undefined): { provider: string; modelId: string } | undefined {
  if (!modelReference) {
    return undefined;
  }

  const trimmed = modelReference.trim();
  if (!trimmed) {
    return undefined;
  }

  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return undefined;
  }

  return {
    provider: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
}

export function toModelReference(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export function resolveAgentModel<TModel extends ModelReference>(
  ctx: ModelRegistryContext<TModel>,
  agent: Agent,
): { model?: TModel; requested?: string; fallbackFrom?: string } {
  const requested = agent.model?.trim();
  if (!requested) {
    return {};
  }

  const allModels = ctx.modelRegistry.getAll();
  const availableModels = ctx.modelRegistry.getAvailable();
  const availableRefs = new Set(availableModels.map((model) => toModelReference(model)));
  const parsed = parseModelReference(requested);

  if (parsed) {
    const exact = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
    if (exact) {
      const exactRef = toModelReference(exact);
      if (availableRefs.has(exactRef)) {
        return { model: exact, requested };
      }

      const sameIdAvailable = availableModels.find((model) => model.id === exact.id);
      if (sameIdAvailable) {
        return { model: sameIdAvailable, requested, fallbackFrom: exactRef };
      }

      return { model: exact, requested };
    }

    const aliasAvailable = availableModels.find((model) => model.id === parsed.modelId);
    if (aliasAvailable) {
      return { model: aliasAvailable, requested, fallbackFrom: requested };
    }

    const aliasAny = allModels.find((model) => model.id === parsed.modelId);
    if (aliasAny) {
      return { model: aliasAny, requested, fallbackFrom: requested };
    }

    return { requested };
  }

  const byExactRef = availableModels.find((model) => toModelReference(model) === requested);
  if (byExactRef) {
    return { model: byExactRef, requested };
  }

  const byIdAvailable = availableModels.find((model) => model.id === requested);
  if (byIdAvailable) {
    return { model: byIdAvailable, requested };
  }

  const byIdAny = allModels.find((model) => model.id === requested);
  if (byIdAny) {
    return { model: byIdAny, requested };
  }

  return { requested };
}
