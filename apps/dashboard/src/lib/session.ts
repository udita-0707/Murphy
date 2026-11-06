"use client";

import { useSyncExternalStore } from "react";

const KEY = "murphy.apiKey";
/** Readable on purpose: it is the double-submit token, and only says a session cookie exists. */
const CSRF_COOKIES = ["__Host-murphy_csrf", "murphy_csrf"];
const listeners = new Set<() => void>();

function readKey(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function getCsrfToken(): string | null {
  for (const part of document.cookie.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && CSRF_COOKIES.includes(part.slice(0, at).trim())) {
      return part.slice(at + 1).trim();
    }
  }
  return null;
}

const notify = () => {
  for (const listener of listeners) listener();
};

export function setApiKey(key: string | null): void {
  try {
    if (key) window.sessionStorage.setItem(KEY, key);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Blocked storage: the sign-in page will simply ask again.
  }
  notify();
}

export function getApiKey(): string | null {
  return readKey();
}

/** Forgets a GitHub session here, after the server has ended it or refused it. */
export function clearCsrfCookie(): void {
  for (const name of CSRF_COOKIES) {
    const secure = name.startsWith("__Host-") ? "; secure" : "";
    document.cookie = `${name}=; path=/; max-age=0${secure}`;
  }
  notify();
}

/** Ends whichever kind of sign-in this tab has. */
export async function signOut(): Promise<void> {
  const csrf = getCsrfToken();
  setApiKey(null);
  if (csrf) {
    await fetch("/auth/logout", { method: "POST", headers: { "x-murphy-csrf": csrf } }).catch(
      () => null,
    );
    clearCsrfCookie();
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

const signedIn = () => readKey() !== null || getCsrfToken() !== null;

/** Whether this tab is signed in, or undefined during the server's render. */
export function useSignedIn(): boolean | undefined {
  return useSyncExternalStore<boolean | undefined>(subscribe, signedIn, () => undefined);
}
