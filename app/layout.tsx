import type { Metadata } from "next";
import { IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

// One type family site-wide: IBM Plex Sans for text AND numbers (numbers use
// tabular figures, set in globals.css). Exposed as a CSS variable consumed by
// the Tailwind @theme tokens (--font-sans, and --font-mono which aliases it).
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
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
    <html lang="en" className={plexSans.variable}>
      <body className="antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
