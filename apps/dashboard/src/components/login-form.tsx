"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { setApiKey } from "@/lib/session";

/** What a failed sign-in means to the person at the keyboard. */
export function signInError(status: number): string {
  if (status === 401) return "That key was refused. Check it, or make a new one with pnpm db:seed.";
  if (status === 502) return "The Murphy API cannot be reached. Is it running?";
  return `Sign-in failed with status ${status}.`;
}

export function LoginForm({
  github = false,
  error: initialError = null,
}: {
  github?: boolean;
  error?: string | null;
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError("Paste your API key first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/scenarios", {
        headers: { authorization: `Bearer ${trimmed}` },
        cache: "no-store",
      });
      if (!res.ok) {
        setError(signInError(res.status));
        return;
      }
      setApiKey(trimmed);
      router.push("/scenarios");
    } catch {
      setError("This page lost contact with its server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login__form" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field__label">API key</span>
        <input
          className="input"
          type="password"
          name="api-key"
          autoComplete="off"
          spellCheck={false}
          placeholder="mk_..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? "login-error" : "login-note"}
        />
      </label>
      {error ? (
        <p className="field__error" id="login-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="field__note" id="login-note">
          Kept in this tab only, and gone when you close it.
        </p>
      )}
      <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy}>
        {busy ? "Checking" : "Sign in"}
      </button>
      {github && (
        // A real navigation, because this leaves for GitHub and comes back with cookies.
        <a className="btn" href="/auth/github/start">
          Sign in with GitHub
        </a>
      )}
    </form>
  );
}
