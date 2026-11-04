import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// The root layout every page shares: the page language, the fonts and the
// global styles.

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Squadroom",
  description: "A browser console for running a squad of coding agents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Browser extensions add styles to <html> and <body> before React
    // hydrates; only those two elements' own attributes are exempt.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
