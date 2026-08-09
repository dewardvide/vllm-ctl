import { DeploymentDetail } from "@/components/deployments/DeploymentDetail";

export const dynamic = "force-dynamic";

export default async function DeploymentDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <DeploymentDetail runId={Number(runId)} />;
}
