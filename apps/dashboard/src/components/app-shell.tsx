"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { signOut, useSignedIn } from "@/lib/session";
import { Loading } from "./states";
import { ThemeToggle, type Theme } from "./theme-toggle";

const LINKS = [
  { href: "/scenarios", label: "Scenarios" },
  { href: "/endpoints", label: "Endpoints" },
  { href: "/events", label: "Events" },
  { href: "/deliveries", label: "Deliveries" },
  { href: "/dlq", label: "Dead letters" },
];

export function AppShell({ theme, children }: { theme: Theme; children: ReactNode }) {
  const signedIn = useSignedIn();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (signedIn === false) router.replace("/");
  }, [signedIn, router]);

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
            <button type="button" className="btn btn--small" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="container page">
        {signedIn ? children : <Loading label="Checking your session" />}
      </main>
    </>
  );
}
