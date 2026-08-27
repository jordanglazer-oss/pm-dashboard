"use client";

import { SetupScan } from "@/app/components/SetupScan";

/**
 * Setups — the technical setup scan, promoted from a bucket inside the
 * Rankings table to its own Ideas segment. The component is unchanged; only
 * where it mounts moved.
 */
export default function SetupsPage() {
  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <SetupScan />
      </div>
    </main>
  );
}
