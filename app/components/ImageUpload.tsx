"use client";

import { usePersistedOpen } from "@/app/lib/useCollapsed";
import React, { useState, useRef, useCallback, useEffect } from "react";
import { AppIcon } from "./AppIcon";

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

/** Shared file → BriefAttachment pipeline (type + size checks, image
 *  re-compression, PDF pass-through). Used by every drop/browse/paste path. */
function useProcessFile(section: string, onAdd: (attachment: BriefAttachment) => void) {
  return useCallback(
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
          label: file.name.replace(/\.[^.]+$/, "") || "pasted-image",
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
}

/**
 * Compact 28px control: "Paste or drop screenshot". It is a drop target, a
 * click-to-browse button, and (when `paste` is on) a clipboard listener —
 * a screenshot copied from anywhere lands in the section on ⌘V. Used in
 * panel headers where the full dashed drop zone would be too tall.
 */
export function ImageDropButton({
  section,
  onAdd,
  label = "Paste or drop screenshot",
  paste = false,
  className = "",
  title,
}: {
  section: string;
  onAdd: (attachment: BriefAttachment) => void;
  label?: string;
  /** Listen for document-level paste events while mounted. Turn on for
   *  exactly ONE section at a time, or a pasted image lands everywhere. */
  paste?: boolean;
  className?: string;
  title?: string;
}) {
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const processFile = useProcessFile(section, onAdd);

  useEffect(() => {
    if (!paste) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter(
        (f) => f.type.startsWith("image/") || f.type === "application/pdf",
      );
      if (files.length === 0) return;
      e.preventDefault();
      files.forEach((f) => void processFile(f));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [paste, processFile]);

  return (
    <span
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        Array.from(e.dataTransfer.files).forEach((f) => void processFile(f));
      }}
      className={`inline-flex ${className}`}
    >
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        title={title ?? `${label} (${paste ? "⌘V pastes from the clipboard, or " : ""}drop a file on this button, or click to browse)`}
        className={`inline-flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-[12.5px] transition-colors ${
          dragActive
            ? "border-accent-border bg-accent-soft text-accent"
            : "border-line bg-surface text-ink-2 hover:bg-surface-hover"
        }`}
      >
        <AppIcon name="upload" size={13} strokeWidth={2} />
        {dragActive ? "Drop to add" : label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        onChange={(e) => {
          Array.from(e.target.files || []).forEach((f) => void processFile(f));
          if (inputRef.current) inputRef.current.value = "";
        }}
        className="hidden"
      />
    </span>
  );
}

/**
 * Thumbnail strip for one section's attachments: click opens the lightbox,
 * the x removes. Renders nothing when the section has no files. With
 * `collapsible`, the strip folds behind a persisted "Show N" toggle.
 */
export function AttachmentThumbs({
  section,
  attachments,
  onRemove,
  collapsible = false,
  size = "sm",
  className = "",
}: {
  section: string;
  attachments: BriefAttachment[];
  onRemove: (id: string) => void;
  collapsible?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Default to collapsed only when collapsible is on AND there are already
  // images to hide. Persisted so the choice survives a refresh.
  const [thumbsExpanded, toggleThumbs] = usePersistedOpen(`upload.thumbs.${section}`, !collapsible);
  const sectionAttachments = attachments.filter((a) => a.section === section);
  if (sectionAttachments.length === 0) return null;
  const dim = size === "md" ? "h-12 w-12" : "h-7 w-9";
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {collapsible && (
        <button
          type="button"
          onClick={toggleThumbs}
          className="inline-flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-ink"
          title={thumbsExpanded ? "Hide thumbnails" : "Show thumbnails"}
        >
          {thumbsExpanded ? "Hide" : `Show ${sectionAttachments.length}`}
          <AppIcon name={thumbsExpanded ? "chevU" : "chevD"} size={12} strokeWidth={2} />
        </button>
      )}
      {thumbsExpanded && sectionAttachments.map((att) => {
        const isPdf = isPdfDataUrl(att.dataUrl);
        return (
          <div key={att.id} className="group relative">
            <button
              type="button"
              onClick={() => setPreviewId(att.id)}
              className={`block ${dim} overflow-hidden rounded-control border border-line transition-colors hover:border-accent-border focus:border-accent-border focus:outline-none`}
              title={`View ${att.label}${isPdf ? " (PDF)" : ""}`}
            >
              {isPdf ? (
                <span className="flex h-full w-full items-center justify-center bg-surface-2 font-mono text-[9px] font-medium text-ink-2">PDF</span>
              ) : (
                <img src={att.dataUrl} alt={att.label} className="h-full w-full object-cover" />
              )}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(att.id); }}
              className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full border border-line bg-surface text-ink-2 opacity-90 transition-opacity hover:text-neg md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
              title="Remove"
              aria-label={`Remove ${att.label}`}
            >
              <AppIcon name="x" size={9} strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
      {previewId && (
        <LightboxModal attachments={sectionAttachments} currentId={previewId} onClose={() => setPreviewId(null)} />
      )}
    </div>
  );
}

export function ImageUpload({ section, sectionLabel, attachments, onAdd, onRemove, collapsibleThumbs }: Props) {
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const processFile = useProcessFile(section, onAdd);
  const sectionAttachments = attachments.filter((a) => a.section === section);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      Array.from(e.dataTransfer.files).forEach((f) => void processFile(f));
    },
    [processFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      Array.from(e.target.files || []).forEach((f) => void processFile(f));
      if (inputRef.current) inputRef.current.value = "";
    },
    [processFile]
  );

  return (
    <div className="mt-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-3">
        <span>{sectionLabel} screenshots / PDFs</span>
        <span className="font-mono">{sectionAttachments.length} file{sectionAttachments.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Thumbnails — click opens the lightbox; the x removes. With
          collapsibleThumbs the strip folds behind a persisted toggle. */}
      <AttachmentThumbs
        section={section}
        attachments={attachments}
        onRemove={onRemove}
        collapsible={!!collapsibleThumbs}
        size="md"
        className="mb-2.5"
      />

      {/* Drop zone + explicit Browse button. Both the drop zone background
          and the button trigger the same multi-file picker, but the button
          makes it obvious to users that they can cmd/ctrl-click to select
          many files at once from Finder/Explorer. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`flex items-center justify-center gap-3 rounded-card border border-dashed px-3.5 py-2.5 text-[12.5px] transition-colors ${
          dragActive ? "border-accent-border bg-accent-soft text-accent" : "border-line bg-surface-2 text-ink-3"
        }`}
      >
        <span className="flex-1 text-center">
          {dragActive ? "Drop files here" : "Drop screenshots or PDFs here (multiple files OK)"}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover"
        >
          <AppIcon name="upload" size={13} strokeWidth={2} />
          Browse files
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

  const navBtn = "absolute flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-[var(--shadow-pop)] transition-colors hover:text-ink";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Close button — top-right of viewport so it's always findable */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className={`${navBtn} right-4 top-4`}
        title="Close (Esc)"
        aria-label="Close"
      >
        <AppIcon name="x" size={16} strokeWidth={2} />
      </button>

      {/* Prev/next navigation when the section has multiple screenshots */}
      {attachments.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); prev(); }}
            className={`${navBtn} left-4 top-1/2 -translate-y-1/2`}
            title="Previous (←)"
            aria-label="Previous image"
          >
            <AppIcon name="chevL" size={16} strokeWidth={2} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); next(); }}
            className={`${navBtn} right-4 top-1/2 -translate-y-1/2`}
            title="Next (→)"
            aria-label="Next image"
          >
            <AppIcon name="chevR" size={16} strokeWidth={2} />
          </button>
        </>
      )}

      {/* Clicking the file viewer itself should NOT close the modal.
          PDFs render in an iframe; images render as <img>. Both share
          the same container size so navigation between mixed types
          stays smooth. */}
      <div
        className="flex max-h-[90vh] max-w-[95vw] flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {isPdfDataUrl(active.dataUrl) ? (
          <iframe
            src={active.dataUrl}
            title={active.label}
            className="h-[85vh] w-[90vw] rounded-card bg-surface"
          />
        ) : (
          <img
            src={active.dataUrl}
            alt={active.label}
            className="max-h-[85vh] max-w-full rounded-card object-contain"
          />
        )}
        <div className="text-center text-[12px] text-white/80">
          <div className="font-medium">
            {active.label}{isPdfDataUrl(active.dataUrl) ? " (PDF)" : ""}
          </div>
          {attachments.length > 1 && (
            <div className="mt-0.5 text-white/60">
              {idx + 1} of {attachments.length} · arrow keys to navigate · Esc to close
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
