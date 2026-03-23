import { Providers } from "../providers";
import { Navigation } from "../components/Navigation";
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
        {children}
      </Providers>
    </AuthGate>
  );
}
