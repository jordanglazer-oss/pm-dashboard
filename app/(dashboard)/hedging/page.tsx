import HedgingDashboard from "@/app/components/HedgingDashboard";
import { PageHeading } from "@/app/components/PageHeading";

export default function HedgingPage() {
  return (
    <div className="flex flex-col gap-3.5 text-ink">
      <PageHeading lede="What protection the book has on, what it would cost to add more, and how cheap or dear that protection is today." />
      <HedgingDashboard />
    </div>
  );
}
