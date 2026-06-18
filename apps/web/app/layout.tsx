import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Viva — your notes, viva voce",
  description:
    "Voice-first AI study companion. Upload your materials and Viva turns them into a living oral exam — asking, listening, correcting, and bringing back what you miss.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/*
          Cormorant (serif) + Hanken Grotesk (sans) are the families the design
          tokens already name (@viva/tokens, --serif/--sans). Loaded via a stylesheet
          <link> rather than next/font on purpose: next/font/google fetches at build
          time and fails the build with no network; the <link> degrades gracefully to
          Georgia/system instead. Keep it this way unless self-hosting the fonts.
        */}
        <link href="https://fonts.googleapis.com" rel="preconnect" />
        <link crossOrigin="anonymous" href="https://fonts.gstatic.com" rel="preconnect" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
