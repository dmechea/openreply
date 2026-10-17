import { prisma } from "@/lib/db/client";
import { knownScopes, type Scope } from "@/lib/oauth/config";
import { hashSecret } from "@/lib/oauth/secrets";
import { canManageWorkspace } from "@/lib/workspace-access";

/**
 * Connections: one grant from one client to one workspace, acting as the
 * person who approved it. Every MCP request checks its access token here
 * against the database, so revoking a connection, or the person losing the
 * right to manage the workspace, takes effect on the very next request.
 */

export type McpCaller = {
  workspaceId: string;
  scopes: Scope[];
};

export type AccessCheck =
  | { ok: true; caller: McpCaller }
  | { ok: false; reason: "missing" | "invalid" };

// lastUsedAt is for people reading Settings, so minute precision is plenty
// and spares a write on every request.
const LAST_USED_RESOLUTION_MS = 60_000;

export async function authenticateAccessToken(
  authorization: string | null
): Promise<AccessCheck> {
  if (!authorization) return { ok: false, reason: "missing" };
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match) return { ok: false, reason: "invalid" };

  const now = new Date();
  const token = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashSecret(match[1]) },
    include: { connection: true },
  });
  if (
    !token ||
    token.kind !== "ACCESS" ||
    token.expiresAt <= now ||
    token.connection.revokedAt
  ) {
    return { ok: false, reason: "invalid" };
  }

  const { connection } = token;
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: connection.workspaceId,
        userId: connection.userId,
      },
    },
    select: { role: true },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return { ok: false, reason: "invalid" };
  }

  if (
    !connection.lastUsedAt ||
    now.getTime() - connection.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
  ) {
    await prisma.oAuthConnection.update({
      where: { id: connection.id },
      data: { lastUsedAt: now },
    });
  }

  return {
    ok: true,
    caller: {
      workspaceId: connection.workspaceId,
      scopes: knownScopes(connection.scopes),
    },
  };
}

/** Revoke a connection and discard its tokens. */
export async function revokeConnection(connectionId: string) {
  await prisma.$transaction([
    prisma.oAuthConnection.updateMany({
      where: { id: connectionId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.oAuthToken.deleteMany({ where: { connectionId } }),
  ]);
}

/**
 * The workspace's working connections, newest first. A revoked connection is
 * gone, and so is one whose tokens have all expired: it can never be used
 * again and reconnecting creates a new one.
 */
export async function listWorkspaceConnections(workspaceId: string) {
  const connections = await prisma.oAuthConnection.findMany({
    where: {
      workspaceId,
      revokedAt: null,
      tokens: { some: { expiresAt: { gt: new Date() } } },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      scopes: true,
      createdAt: true,
      lastUsedAt: true,
      client: { select: { name: true } },
      user: { select: { email: true, name: true } },
    },
  });
  return connections.map((connection) => ({
    id: connection.id,
    clientName: connection.client.name,
    scopes: knownScopes(connection.scopes),
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt,
    connectedBy: connection.user.name ?? connection.user.email,
  }));
}

/** Revoke one of the workspace's connections; false when it has none by that id. */
export async function revokeWorkspaceConnection(
  workspaceId: string,
  connectionId: string
): Promise<boolean> {
  const connection = await prisma.oAuthConnection.findFirst({
    where: { id: connectionId, workspaceId, revokedAt: null },
    select: { id: true },
  });
  if (!connection) return false;
  await revokeConnection(connection.id);
  return true;
}
