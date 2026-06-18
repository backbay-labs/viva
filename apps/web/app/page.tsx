import { LandingEntry } from "../components/landing/LandingEntry";
import { fetchVivaLibrarySnapshot } from "../lib/viva-agent-client";
import type { VivaLibrarySnapshot } from "../lib/viva-library";

export default async function Page() {
  const initialLibrarySnapshot = await initialSnapshot();
  return <LandingEntry initialLibrarySnapshot={initialLibrarySnapshot} />;
}

async function initialSnapshot(): Promise<VivaLibrarySnapshot | null> {
  try {
    return await fetchVivaLibrarySnapshot();
  } catch {
    return null;
  }
}
