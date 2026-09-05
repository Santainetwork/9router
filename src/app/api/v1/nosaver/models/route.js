import { GET as modelsGet, OPTIONS as modelsOptions } from "@/app/api/v1/models/route";

export async function OPTIONS() {
  return await modelsOptions();
}

export async function GET(request) {
  return await modelsGet(request);
}
