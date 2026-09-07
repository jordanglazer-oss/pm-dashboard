import React from "react";

type Tone = "red" | "amber" | "green" | "blue" | "gray";

// Workspace redesign: the only pills left are verdict words — 18px, soft
// tint, no border. Everything else that used to be a pill is plain text.
const toneClasses: Record<Tone, string> = {
  red: "bg-neg-soft text-neg",
  amber: "bg-warn-soft text-warn",
  green: "bg-pos-soft text-pos",
  blue: "bg-accent-soft text-accent-ink",
  gray: "bg-surface-2 text-ink-2",
};

export function SignalPill({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={`inline-flex h-[18px] items-center whitespace-nowrap rounded px-1.5 text-[11px] font-medium ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

export function ratingTone(rating: string): Tone {
  if (rating === "Buy") return "green";
  if (rating === "Sell") return "red";
  return "amber";
}

export function riskTone(risk: string): Tone {
  if (risk === "High") return "red";
  if (risk === "Low") return "green";
  return "amber";
}
