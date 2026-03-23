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
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">{title}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
        {value}
      </div>
      <div className="mt-2 text-sm text-slate-500">{sub}</div>
    </div>
  );
}
