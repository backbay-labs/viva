import type { Metadata } from "next";
import { LiveSessionPage } from "../../components/session/LiveSessionPage";

export const metadata: Metadata = {
  title: "Viva · Live session",
  description: "A live oral exam drawn from your sources — the listening manuscript.",
};

export default function Page() {
  return <LiveSessionPage />;
}
