import type { ReactNode } from "react";

/** The shape of what is coming, so a loading region does not jump. */
export function Loading({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton__row" key={i} />
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      {children}
    </div>
  );
}

export function ErrorState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      {children}
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <pre className="code" aria-label={label} tabIndex={0}>
      <code>{code}</code>
    </pre>
  );
}
