"use client";

import React from "react";

/**
 * The hedge-position ledger (pm:hedges) as a context.
 *
 * MorningBrief owns the fetch, the form state and the persist path; the
 * Brief's Hedging cell (SummaryTop) consumes it so "log a hedge" / "close"
 * are reachable from the one place the call is shown. Nothing about the data
 * flow changes — this only lets the UI live where the call lives.
 */

export type HedgePos = {
  id: string;
  status: "active" | "closed";
  implementedAt: string;
  expiry?: string;
  tenorLabel?: string;
  strikePctOtm?: number;
  strikePrice?: number;
  spotAtEntry?: number;
  premiumPctOfSpot?: number;
  premiumUsd?: number;
  contracts?: number;
  notes?: string;
};

export type HedgeLedger = {
  hedges: HedgePos[];
  /** Active, non-expired positions. */
  active: HedgePos[];
  /** Bumps on every persisted change so readers can re-sync derived reads. */
  version: number;
  showForm: boolean;
  form: Partial<HedgePos>;
  setForm: React.Dispatch<React.SetStateAction<Partial<HedgePos>>>;
  openForm: () => void;
  cancelForm: () => void;
  save: () => Promise<void>;
  saving: boolean;
  close: (id: string) => Promise<void>;
};

export const HedgeLedgerContext = React.createContext<HedgeLedger | null>(null);
