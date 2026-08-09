import { BenchmarkDetail } from "@/components/benchmarks/BenchmarkDetail";

export const dynamic = "force-dynamic";

export default async function BenchmarkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BenchmarkDetail id={Number(id)} />;
}
