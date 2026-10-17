import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  formatScopes,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/oauth/config";
import { findClient } from "@/lib/oauth/clients";
import { revokeConnection } from "@/lib/oauth/connections";
import { generateSecret, hashSecret, verifyPkce } from "@/lib/oauth/secrets";

/**
 * The token endpoint's two grants. Authorization codes work once. Refresh
 * tokens rotate: each refresh spends the old one and issues a new pair, and a
 * spent refresh token presented again is taken as stolen, so its whole
 * connection is revoked (OAuth 2.1 §4.3.1).
 */

export type TokenResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 401; error: string; description: string };

function refuse(error: string, description: string, status: 400 | 401 = 400): TokenResult {
  return { ok: false, status, error, description };
}

async function issueTokenPair(
  tx: Prisma.TransactionClient,
  connection: { id: string; scopes: string[] },
  parentId: string | null
) {
  const now = Date.now();
  const accessToken = generateSecret("ora");
  const refreshToken = generateSecret("orr");
  await tx.oAuthToken.createMany({
    data: [
      {
        connectionId: connection.id,
        kind: "ACCESS",
        tokenHash: hashSecret(accessToken),
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
        parentId,
      },
      {
        connectionId: connection.id,
        kind: "REFRESH",
        tokenHash: hashSecret(refreshToken),
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
        parentId,
      },
    ],
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: formatScopes(connection.scopes),
  };
}

async function exchangeAuthorizationCode(params: URLSearchParams): Promise<TokenResult> {
  const client = await findClient(params.get("client_id"));
  if (!client) return refuse("invalid_client", "Unknown client", 401);

  const code = params.get("code");
  const verifier = params.get("code_verifier");
  if (!code || !verifier) {
    return refuse("invalid_request", "code and code_verifier are required");
  }

  const stored = await prisma.oAuthAuthorizationCode.findUnique({
    where: { codeHash: hashSecret(code) },
  });
  if (!stored || stored.clientId !== client.id) {
    return refuse("invalid_grant", "The authorization code is not valid");
  }

  // Claim the code before anything else, so it works once even when two
  // requests race, and a failed attempt burns it too.
  const now = new Date();
  const claimed = await prisma.oAuthAuthorizationCode.updateMany({
    where: { id: stored.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count === 0) {
    // A replayed code means it leaked, so whatever it was exchanged for goes
    // too (RFC 6749 §4.1.2).
    const replayed = await prisma.oAuthAuthorizationCode.findUnique({
      where: { id: stored.id },
      select: { connectionId: true },
    });
    if (replayed?.connectionId) await revokeConnection(replayed.connectionId);
    return refuse("invalid_grant", "The authorization code has already been used");
  }

  if (stored.expiresAt <= now) {
    return refuse("invalid_grant", "The authorization code has expired");
  }
  const redirectUri = params.get("redirect_uri");
  const redirectMatches =
    redirectUri === null
      ? client.redirectUris.length === 1 && client.redirectUris[0] === stored.redirectUri
      : redirectUri === stored.redirectUri;
  if (!redirectMatches) {
    return refuse("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (!verifyPkce(verifier, stored.codeChallenge)) {
    return refuse("invalid_grant", "The code_verifier does not match the code_challenge");
  }

  const body = await prisma.$transaction(async (tx) => {
    // Approving the same app again replaces its earlier connection.
    await tx.oAuthConnection.updateMany({
      where: {
        clientId: client.id,
        userId: stored.userId,
        workspaceId: stored.workspaceId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    const connection = await tx.oAuthConnection.create({
      data: {
        clientId: client.id,
        userId: stored.userId,
        workspaceId: stored.workspaceId,
        scopes: stored.scopes,
      },
    });
    await tx.oAuthAuthorizationCode.update({
      where: { id: stored.id },
      data: { connectionId: connection.id },
    });
    return issueTokenPair(tx, connection, null);
  });
  return { ok: true, body };
}

async function refreshAccessToken(params: URLSearchParams): Promise<TokenResult> {
  const client = await findClient(params.get("client_id"));
  if (!client) return refuse("invalid_client", "Unknown client", 401);

  const presented = params.get("refresh_token");
  if (!presented) return refuse("invalid_request", "refresh_token is required");

  const token = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashSecret(presented) },
    include: { connection: true },
  });
  if (
    !token ||
    token.kind !== "REFRESH" ||
    token.connection.clientId !== client.id ||
    token.connection.revokedAt
  ) {
    return refuse("invalid_grant", "The refresh token is not valid");
  }

  const now = new Date();
  if (token.rotatedAt) {
    await revokeConnection(token.connectionId);
    return refuse("invalid_grant", "The refresh token has already been used");
  }
  if (token.expiresAt <= now) {
    return refuse("invalid_grant", "The refresh token has expired");
  }

  const spent = await prisma.oAuthToken.updateMany({
    where: { id: token.id, rotatedAt: null },
    data: { rotatedAt: now },
  });
  if (spent.count === 0) {
    // Another request spent it a moment ago: the same token used twice.
    await revokeConnection(token.connectionId);
    return refuse("invalid_grant", "The refresh token has already been used");
  }

  const body = await prisma.$transaction(async (tx) => {
    // Housekeeping: expired tokens can never be used or replayed again.
    await tx.oAuthToken.deleteMany({
      where: { connectionId: token.connectionId, expiresAt: { lt: now } },
    });
    return issueTokenPair(tx, token.connection, token.id);
  });
  return { ok: true, body };
}

export async function handleTokenRequest(params: URLSearchParams): Promise<TokenResult> {
  switch (params.get("grant_type")) {
    case "authorization_code":
      return exchangeAuthorizationCode(params);
    case "refresh_token":
      return refreshAccessToken(params);
    default:
      return refuse(
        "unsupported_grant_type",
        "Only authorization_code and refresh_token are supported"
      );
  }
}
