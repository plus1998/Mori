import { useCallback, useRef, useSyncExternalStore } from "react";
import type { BrowserViewState } from "../shared/browser";

type BrowserStateListener = () => void;

const EMPTY_BROWSER_INSTANCE_IDS: readonly string[] = [];

export type BrowserTaskInstance = {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
  isLoading?: boolean;
};

export type BrowserWebviewInstance = {
  id: string;
  partition: string;
};

const EMPTY_BROWSER_WEBVIEW_INSTANCES: readonly BrowserWebviewInstance[] = [];

export type BrowserIntegrationStatus = {
  available?: boolean | undefined;
  unavailableReason?: string | undefined;
};

class BrowserStateStore {
  private state: BrowserViewState | undefined;
  private readonly listeners = new Set<BrowserStateListener>();
  private sourceAttached = false;
  private unsubscribeSource: (() => void) | undefined;
  private revision = 0;

  getState(): BrowserViewState | undefined {
    return this.state;
  }

  setState(next: BrowserViewState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  async hydrate(): Promise<void> {
    this.attachSource();
    const revision = this.revision;
    const next = await window.eco?.getBrowserState?.();
    if (next && this.revision === revision) {
      this.setState(next);
    }
  }

  subscribe = (listener: BrowserStateListener): (() => void) => {
    this.attachSource();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Callback-style subscription for effects that need the complete snapshot. */
  onStateChange = (listener: (state: BrowserViewState) => void): (() => void) => {
    let previous = this.state;
    return this.subscribe(() => {
      const next = this.state;
      if (!next || next === previous) {
        return;
      }
      previous = next;
      listener(next);
    });
  };

  disposeSourceForTests(): void {
    this.unsubscribeSource?.();
    this.unsubscribeSource = undefined;
    this.sourceAttached = false;
    this.listeners.clear();
  }

  private attachSource(): void {
    if (this.sourceAttached || typeof window === "undefined" || !window.eco) {
      return;
    }
    this.sourceAttached = true;
    this.unsubscribeSource = window.eco.onBrowserStateChanged?.((state) => {
      this.setState(state);
    });
  }
}

export const browserStateStore = new BrowserStateStore();

export function subscribeBrowserState(listener: BrowserStateListener): () => void {
  return browserStateStore.subscribe(listener);
}

export function getBrowserStateSnapshot(): BrowserViewState | undefined {
  return browserStateStore.getState();
}

export function useBrowserStateSelector<T>(
  selector: (state: BrowserViewState | undefined) => T,
  isEqual: (previous: T, next: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cacheRef = useRef<
    | {
        source: BrowserViewState | undefined;
        selector: typeof selector;
        value: T;
      }
    | undefined
  >(undefined);

  const getSnapshot = useCallback(() => {
    const source = browserStateStore.getState();
    const cache = cacheRef.current;
    if (cache && cache.source === source && cache.selector === selectorRef.current) {
      return cache.value;
    }
    const next = selectorRef.current(source);
    // External stores must hand React a stable value when a new snapshot has
    // the same projected fields; otherwise every browser event re-renders App.
    cacheRef.current = {
      source,
      selector: selectorRef.current,
      value: cache && isEqualRef.current(cache.value, next) ? cache.value : next,
    };
    return cacheRef.current.value;
  }, []);

  return useSyncExternalStore(subscribeBrowserState, getSnapshot, getSnapshot);
}

function equalPrimitiveArrays(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function projectLiveBrowserInstanceIds(state: BrowserViewState | undefined): readonly string[] {
  if (!state) {
    return EMPTY_BROWSER_INSTANCE_IDS;
  }
  const ids = state.instances.map((instance) => instance.id);
  for (const guest of state.guestInstances ?? []) {
    if (!ids.includes(guest.id)) {
      ids.push(guest.id);
    }
  }
  return ids;
}

export function browserStateForScope(
  state: BrowserViewState | undefined,
  scopeId: string,
): BrowserViewState | undefined {
  return state?.uiScopeId === scopeId ? state : undefined;
}

export function useBrowserInstanceIds(scopeId?: string): readonly string[] {
  return useBrowserStateSelector(
    (state) => projectLiveBrowserInstanceIds(scopeId ? browserStateForScope(state, scopeId) : state),
    equalPrimitiveArrays,
  );
}

function equalTaskInstances(
  previous: readonly BrowserTaskInstance[],
  next: readonly BrowserTaskInstance[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((previousInstance, index) => {
      const nextInstance = next[index];
      if (!nextInstance) {
        return false;
      }
      return (
        previousInstance.id === nextInstance.id &&
        previousInstance.title === nextInstance.title &&
        previousInstance.url === nextInstance.url &&
        previousInstance.faviconUrl === nextInstance.faviconUrl &&
        previousInstance.isLoading === nextInstance.isLoading
      );
    })
  );
}

export function useBrowserTaskInstances(scopeId?: string): readonly BrowserTaskInstance[] {
  return useBrowserStateSelector(
    (state) => projectTaskInstances(scopeId ? browserStateForScope(state, scopeId) : state),
    equalTaskInstances,
  );
}

function equalWebviewInstances(
  previous: readonly BrowserWebviewInstance[],
  next: readonly BrowserWebviewInstance[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((previousInstance, index) => {
      const nextInstance = next[index];
      return (
        nextInstance !== undefined &&
        previousInstance.id === nextInstance.id &&
        previousInstance.partition === nextInstance.partition
      );
    })
  );
}

function projectWebviewInstances(state: BrowserViewState | undefined): readonly BrowserWebviewInstance[] {
  return (
    state?.allGuestInstances?.map((instance) => ({
      id: instance.id,
      partition: instance.partition,
    })) ?? EMPTY_BROWSER_WEBVIEW_INSTANCES
  );
}

export function useBrowserWebviewInstances(): readonly BrowserWebviewInstance[] {
  return useBrowserStateSelector(projectWebviewInstances, equalWebviewInstances);
}

function projectTaskInstances(state: BrowserViewState | undefined): readonly BrowserTaskInstance[] {
  return (
    state?.instances.map((instance) => ({
      id: instance.id,
      title: instance.title,
      url: instance.url,
      ...(instance.faviconUrl ? { faviconUrl: instance.faviconUrl } : {}),
      isLoading: instance.isLoading,
    })) ?? []
  );
}

function equalIntegrationStatus(previous: BrowserIntegrationStatus, next: BrowserIntegrationStatus): boolean {
  return previous.available === next.available && previous.unavailableReason === next.unavailableReason;
}

export function useBrowserIntegrationStatus(): BrowserIntegrationStatus {
  return useBrowserStateSelector(
    (state) => ({
      available: state?.agentBrowserAvailable,
      unavailableReason: state?.agentBrowserUnavailableReason,
    }),
    equalIntegrationStatus,
  );
}
