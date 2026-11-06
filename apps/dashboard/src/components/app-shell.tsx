"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { setApiKey, useApiKey } from "@/lib/session";
import { Loading } from "./states";
import { ThemeToggle, type Theme } from "./theme-toggle";

const LINKS = [{ href: "/scenarios", label: "Scenarios" }];

export function AppShell({ theme, children }: { theme: Theme; children: ReactNode }) {
  const key = useApiKey();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (key === null) router.replace("/");
  }, [key, router]);

  return (
    <>
      <header className="topbar">
        <div className="container topbar__inner">
          <Link href="/scenarios" className="topbar__mark">
            Murphy
          </Link>
          <nav className="topbar__nav" aria-label="Main">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="topbar__link"
                aria-current={pathname.startsWith(link.href) ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="topbar__actions">
            <ThemeToggle initial={theme} />
            <button type="button" className="btn btn--small" onClick={() => setApiKey(null)}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="container page">
        {key ? children : <Loading label="Checking your session" />}
      </main>
    </>
  );
}
