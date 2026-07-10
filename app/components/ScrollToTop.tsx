"use client";

import { useEffect, useState } from "react";

/**
 * A back-to-top control for the long data pages (stock detail, research, models).
 * Appears once the page is scrolled past a threshold and smooth-scrolls to the
 * top. Global (mounted in the dashboard layout) but self-hides until needed, so
 * it never intrudes on short pages.
 */
export function ScrollToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!show) return null;

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Scroll to top"
      title="Back to top"
      className="fixed bottom-5 right-5 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-md transition-colors hover:bg-surface-2 hover:text-ink print:hidden"
    >
      <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
      </svg>
    </button>
  );
}
