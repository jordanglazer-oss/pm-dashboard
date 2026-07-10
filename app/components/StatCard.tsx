export function StatCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-3xl border border-line bg-white p-5 shadow-sm">
      <div className="text-sm text-ink-3">{title}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-ink">
        {value}
      </div>
      <div className="mt-2 text-sm text-ink-3">{sub}</div>
    </div>
  );
}
