"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Check auth by hitting a lightweight endpoint
    fetch("/api/auth/check")
      .then((res) => {
        if (res.ok) {
          setAuthed(true);
        } else {
          router.replace("/login");
        }
      })
      .catch(() => router.replace("/login"))
      .finally(() => setChecked(true));
  }, [router, pathname]);

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ground">
        <div className="text-[12.5px] text-ink-3">Loading</div>
      </div>
    );
  }

  if (!authed) return null;

  return <>{children}</>;
}
