import { corsPreflight, oauthError, oauthJson } from "@/lib/oauth/http";
import { handleTokenRequest } from "@/lib/oauth/tokens";

async function readParams(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(body).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
    }
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

// The token endpoint: authorization codes (with PKCE) and rotating refresh
// tokens. Clients are public, so client_id identifies them and nothing else.
export async function POST(request: Request) {
  const params = await readParams(request);
  if (!params) return oauthError("invalid_request", "The request body could not be read");

  const result = await handleTokenRequest(params);
  if (!result.ok) return oauthError(result.error, result.description, result.status);
  return oauthJson(result.body);
}

export function OPTIONS() {
  return corsPreflight();
}
