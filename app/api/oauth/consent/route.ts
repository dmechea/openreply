import { NextResponse, type NextRequest } from "next/server";
import {
  AUTHORIZATION_PARAMS,
  AUTHORIZATION_PROBLEMS,
  authorizationResponseUrl,
  checkAuthorizationRequest,
  grantedScopes,
  issueAuthorizationCode,
  signInUrl,
} from "@/lib/oauth/authorization";
import { issuer } from "@/lib/oauth/config";
import { plainText, requestI18n } from "@/lib/oauth/browser";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

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
  const { t } = requestI18n(request);
  if (!isSameOriginForm(request)) {
    return plainText(t("This approval must come from the OpenReply consent page."), 403);
  }

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const name of AUTHORIZATION_PARAMS) {
    const value = form.get(name);
    if (typeof value === "string") params.set(name, value);
  }

  const check = await checkAuthorizationRequest(params);
  if (!check.ok) {
    if (check.redirectTo !== null) return NextResponse.redirect(check.redirectTo, 303);
    return plainText(t(AUTHORIZATION_PROBLEMS[check.problem]), 400);
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
  if (!context) return NextResponse.redirect(signInUrl(params), 303);
  if (!canManageWorkspace(context.role)) {
    return plainText(t("Only workspace owners and admins can connect apps."), 403);
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
