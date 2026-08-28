"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * /attribution merged into the Performance segment (/aa-performance).
 * The route survives for deep links + muscle memory and forwards to the
 * merged page's attribution section.
 */
export default function AttributionPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/aa-performance#attribution");
  }, [router]);
  return null;
}
