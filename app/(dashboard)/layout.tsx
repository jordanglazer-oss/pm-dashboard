import { Providers } from "../providers";
import { Navigation } from "../components/Navigation";
import { PortfolioTabs } from "../components/PortfolioTabs";
import { ResearchTabs } from "../components/ResearchTabs";
import { AuthGate } from "../components/AuthGate";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGate>
      <Providers>
        <Navigation />
        <PortfolioTabs />
        <ResearchTabs />
        {children}
      </Providers>
    </AuthGate>
  );
}
