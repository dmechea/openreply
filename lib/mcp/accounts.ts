import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";

/**
 * Which Instagram account an MCP tool acts on. Without one named it is the
 * workspace's main account, the one the dashboard selects by default (the
 * most recently connected). An account can be named by its id or username.
 */

export function listWorkspaceInstagramAccounts(workspaceId: string) {
  return prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true },
  });
}

export async function resolveInstagramAccount(
  workspaceId: string,
  identifier?: string | null
) {
  const name = identifier?.trim().replace(/^@/, "");
  if (!name) return getWorkspaceInstagramAccount(workspaceId);
  return prisma.instagramAccount.findFirst({
    where: {
      workspaceId,
      OR: [{ id: name }, { username: { equals: name, mode: "insensitive" } }],
    },
    orderBy: { connectedAt: "desc" },
  });
}
