"use client";

import { SetupScan } from "@/app/components/SetupScan";

/**
 * Setups — the technical setup scan, promoted from a bucket inside the
 * Rankings table to its own Ideas segment. The component is unchanged; only
 * where it mounts moved. The Technical · Radar · Setups · Factor mode switch
 * is rendered by the shell above this page.
 */
export default function SetupsPage() {
  return <SetupScan />;
}
