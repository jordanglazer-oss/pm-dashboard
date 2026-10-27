import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

// Manrope for text AND numbers (numbers use tabular figures, set in
// globals.css) — exposed as --font-body, consumed by the Tailwind @theme
// tokens (--font-sans, --font-mono and --font-display all alias it): one
// clean face site-wide, titles and headline figures included.
const bodySans = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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
    <html lang="en" className={bodySans.variable}>
      <body className="antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
