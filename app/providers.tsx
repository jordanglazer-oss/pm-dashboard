"use client";

import { StockProvider } from "@/app/lib/StockContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return <StockProvider>{children}</StockProvider>;
}
