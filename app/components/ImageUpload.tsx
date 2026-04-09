"use client";

import React, { useState, useRef, useCallback } from "react";

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
};

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

export function ImageUpload({ section, sectionLabel, attachments, onAdd, onRemove }: Props) {
  const [dragActive, setDragActive] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sectionAttachments = attachments.filter((a) => a.section === section);

  const processFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;
      // Reject extremely large files (>10MB raw)
      if (file.size > 10 * 1024 * 1024) {
        alert("Image too large. Please keep under 10MB.");
        return;
      }

      try {
        // Compress and resize to JPEG — handles Retina PNGs gracefully
        const dataUrl = await compressImage(file);
        onAdd({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: file.name.replace(/\.[^.]+$/, ""),
          section,
          dataUrl,
          addedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("Image processing failed:", err);
        alert("Failed to process image. Try a smaller file or different format.");
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
          {sectionLabel} Screenshots
        </span>
        <span className="text-xs text-slate-400">
          ({sectionAttachments.length} image{sectionAttachments.length !== 1 ? "s" : ""})
        </span>
      </div>

      {/* Thumbnails */}
      {sectionAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {sectionAttachments.map((att) => (
            <div key={att.id} className="group relative">
              <img
                src={att.dataUrl}
                alt={att.label}
                className="h-20 w-auto rounded-lg border border-slate-200 object-cover cursor-pointer hover:border-blue-400 transition-colors"
                onClick={() => setPreviewId(previewId === att.id ? null : att.id)}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(att.id);
                }}
                className="absolute -top-1.5 -right-1.5 flex md:hidden md:group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold shadow"
                title="Remove"
              >
                &times;
              </button>
              <div className="text-[10px] text-slate-400 mt-0.5 max-w-[80px] truncate">
                {att.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Expanded preview */}
      {previewId && (
        <div className="mb-3">
          {sectionAttachments
            .filter((a) => a.id === previewId)
            .map((att) => (
              <div key={att.id} className="relative inline-block">
                <img
                  src={att.dataUrl}
                  alt={att.label}
                  className="max-w-full max-h-[400px] rounded-xl border border-slate-200 shadow-sm"
                />
                <button
                  onClick={() => setPreviewId(null)}
                  className="absolute top-2 right-2 rounded-full bg-slate-800/70 text-white px-2 py-0.5 text-xs hover:bg-slate-800"
                >
                  Close
                </button>
              </div>
            ))}
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex items-center justify-center rounded-xl border-2 border-dashed px-4 py-3 text-sm cursor-pointer transition-colors ${
          dragActive
            ? "border-blue-400 bg-blue-50 text-blue-600"
            : "border-slate-200 bg-slate-50/50 text-slate-400 hover:border-slate-300 hover:text-slate-500"
        }`}
      >
        <span>{dragActive ? "Drop image here" : "Drop screenshot or click to upload"}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleChange}
          className="hidden"
        />
      </div>
    </div>
  );
}
