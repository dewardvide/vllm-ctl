import { Suspense } from "react";

import { DeploymentForm } from "@/components/deployments/DeploymentForm";

export const dynamic = "force-dynamic";

export default function NewDeploymentPage() {
  return (
    <Suspense fallback={<p className="px-3 py-4 plate">loading</p>}>
      <DeploymentForm />
    </Suspense>
  );
}
