"use client";

import { StockProvider } from "@/app/lib/StockContext";
import { NotificationsProvider } from "@/app/lib/NotificationsContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NotificationsProvider>
      <StockProvider>{children}</StockProvider>
    </NotificationsProvider>
  );
}
