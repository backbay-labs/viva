import { LandingEntry } from "../components/landing/LandingEntry";
import { fetchVivaLibrarySnapshot, vivaStaticExportEnabled } from "../lib/viva-agent-client";
import { browserInitialLibrarySnapshot, type VivaLibrarySnapshot } from "../lib/viva-library";

export default async function Page() {
  const initialLibrarySnapshot = await initialSnapshot();
  return <LandingEntry initialLibrarySnapshot={initialLibrarySnapshot} />;
}

async function initialSnapshot(): Promise<VivaLibrarySnapshot | null> {
  try {
    return browserInitialLibrarySnapshot(await fetchVivaLibrarySnapshot(), {
      staticExport: vivaStaticExportEnabled(),
    });
  } catch {
    return null;
  }
}
