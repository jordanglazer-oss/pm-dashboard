import React from "react";

type Tone = "red" | "amber" | "green" | "blue" | "gray";

const toneClasses: Record<Tone, string> = {
  red: "border border-neg-border bg-neg-soft text-neg",
  amber: "border border-warn-border bg-warn-soft text-warn",
  green: "border border-pos-border bg-pos-soft text-pos",
  blue: "border border-accent-border bg-accent-soft text-accent",
  gray: "border border-line bg-surface-2 text-ink-2",
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
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${toneClasses[tone]}`}
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
