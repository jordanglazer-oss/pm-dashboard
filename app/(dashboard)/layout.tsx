import { Providers } from "../providers";
import { Navigation } from "../components/Navigation";
import { PortfolioTabs } from "../components/PortfolioTabs";
import { ResearchTabs } from "../components/ResearchTabs";
import { IdeasTabs } from "../components/IdeasTabs";
import { BriefTabs } from "../components/BriefTabs";
import { ScrollToTop } from "../components/ScrollToTop";
import { ToastHost } from "../components/ToastHost";
import { PageTransition } from "../components/PageTransition";
import { AuthGate } from "../components/AuthGate";
import { NavHistoryTracker, BackCrumb } from "../lib/nav-history";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGate>
      <Providers>
        <Navigation />
        {/* Workspace shell: the rail is fixed at 200px on md+, so the whole
            content column (top bar included — it lives inside Navigation and
            is sticky within this column) shifts right by that width. */}
        <div className="app-content md:pl-[200px]">
          <PortfolioTabs />
          <ResearchTabs />
          <IdeasTabs />
          <BriefTabs />
          <NavHistoryTracker />
          <BackCrumb />
          <PageTransition>{children}</PageTransition>
        </div>
        <ScrollToTop />
        <ToastHost />
      </Providers>
    </AuthGate>
  );
}
