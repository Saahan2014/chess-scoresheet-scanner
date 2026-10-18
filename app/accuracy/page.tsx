import type { Metadata } from "next";
import AccuracyPage from "@/components/AccuracyPage";

export const metadata: Metadata = { title: "Accuracy test · Scoresheet Scanner" };

export default function Page() {
  return <AccuracyPage />;
}
