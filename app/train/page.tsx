import type { Metadata } from "next";
import TrainPage from "@/components/TrainPage";

export const metadata: Metadata = { title: "Train · Scoresheet Scanner" };

export default function Page() {
  return <TrainPage />;
}
