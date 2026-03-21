import { type FSWatcher, watch } from "node:fs";

import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  resolveWorkflowConfig,
  validateDispatchConfig,
} from "./config-resolver.js";
import type {
  WorkflowReloadReason,
  WorkflowReloadResult,
  WorkflowSnapshot,
} from "./types.js";
import {
  loadWorkflowDefinition,
  resolveWorkflowPath,
} from "./workflow-loader.js";

const DEFAULT_WATCH_DEBOUNCE_MS = 100;

export interface WorkflowWatcherHooks {
  onReload?: (result: {
    reason: WorkflowReloadReason;
    previousSnapshot: WorkflowSnapshot;
    snapshot: WorkflowSnapshot;
  }) => void | Promise<void>;
  onError?: (result: {
    reason: WorkflowReloadReason;
    currentSnapshot: WorkflowSnapshot;
    error: unknown;
  }) => void | Promise<void>;
}

export interface WorkflowWatcherOptions extends WorkflowWatcherHooks {
  workflowPath?: string;
  environment?: NodeJS.ProcessEnv;
  debounceMs?: number;
}

export async function loadWorkflowSnapshot(
  workflowPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowSnapshot> {
  const definition = await loadWorkflowDefinition(workflowPath);
  const config = resolveWorkflowConfig(definition, environment);

  return {
    definition,
    config,
    dispatchValidation: validateDispatchConfig(config),
    loadedAt: formatEasternTimestamp(new Date()),
  };
}

export class WorkflowWatcher {
  readonly workflowPath: string;

  #currentSnapshot: WorkflowSnapshot;
  #environment: NodeJS.ProcessEnv;
  #watcher: FSWatcher | null = null;
  #debounceMs: number;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #reloadInFlight: Promise<WorkflowReloadResult> | null = null;
  #reloadQueued = false;
  #hooks: WorkflowWatcherHooks;

  private constructor(input: {
    currentSnapshot: WorkflowSnapshot;
    workflowPath: string;
    environment: NodeJS.ProcessEnv;
    debounceMs: number;
    hooks: WorkflowWatcherHooks;
  }) {
    this.#currentSnapshot = input.currentSnapshot;
    this.workflowPath = input.workflowPath;
    this.#environment = input.environment;
    this.#debounceMs = input.debounceMs;
    this.#hooks = input.hooks;
  }

  static async create(
    options: WorkflowWatcherOptions = {},
  ): Promise<WorkflowWatcher> {
    const environment = options.environment ?? process.env;
    const workflowPath = resolveWorkflowPath(options.workflowPath);
    const currentSnapshot = await loadWorkflowSnapshot(
      workflowPath,
      environment,
    );

    return new WorkflowWatcher({
      currentSnapshot,
      workflowPath,
      environment,
      debounceMs: options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
      hooks: {
        ...(options.onReload ? { onReload: options.onReload } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      },
    });
  }

  get currentSnapshot(): WorkflowSnapshot {
    return this.#currentSnapshot;
  }

  start(): this {
    if (this.#watcher) {
      return this;
    }

    this.#watcher = watch(this.workflowPath, () => {
      this.#scheduleReload();
    });

    this.#watcher.on("error", (error) => {
      void this.#emitError({
        reason: "filesystem_event",
        currentSnapshot: this.#currentSnapshot,
        error,
      });
    });

    return this;
  }

  async reload(
    reason: WorkflowReloadReason = "manual",
  ): Promise<WorkflowReloadResult> {
    if (this.#reloadInFlight) {
      if (reason === "filesystem_event") {
        this.#reloadQueued = true;
      }

      return this.#reloadInFlight;
    }

    const operation = this.#performReload(reason).finally(() => {
      this.#reloadInFlight = null;

      if (this.#reloadQueued) {
        this.#reloadQueued = false;
        void this.reload("filesystem_event");
      }
    });

    this.#reloadInFlight = operation;
    return operation;
  }

  async close(): Promise<void> {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }

    if (this.#reloadInFlight) {
      await this.#reloadInFlight;
    }
  }

  async #performReload(
    reason: WorkflowReloadReason,
  ): Promise<WorkflowReloadResult> {
    try {
      const snapshot = await loadWorkflowSnapshot(
        this.workflowPath,
        this.#environment,
      );
      const previousSnapshot = this.#currentSnapshot;
      this.#currentSnapshot = snapshot;

      const result = {
        ok: true,
        reason,
        previousSnapshot,
        snapshot,
      } satisfies WorkflowReloadResult;

      await this.#hooks.onReload?.({
        reason,
        previousSnapshot,
        snapshot,
      });

      return result;
    } catch (error) {
      const result = {
        ok: false,
        reason,
        currentSnapshot: this.#currentSnapshot,
        error,
      } satisfies WorkflowReloadResult;

      await this.#emitError(result);
      return result;
    }
  }

  #scheduleReload(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }

    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.reload("filesystem_event");
    }, this.#debounceMs);
  }

  async #emitError(result: {
    reason: WorkflowReloadReason;
    currentSnapshot: WorkflowSnapshot;
    error: unknown;
  }): Promise<void> {
    await this.#hooks.onError?.(result);
  }
}
