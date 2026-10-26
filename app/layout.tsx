import type { Metadata } from "next";
import { Manrope, Instrument_Serif } from "next/font/google";
import "./globals.css";

// Manrope for text AND numbers (numbers use tabular figures, set in
// globals.css) — exposed as --font-body, consumed by the Tailwind @theme
// tokens (--font-sans, and --font-mono which aliases it). Instrument Serif is
// the display face for page titles and headline figures (`font-display`).
const bodySans = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});
const displaySerif = Instrument_Serif({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PM Dashboard",
  description: "Portfolio management dashboard with AI-powered stock scoring and market analysis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${bodySans.variable} ${displaySerif.variable}`}>
      <body className="antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
