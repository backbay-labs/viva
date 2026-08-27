import type { NextRequest } from "next/server";
import { handleVivaSessionProjection } from "../shared";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleVivaSessionProjection(request);
}
