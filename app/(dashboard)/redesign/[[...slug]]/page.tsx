"use client";

import { useParams } from "next/navigation";
import RedesignShell from "@/app/components/redesign/Shell";

/**
 * /redesign/[[...slug]] — design options for the team rebuild (Nov 2026).
 * Preview pages BESIDE the existing screens; see app/components/redesign/.
 */
export default function RedesignPage() {
  const params = useParams<{ slug?: string[] }>();
  return <RedesignShell slug={params?.slug ?? []} />;
}
