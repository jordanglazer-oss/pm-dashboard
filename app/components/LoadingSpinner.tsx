export function LoadingSpinner({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-ink" />
      <span className="text-sm text-ink-3">{message}</span>
    </div>
  );
}

export function LoadingOverlay({ message = "Generating..." }: { message?: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-card bg-white/80 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
        <span className="text-lg font-medium text-ink-2">{message}</span>
      </div>
    </div>
  );
}
