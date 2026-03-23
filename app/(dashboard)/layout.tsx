import { Providers } from "../providers";
import { Navigation } from "../components/Navigation";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <Navigation />
      {children}
    </Providers>
  );
}
