"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";

export type BriefAttachment = {
  id: string;
  label: string;
  section: string;
  dataUrl: string;
  addedAt: string;
};

type Props = {
  section: string;
  sectionLabel: string;
  attachments: BriefAttachment[];
  onAdd: (attachment: BriefAttachment) => void;
  onRemove: (id: string) => void;
  /** When true, the thumbnail grid is collapsed by default behind a
   *  "Show N screenshots" toggle. Useful for sections that routinely
   *  accumulate many images (e.g. JPM Flows) where a 3-row thumbnail grid
   *  eats valuable vertical space on every page load. The drop zone and
   *  Browse button remain visible so adding more is always one click away. */
  collapsibleThumbs?: boolean;
};

/** Returns true if the dataUrl points at a PDF rather than an image.
 *  Used by callers (ImageUpload thumbnails, scrape routes) to switch
 *  rendering / Anthropic block type. The MIME type is the source of
 *  truth — we don't sniff content. */
export function isPdfDataUrl(dataUrl: string): boolean {
  return dataUrl.startsWith("data:application/pdf");
}

/** Read a PDF file and return it as a base64 dataUrl, no compression
 *  (PDFs are already compressed and re-encoding would corrupt them).
 *  Anthropic's Files API accepts PDFs up to 32MB / 100 pages; we cap
 *  uploads at 15MB here so the resulting JSON payload (base64 inflates
 *  ~33%) stays under Vercel's 4.5MB request body limit on Hobby tier. */
function readPdfAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read PDF"));
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.readAsDataURL(file);
  });
}

/** Resize and compress an image to keep it under the size limit.
 *  Mac Retina screenshots are 2x resolution PNGs — this converts them
 *  to JPEG at reasonable dimensions so they work reliably with the API. */
