"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

/** Precision Light login — the last screen still wearing the old dark theme.
 *  Same auth flow (POST /api/auth → cookie); styling only. */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        setError("Incorrect password");
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-[9px] bg-accent text-[17px] font-bold text-white">P</span>
          <span className="text-xl font-bold tracking-tight text-ink">PIM Dashboard</span>
        </div>
        <div className="rounded-card border border-line bg-surface p-7 shadow-card">
          <h1 className="text-[15px] font-bold text-ink">Team access</h1>
          <p className="mt-1 text-xs text-ink-3">Enter the team password to continue</p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label htmlFor="password" className="mb-1.5 block text-[11px] font-semibold text-ink-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoFocus
                className="w-full rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-1 focus:ring-accent-soft"
              />
            </div>

            {error && <p className="text-sm text-neg">{error}</p>}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full rounded-control bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Checking…" : "Enter"}
            </button>
          </form>
        </div>
        <p className="mt-4 text-center text-[11px] text-ink-3">Private team tool · sessions persist on this device</p>
      </div>
    </div>
  );
}
