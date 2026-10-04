import { handleMaterialRequest } from "@/lib/materials/server";
type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export async function GET(request: Request, context: Context) {
  return handleMaterialRequest(request, (await context.params).id);
}
export async function DELETE(request: Request, context: Context) {
  return handleMaterialRequest(request, (await context.params).id);
}
