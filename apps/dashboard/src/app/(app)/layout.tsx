import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";

export default async function Layout({ children }: { children: ReactNode }) {
  const theme = (await cookies()).get("murphy-theme")?.value === "platform" ? "platform" : "night";
  return <AppShell theme={theme}>{children}</AppShell>;
}