function compressImage(file: File, maxWidth = 1600, quality = 0.8): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to load image"));
      img.onload = () => {
        // Scale down if wider than maxWidth (keeps aspect ratio)
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round(h * (maxWidth / w));
          w = maxWidth;
        }

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas not supported")); return; }
        ctx.drawImage(img, 0, 0, w, h);

        // Convert to JPEG (much smaller than PNG for screenshots)
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function ImageUpload({ section, sectionLabel, attachments, onAdd, onRemove, collapsibleThumbs }: Props) {
  const [dragActive, setDragActive] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Default to collapsed only when collapsibleThumbs is on AND there are
  // already images to hide. A fresh empty section shouldn't render the toggle
  // at all (handled below), and non-collapsible sections behave as before.
  const [thumbsExpanded, setThumbsExpanded] = useState(!collapsibleThumbs);
  const inputRef = useRef<HTMLInputElement>(null);

  const sectionAttachments = attachments.filter((a) => a.section === section);

  const processFile = useCallback(
    async (file: File) => {
      const isImage = file.type.startsWith("image/");
      const isPdf = file.type === "application/pdf";
      if (!isImage && !isPdf) {
        alert("Only images and PDFs are supported.");
        return;
      }

      // Per-type size caps. Images are aggressively re-compressed to
      // JPEG so 10MB raw is more than enough headroom. PDFs are
      // pass-through (re-encoding would corrupt them) so we cap at
      // 15MB to stay under Vercel's 4.5MB request body limit after
      // base64 inflation (~33%) when the route forwards to Anthropic.
      if (isImage && file.size > 10 * 1024 * 1024) {
        alert("Image too large. Please keep under 10MB.");
        return;
      }
      if (isPdf && file.size > 15 * 1024 * 1024) {
        alert("PDF too large. Please keep under 15MB. (Anthropic's hard limit is 32MB but we cap lower so requests fit Vercel's payload limit.)");
        return;
      }

      try {
        const dataUrl = isPdf ? await readPdfAsDataUrl(file) : await compressImage(file);
        onAdd({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: file.name.replace(/\.[^.]+$/, ""),
          section,
          dataUrl,
          addedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("File processing failed:", err);
        alert("Failed to process file. Try a smaller file or different format.");
      }
    },
    [onAdd, section]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files);
      files.forEach(processFile);
    },
    [processFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      files.forEach(processFile);
      if (inputRef.current) inputRef.current.value = "";
    },
    [processFile]
  );

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          {sectionLabel} Screenshots / PDFs
        </span>
        <span className="text-xs text-slate-400">
          ({sectionAttachments.length} file{sectionAttachments.length !== 1 ? "s" : ""})
        </span>
        {/* Toggle only renders when collapsibleThumbs is on AND there are
            attachments to show/hide. Non-collapsible sections never see this. */}
        {collapsibleThumbs && sectionAttachments.length > 0 && (
          <button
            type="button"
            onClick={() => setThumbsExpanded((v) => !v)}
            className="ml-auto text-[11px] font-semibold text-blue-600 hover:text-blue-700 focus:outline-none focus:underline"
            title={thumbsExpanded ? "Hide thumbnails" : "Show thumbnails"}
          >
            {thumbsExpanded ? "Hide ▲" : `Show ${sectionAttachments.length} ▼`}
          </button>
        )}
      </div>

      {/* Thumbnails — small, but with a generous click target. The X stays
          visible on touch devices (no hover) so it's always tappable, and
          appears on hover on desktop. Clicking the image opens a full-size
          lightbox instead of expanding inline (was eating too much vertical
          space when many screenshots were attached). When collapsibleThumbs is
          set, the whole grid is hidden until the user toggles "Show". */}
      {sectionAttachments.length > 0 && thumbsExpanded && (
        <div className="flex flex-wrap gap-2 mb-3">
          {sectionAttachments.map((att) => {
            const isPdf = isPdfDataUrl(att.dataUrl);
            return (
              <div key={att.id} className="group relative">
                <button
                  type="button"
                  onClick={() => setPreviewId(att.id)}
                  className="block h-12 w-12 rounded-md border border-slate-200 overflow-hidden hover:border-blue-400 focus:border-blue-400 focus:outline-none transition-colors"
                  title={`View ${att.label}${isPdf ? " (PDF)" : ""}`}
                >
                  {isPdf ? (
                    <span className="flex h-full w-full items-center justify-center bg-rose-50 text-rose-600 text-[10px] font-bold tracking-wider">
                      PDF
                    </span>
                  ) : (
                    <img src={att.dataUrl} alt={att.label} className="h-full w-full object-cover" />
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(att.id);
                  }}
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold shadow opacity-90 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 transition-opacity"
                  title="Remove"
                >
                  &times;
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Full-size lightbox modal. Opens on thumbnail click; closes on X,
          backdrop click, or Escape. Backdrop greys out the rest of the page. */}
      {previewId && (
        <LightboxModal
          attachments={sectionAttachments}
          currentId={previewId}
          onClose={() => setPreviewId(null)}
        />
      )}

      {/* Drop zone + explicit Browse button. Both the drop zone background
          and the button trigger the same multi-file picker, but the button
          makes it obvious to users that they can cmd/ctrl-click to select
          many files at once from Finder/Explorer. */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`flex items-center justify-center gap-3 rounded-xl border-2 border-dashed px-4 py-3 text-sm transition-colors ${
          dragActive
            ? "border-blue-400 bg-blue-50 text-blue-600"
            : "border-slate-200 bg-slate-50/50 text-slate-400 hover:border-slate-300 hover:text-slate-500"
        }`}
      >
        <span className="flex-1 text-center">
          {dragActive ? "Drop files here" : "Drop screenshots or PDFs here (multiple files OK)"}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
          className="rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors shrink-0"
        >
          Browse files…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          onChange={handleChange}
          className="hidden"
        />
      </div>
    </div>
  );
}

/* ─── Lightbox modal ────────────────────────────────────────────────
   Renders a centered full-size image with the page dimmed behind it.
   Closes on: clicking the X, clicking the backdrop, or pressing Escape.
   Arrow keys cycle between screenshots in the same section (handy when
   a section has 11 JPM flows images and you want to flip through them
   without reopening the modal each time).
*/
export function LightboxModal({
  attachments,
  currentId,
  onClose,
}: {
  attachments: BriefAttachment[];
  currentId: string;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState(currentId);

  const idx = attachments.findIndex((a) => a.id === activeId);
  const active = idx >= 0 ? attachments[idx] : attachments[0];

  const next = useCallback(() => {
    if (attachments.length <= 1) return;
    const i = attachments.findIndex((a) => a.id === activeId);
    const n = attachments[(i + 1) % attachments.length];
    setActiveId(n.id);
  }, [attachments, activeId]);

  const prev = useCallback(() => {
    if (attachments.length <= 1) return;
    const i = attachments.findIndex((a) => a.id === activeId);
    const p = attachments[(i - 1 + attachments.length) % attachments.length];
    setActiveId(p.id);
  }, [attachments, activeId]);

  // Escape closes; arrows navigate; body scroll locked while open so the
  // background doesn't scroll out from under the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, next, prev]);

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Close button — top-right of viewport so it's always findable */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-lg hover:bg-white hover:text-slate-900 transition-colors"
        title="Close (Esc)"
        aria-label="Close"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Prev/next navigation when the section has multiple screenshots */}
      {attachments.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); prev(); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-lg hover:bg-white hover:text-slate-900 transition-colors"
            title="Previous (←)"
            aria-label="Previous image"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); next(); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-lg hover:bg-white hover:text-slate-900 transition-colors"
            title="Next (→)"
            aria-label="Next image"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {/* Clicking the file viewer itself should NOT close the modal.
          PDFs render in an iframe; images render as <img>. Both share
          the same container size so navigation between mixed types
          stays smooth. */}
      <div
        className="max-w-[95vw] max-h-[90vh] flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {isPdfDataUrl(active.dataUrl) ? (
          <iframe
            src={active.dataUrl}
            title={active.label}
            className="w-[90vw] h-[85vh] rounded-lg shadow-2xl bg-white"
          />
        ) : (
          <img
            src={active.dataUrl}
            alt={active.label}
            className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
          />
        )}
        <div className="text-xs text-white/80 text-center">
          <div className="font-medium">
            {active.label}{isPdfDataUrl(active.dataUrl) ? " (PDF)" : ""}
          </div>
          {attachments.length > 1 && (
            <div className="text-white/60 mt-0.5">
              {idx + 1} of {attachments.length} · arrow keys to navigate · Esc to close
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
