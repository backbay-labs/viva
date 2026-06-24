import type { NextRequest } from "next/server";
import { handleVivaSessionStart } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleVivaSessionStart(request);
}
