export function LoadingSpinner({ message = "Loading" }: { message?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-3">
      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-ink-3" />
      <span className="text-[12.5px] text-ink-3">{message}</span>
    </div>
  );
}

export function LoadingOverlay({ message = "Generating" }: { message?: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-card bg-surface/80 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-ink-3" />
        <span className="text-[12.5px] text-ink-2">{message}</span>
      </div>
    </div>
  );
}
