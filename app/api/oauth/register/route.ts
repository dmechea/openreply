import { registerClient } from "@/lib/oauth/clients";
import { corsPreflight, oauthError, oauthJson } from "@/lib/oauth/http";

// Dynamic client registration (RFC 7591), used by the Claude app when someone
// adds this deployment as a connector.
export async function POST(request: Request) {
  let metadata: unknown;
  try {
    const text = await request.text();
    if (text.length > 20_000) {
      return oauthError("invalid_client_metadata", "The registration request is too large");
    }
    metadata = JSON.parse(text);
  } catch {
    return oauthError("invalid_client_metadata", "The body must be JSON client metadata");
  }

  const result = await registerClient(metadata);
  if (!result.ok) return oauthError(result.error, result.description);
  return oauthJson(result.body, 201);
}

export function OPTIONS() {
  return corsPreflight();
}
