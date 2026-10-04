import { handleMaterialRequest } from "@/lib/materials/server";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleMaterialRequest(request, (await context.params).id, true);
}
