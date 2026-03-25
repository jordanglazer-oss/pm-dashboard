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

export function ImageUpload({ section, sectionLabel, attachments, onAdd, onRemove }: Props) {
  const [dragActive, setDragActive] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sectionAttachments = attachments.filter((a) => a.section === section);

  const processFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) return;
      // Limit to 2MB per image
      if (file.size > 2 * 1024 * 1024) {
        alert("Image too large. Please keep under 2MB.");
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        onAdd({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: file.name.replace(/\.[^.]+$/, ""),
          section,
          dataUrl,
          addedAt: new Date().toISOString(),
        });
      };
      reader.readAsDataURL(file);
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
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold shadow"
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
