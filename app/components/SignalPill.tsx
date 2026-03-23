import React from "react";

type Tone = "red" | "amber" | "green" | "blue" | "gray";

const toneClasses: Record<Tone, string> = {
  red: "border border-red-200 bg-red-50 text-red-600",
  amber: "border border-amber-200 bg-amber-50 text-amber-600",
  green: "border border-emerald-200 bg-emerald-50 text-emerald-600",
  blue: "border border-blue-200 bg-blue-50 text-blue-600",
  gray: "border border-slate-200 bg-slate-100 text-slate-700",
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
