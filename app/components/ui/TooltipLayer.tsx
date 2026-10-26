"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";

/**
 * Styled hover tips for every native `title` inside the wrapped region.
 *
 * Rather than rewrite ~130 `title=` call sites, this layer intercepts the
 * hover: it moves the element's `title` to `data-tip` while the pointer is on
 * it (so the slow grey browser tooltip never shows), renders a styled tip
 * positioned with Floating UI, and puts the `title` back on leave — so the
 * DOM React owns is identical once the pointer moves away. Menus portalled
 * out of the region (Radix popper content) are covered too.
 *
 * Purely presentational: no state outside this component, nothing persisted.
 */
export function TooltipLayer({ children, className }: { children: React.ReactNode; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; anchor: HTMLElement } | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let anchor: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastHiddenAt = 0;

    const inScope = (el: Element) => root.contains(el) || !!el.closest("[data-radix-popper-content-wrapper]");

    // Move title → data-tip so the native tooltip stays quiet while hovered.
    const stash = (el: HTMLElement) => {
      const t = el.getAttribute("title");
      if (t != null) {
        el.setAttribute("data-tip", t);
        el.removeAttribute("title");
      }
      return el.getAttribute("data-tip") ?? "";
    };
    const restore = (el: HTMLElement) => {
      const t = el.getAttribute("data-tip");
      // React may have re-rendered a fresh title meanwhile — that one wins.
      if (t != null && !el.hasAttribute("title")) el.setAttribute("title", t);
      el.removeAttribute("data-tip");
    };

    const hide = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (anchor) { restore(anchor); lastHiddenAt = Date.now(); }
      anchor = null;
      setTip(null);
    };

    const onOver = (e: PointerEvent | FocusEvent) => {
      const target = e.target as Element | null;
      if (!target || !(target instanceof Element) || !inScope(target)) return;
      const el = target.closest<HTMLElement>("[title], [data-tip]");
      if (!el || el === anchor) return;
      if (e.type === "focusin" && !el.matches(":focus-visible")) return;
      hide();
      const text = stash(el).trim();
      if (!text) { restore(el); return; }
      anchor = el;
      // A short delay so sweeping the mouse across a table doesn't flash tips;
      // immediate when moving from one tip straight to the next.
      const delay = Date.now() - lastHiddenAt < 400 ? 0 : 280;
      timer = setTimeout(() => setTip({ text, anchor: el }), delay);
    };

    const onOut = (e: PointerEvent | FocusEvent) => {
      if (!anchor) return;
      const next = (e as PointerEvent).relatedTarget as Node | null;
      if (next && anchor.contains(next)) return;
      hide();
    };

    // React can re-apply `title` while hovered (e.g. "Copied!") — re-stash and
    // refresh the text instead of letting the native tooltip appear on top.
    const onMove = () => {
      if (anchor && anchor.hasAttribute("title")) {
        const text = stash(anchor).trim();
        const a = anchor;
        setTip((cur) => (cur ? { text, anchor: a } : cur));
      }
    };

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("focusin", onOver);
    document.addEventListener("focusout", onOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      hide();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("focusin", onOver);
      document.removeEventListener("focusout", onOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  useEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) return;
    let alive = true;
    computePosition(tip.anchor, el, {
      placement: "top",
      strategy: "fixed",
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y, placement }) => {
      if (!alive) return;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.dataset.side = placement.split("-")[0];
      el.dataset.ready = "1";
    });
    return () => { alive = false; };
  }, [tip]);

  return (
    <div ref={rootRef} className={className}>
      {children}
      {tip && createPortal(
        <div ref={tipRef} role="tooltip" className="ui-tip">
          {tip.text}
        </div>,
        document.body,
      )}
    </div>
  );
}
