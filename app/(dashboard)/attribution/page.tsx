"use client";

import React from "react";
import { Attribution } from "@/app/components/Attribution";

export default function AttributionPage() {
  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-ink">Attribution</h1>
          <p className="mt-1 text-sm text-ink-3">
            Where your return came from — market, currency, and selection. Use ← / → to switch models.
          </p>
        </div>
        <Attribution />
      </div>
    </main>
  );
}
