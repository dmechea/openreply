import { NextResponse, type NextRequest } from "next/server";
import {
  AUTHORIZATION_PARAMS,
  authorizationResponseUrl,
  checkAuthorizationRequest,
  grantedScopes,
  issueAuthorizationCode,
} from "@/lib/oauth/authorization";
import { issuer, OAUTH_PATHS } from "@/lib/oauth/config";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

function plainText(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// Only the consent page itself may submit an approval. The session cookie is
// SameSite=Lax already; this also refuses a framed or cross-site form.
function isSameOriginForm(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== issuer()) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const destination = request.headers.get("sec-fetch-dest");
  return destination === null || destination === "document";
}

// The consent page's form: approve or cancel an authorization request. The
// request is checked again here, since the form fields came from the browser.
export async function POST(request: NextRequest) {
  if (!isSameOriginForm(request)) {
    return plainText("This approval must come from the OpenReply consent page.", 403);
  }

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const name of AUTHORIZATION_PARAMS) {
    const value = form.get(name);
    if (typeof value === "string") params.set(name, value);
  }

  const check = await checkAuthorizationRequest(params);
  if (!check.ok) {
    if (check.redirectTo) return NextResponse.redirect(check.redirectTo, 303);
    return plainText(check.description, 400);
  }
  const { redirectUri, state } = check.request;

  if (form.get("decision") !== "allow") {
    return NextResponse.redirect(
      authorizationResponseUrl(redirectUri, {
        error: "access_denied",
        error_description: "The connection was cancelled",
        state,
      }),
      303
    );
  }

  const context = await getCurrentWorkspaceContext();
  if (!context) {
    const login = new URL("/login", issuer());
    login.searchParams.set("callbackUrl", `${OAUTH_PATHS.authorize}?${params}`);
    return NextResponse.redirect(login, 303);
  }
  if (!canManageWorkspace(context.role)) {
    return plainText("Only workspace owners and admins can connect apps.", 403);
  }

  const ticked = form.getAll("grant").filter((value) => typeof value === "string");
  const code = await issueAuthorizationCode({
    request: check.request,
    userId: context.userId,
    workspaceId: context.workspaceId,
    scopes: grantedScopes(check.request.scopes, ticked),
  });
  return NextResponse.redirect(authorizationResponseUrl(redirectUri, { code, state }), 303);
}
