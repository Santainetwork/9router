import { TableSkeleton } from "@/shared/components/Loading";

export default function Loading() {
  return <div className="mx-auto w-full max-w-7xl" aria-live="polite"><TableSkeleton rows={6} columns={4} /></div>;
}
