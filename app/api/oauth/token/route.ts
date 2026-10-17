import { closingConnection, readBodyText } from "@/lib/oauth/body";
import { corsPreflight, oauthError, oauthJson } from "@/lib/oauth/http";
import { handleTokenRequest } from "@/lib/oauth/tokens";

// Far more than any token request needs.
const BODY_LIMIT_BYTES = 20_000;

// Token requests are form-encoded (RFC 6749 §4.1.3, §6), and nothing else is read.
function isFormEncoded(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  return type.split(";")[0].trim().toLowerCase() === "application/x-www-form-urlencoded";
}

// The token endpoint: authorization codes (with PKCE) and rotating refresh
// tokens. Clients are public, so client_id identifies them and nothing else.
export async function POST(request: Request) {
  if (!isFormEncoded(request)) {
    return oauthError("invalid_request", "The request body must be form-encoded");
  }
  let text: string | null;
  try {
    text = await readBodyText(request, BODY_LIMIT_BYTES);
  } catch {
    return oauthError("invalid_request", "The request body could not be read");
  }
  if (text === null) {
    return closingConnection(oauthError("invalid_request", "The request body is too large"));
  }

  const result = await handleTokenRequest(new URLSearchParams(text));
  if (!result.ok) return oauthError(result.error, result.description, result.status);
  return oauthJson(result.body);
}

export function OPTIONS() {
  return corsPreflight();
}
