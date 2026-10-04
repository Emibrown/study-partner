import { handleMaterialRequest } from "@/lib/materials/server";
export const runtime = "nodejs";
export const GET = (request: Request) => handleMaterialRequest(request);
export const POST = (request: Request) => handleMaterialRequest(request);
