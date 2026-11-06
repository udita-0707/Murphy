"use client";

import { useState } from "react";

export type Theme = "night" | "platform";

/** Night is the default. Platform is the backup for a bright room. A cookie, so the server draws it right. */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState(initial);
  const toggle = () => {
    const next: Theme = theme === "night" ? "platform" : "night";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    document.cookie = `murphy-theme=${next}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <button type="button" className="btn btn--small" onClick={toggle}>
      {theme === "night" ? "Light room" : "Dark room"}
    </button>
  );
}
