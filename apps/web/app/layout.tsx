import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

export const metadata: Metadata = {
  title: "Viva — your notes, viva voce",
  description:
    "Voice-first AI study companion. Upload your materials and Viva turns them into a living oral exam — asking, listening, correcting, and bringing back what you miss.",
};

/**
 * Self-hosted (`FRONTEND-007`) — see `apps/web/app/fonts/PROVENANCE.md` for
 * the pinned upstream `google/fonts` commit, source paths, and SHA-256 of
 * every committed WOFF2. `next/font/local` generates the `@font-face`
 * rules and a scoped CSS custom property at build time from these local
 * files only, so no request ever reaches a remote Google-hosted font
 * origin. Each `src` entry's `weight` range matches the variable axis
 * range that file was partially instanced to, so `font-weight` values
 * within that range still interpolate.
 */
const cormorant = localFont({
  src: [
    { path: "./fonts/cormorant-latin-roman.woff2", style: "normal", weight: "400 600" },
    { path: "./fonts/cormorant-latin-italic.woff2", style: "italic", weight: "400 500" },
  ],
  display: "swap",
  variable: "--viva-font-serif",
});

const hankenGrotesk = localFont({
  src: [{ path: "./fonts/hanken-grotesk-latin.woff2", style: "normal", weight: "400 700" }],
  display: "swap",
  variable: "--viva-font-sans",
});

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`${cormorant.variable} ${hankenGrotesk.variable}`} lang="en">
      <body>{children}</body>
    </html>
  );
}
