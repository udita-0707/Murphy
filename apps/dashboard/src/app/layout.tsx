import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "Murphy",
  description: "Murphy breaks your webhooks so production can't.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = (await cookies()).get("murphy-theme")?.value === "platform" ? "platform" : "night";
  return (
    <html lang="en" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
