/**
 * Skeleton placeholders — a calm pulse in the Precision Light palette, used
 * where the shape of the incoming content is known (tables, cards) so a load
 * reads as "content arriving" rather than a bare "Loading…" string.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded bg-line ${className}`} aria-hidden>
      <span className="shimmer-sweep" />
    </div>
  );
}

/** A table-shaped placeholder: a lighter header strip + `rows` of cells. The
 *  first column is wider (a name), the rest flex evenly (numeric columns). */
export function SkeletonTable({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      <div className="flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className={`h-2.5 bg-line-soft ${i === 0 ? "w-36" : "flex-1"}`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? "w-36" : "flex-1"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
