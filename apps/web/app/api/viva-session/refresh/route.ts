import type { NextRequest } from "next/server";
import { handleVivaSessionRefresh } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleVivaSessionRefresh(request);
}
