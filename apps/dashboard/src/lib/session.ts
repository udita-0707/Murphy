"use client";

import { useSyncExternalStore } from "react";

const KEY = "murphy.apiKey";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key) window.sessionStorage.setItem(KEY, key);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Blocked storage: the sign-in page will simply ask again.
  }
  for (const listener of listeners) listener();
}

export function getApiKey(): string | null {
  return read();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The key, or null if signed out, or undefined during the server's render. */
export function useApiKey(): string | null | undefined {
  return useSyncExternalStore<string | null | undefined>(subscribe, read, () => undefined);
}
