import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Hanken_Grotesk, Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font (no font CDN dependency on the night).
// Hanken Grotesk 300 = the light display face; Inter = body/UI.
const display = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["300", "700"],
  variable: "--font-display",
  display: "swap",
});
const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Como 26/27 Auction",
  description: "Live auction-draft board for the Como fantasy league.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
