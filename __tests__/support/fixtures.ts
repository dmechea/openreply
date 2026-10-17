/**
 * Seed rows for the database suites: people, their workspaces and connected
 * Instagram accounts, written through Prisma the way the app writes them.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient, WorkspaceRole } from "@/app/generated/prisma/client";
import { encryptToken } from "@/lib/meta/oauth";
import { generateReportShareSlug } from "@/lib/reports/share";

// Account tokens are stored encrypted, and the app decrypts them before every
// Instagram call, so the suites need a key. Any 32-byte hex key will do.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function uniqueSuffix() {
  return randomBytes(4).toString("hex");
}

/** A person with a workspace of their own, as signing up creates one. */
export async function createOwner(prisma: PrismaClient, label = "owner") {
  const email = `${label}-${uniqueSuffix()}@test.dev`;
  const user = await prisma.user.create({ data: { email } });
  const workspace = await prisma.workspace.create({
    data: {
      name: `${label}'s workspace`,
      ownerId: user.id,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  return { user, workspace };
}

/** Someone invited into an existing workspace with the given role. */
export async function addMember(
  prisma: PrismaClient,
  workspaceId: string,
  role: WorkspaceRole,
  label = role.toLowerCase()
) {
  const user = await prisma.user.create({
    data: { email: `${label}-${uniqueSuffix()}@test.dev` },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId, userId: user.id, role },
  });
  return user;
}

export async function connectInstagramAccount(
  prisma: PrismaClient,
  workspaceId: string,
  {
    username,
    instagramId = `ig_${uniqueSuffix()}`,
    accessToken = `token_${uniqueSuffix()}`,
    connectedAt = new Date(),
  }: {
    username: string;
    instagramId?: string;
    accessToken?: string;
    connectedAt?: Date;
  }
) {
  const account = await prisma.instagramAccount.create({
    data: {
      workspaceId,
      instagramId,
      username,
      accessToken: encryptToken(accessToken),
      connectedAt,
    },
  });
  return { ...account, plainAccessToken: accessToken };
}

/**
 * A campaign as the CSV import (app/api/automations/import) stores one. The
 * import does not check that postUrl is a URL, so such a campaign can break
 * rules a new campaign has to follow. Its public reply goes in the legacy
 * single field only, leaving the list of variations empty.
 */
export function importCampaign(
  prisma: PrismaClient,
  {
    workspaceId,
    instagramAccountId,
    postId,
    postUrl,
    keyword = "GUIDE",
    publicReply = null,
    isActive = true,
  }: {
    workspaceId: string;
    instagramAccountId: string;
    postId: string;
    postUrl: string | null;
    keyword?: string;
    publicReply?: string | null;
    isActive?: boolean;
  }
) {
  return prisma.automation.create({
    data: {
      name: `Imported: ${keyword}`,
      goal: null,
      postId,
      postUrl,
      keywords: [keyword],
      dmMessage: "Here is the guide",
      publicReplyEnabled: Boolean(publicReply),
      publicReplyMessage: publicReply,
      isActive,
      wholeWordMatch: true,
      workspaceId,
      instagramAccountId,
      reportShareSlug: generateReportShareSlug(),
    },
  });
}
