"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

/** Workspace login — a centred 360px panel on the ground colour with the ink
 *  "P" mark. Same auth flow (POST /api/auth → cookie); styling only. */
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
      <div className="w-full max-w-[360px]">
        <div className="panel">
          <div className="panel-h">
            <span className="grid h-[22px] w-[22px] place-items-center rounded-[5px] bg-ink text-[12px] font-semibold text-white">P</span>
            <span className="t">PIM Workspace</span>
            <span className="m ml-auto">Team access</span>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3 px-3.5 py-3.5">
            <div>
              <label htmlFor="password" className="mb-1 block text-[11px] text-ink-3">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Team password"
                autoFocus
                className="h-7 w-full rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent-border"
              />
            </div>

            {error && (
              <p className="flex items-center gap-2 text-[12.5px] text-neg">
                <span className="dot bg-neg" />
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="h-7 w-full rounded-control bg-ink text-[12.5px] font-medium text-white transition-colors hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Checking" : "Enter"}
            </button>
          </form>
        </div>
        <p className="mt-3 text-center text-[11px] text-ink-3">Private team tool · sessions persist on this device</p>
      </div>
    </div>
  );
}
