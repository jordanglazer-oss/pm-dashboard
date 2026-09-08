"use client";

import { useEffect, useState } from "react";
import { AppIcon } from "./AppIcon";

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

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Scroll to top"
      title="Back to top"
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      className={`fixed bottom-5 right-5 z-40 grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-3 shadow-[var(--shadow-pop)] transition-all duration-200 hover:bg-surface-hover hover:text-ink print:hidden ${
        show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <AppIcon name="chevU" size={14} />
    </button>
  );
}
