import type { Automation, TrackedLink } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { CreateCampaignInput } from "@/lib/campaigns/campaign";
import {
  calculateCtr,
  CLICK_ROW_SELECT,
  countUniqueClicksBy,
} from "@/lib/tracking/analytics";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { buildTrackedUrl } from "@/lib/tracking/message";

/** How campaigns read: their settings, target and how they are doing. */

export type CampaignTarget =
  | { type: "post"; postId: string | null; postUrl: string | null }
  | { type: "any_post" }
  | { type: "next_reel" };

export function campaignTarget(
  campaign: Pick<Automation, "pendingNextReel" | "matchAnyPost" | "postId" | "postUrl">
): CampaignTarget {
  if (campaign.pendingNextReel) return { type: "next_reel" };
  if (campaign.matchAnyPost) return { type: "any_post" };
  return { type: "post", postId: campaign.postId, postUrl: campaign.postUrl };
}

export type CampaignStats = {
  dmsSent: number;
  dmsFailed: number;
  dmsSkipped: number;
  linkClicks: number;
  clickThroughRate: number;
};

/** DM outcomes and unique link clicks per campaign, as the dashboard counts them. */
async function campaignStats(workspaceId: string, campaignIds: string[]) {
  const [statusCounts, clickRows] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["automationId", "status"],
      where: { workspaceId, automationId: { in: campaignIds } },
      _count: { _all: true },
    }),
    prisma.linkClick.findMany({
      where: { workspaceId, automationId: { in: campaignIds } },
      select: CLICK_ROW_SELECT,
    }),
  ]);
  const clicks = countUniqueClicksBy(clickRows, (row) => row.automationId);

  const stats = new Map<string, CampaignStats>();
  for (const id of campaignIds) {
    stats.set(id, { dmsSent: 0, dmsFailed: 0, dmsSkipped: 0, linkClicks: clicks.get(id) ?? 0, clickThroughRate: 0 });
  }
  for (const row of statusCounts) {
    const item = stats.get(row.automationId);
    if (!item) continue;
    if (row.status === "SENT") item.dmsSent += row._count._all;
    if (row.status === "FAILED") item.dmsFailed += row._count._all;
    if (row.status.startsWith("SKIPPED_")) item.dmsSkipped += row._count._all;
  }
  for (const item of stats.values()) {
    item.clickThroughRate = calculateCtr(item.linkClicks, item.dmsSent);
  }
  return stats;
}

const EMPTY_STATS: CampaignStats = {
  dmsSent: 0,
  dmsFailed: 0,
  dmsSkipped: 0,
  linkClicks: 0,
  clickThroughRate: 0,
};

export async function listCampaigns(workspaceId: string, instagramAccountId: string) {
  const campaigns = await prisma.automation.findMany({
    where: { workspaceId, instagramAccountId },
    orderBy: { createdAt: "desc" },
  });
  const stats = await campaignStats(workspaceId, campaigns.map((c) => c.id));
  return campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    isActive: campaign.isActive,
    target: campaignTarget(campaign),
    keywords: campaign.keywords,
    matchAnyWord: campaign.matchAnyWord,
    dmTriggerEnabled: campaign.dmTriggerEnabled,
    createdAt: campaign.createdAt.toISOString(),
    stats: stats.get(campaign.id) ?? EMPTY_STATS,
  }));
}

function findCampaign(workspaceId: string, campaignId: string) {
  return prisma.automation.findFirst({
    where: { id: campaignId, workspaceId },
    include: {
      trackedLinks: { orderBy: TRACKED_LINK_ORDER },
      instagramAccount: { select: { id: true, username: true } },
    },
  });
}

/** Every setting, in the field names create and update take, plus its stats. */
export async function getCampaign(workspaceId: string, campaignId: string) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  const [primary, secondary] = campaign.trackedLinks;
  const stats = await campaignStats(workspaceId, [campaign.id]);

  return {
    id: campaign.id,
    instagramAccount: campaign.instagramAccount,
    name: campaign.name,
    goal: campaign.goal,
    isActive: campaign.isActive,
    target: campaignTarget(campaign),
    keywords: campaign.keywords,
    matchAnyWord: campaign.matchAnyWord,
    wholeWordMatch: campaign.wholeWordMatch,
    dmTriggerEnabled: campaign.dmTriggerEnabled,
    dmMessage: campaign.dmMessage,
    openingDmEnabled: campaign.openingDmEnabled,
    openingDmMessage: campaign.openingDmMessage,
    openingDmButtonLabel: campaign.openingDmButtonLabel,
    linkButtonLabel: campaign.linkButtonLabel,
    trackedDestinationUrl: primary?.destinationUrl ?? null,
    secondaryDestinationUrl: secondary?.destinationUrl ?? null,
    secondaryButtonLabel: secondary?.label ?? null,
    trackedLinks: campaign.trackedLinks.map((link) => ({
      destinationUrl: link.destinationUrl,
      trackedUrl: buildTrackedUrl(link.slug),
    })),
    requireFollow: campaign.requireFollow,
    followPromptMessage: campaign.followPromptMessage,
    followPromptButtonLabel: campaign.followPromptButtonLabel,
    followUpEnabled: campaign.followUpEnabled,
    followUpMessage: campaign.followUpMessage,
    followUpDelayMinutes: campaign.followUpDelayMinutes,
    publicReplyEnabled: campaign.publicReplyEnabled,
    publicReplyMessages: campaign.publicReplyMessages,
    reportShareEnabled: campaign.reportShareEnabled,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    stats: stats.get(campaign.id) ?? EMPTY_STATS,
  };
}

/**
 * A stored campaign in the shape the create rules check, so an edit can be
 * checked as the campaign it would leave behind.
 */
export async function getCampaignAsCreateInput(
  workspaceId: string,
  campaignId: string
): Promise<Record<keyof CreateCampaignInput, unknown> | null> {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  const [primary, secondary]: (TrackedLink | undefined)[] = campaign.trackedLinks;
  return {
    name: campaign.name,
    goal: campaign.goal,
    instagramAccountId: campaign.instagramAccountId,
    postId: campaign.postId,
    postUrl: campaign.postUrl,
    pendingNextReel: campaign.pendingNextReel,
    matchAnyPost: campaign.matchAnyPost,
    keywords: campaign.keywords,
    matchAnyWord: campaign.matchAnyWord,
    dmTriggerEnabled: campaign.dmTriggerEnabled,
    dmMessage: campaign.dmMessage,
    openingDmEnabled: campaign.openingDmEnabled,
    openingDmMessage: campaign.openingDmMessage,
    openingDmButtonLabel: campaign.openingDmButtonLabel,
    linkButtonLabel: campaign.linkButtonLabel,
    requireFollow: campaign.requireFollow,
    followPromptMessage: campaign.followPromptMessage,
    followPromptButtonLabel: campaign.followPromptButtonLabel,
    followUpEnabled: campaign.followUpEnabled,
    followUpMessage: campaign.followUpMessage,
    followUpDelayMinutes: campaign.followUpDelayMinutes,
    publicReplyEnabled: campaign.publicReplyEnabled,
    publicReplyMessage: campaign.publicReplyMessage,
    publicReplyMessages: campaign.publicReplyMessages,
    trackedDestinationUrl: primary?.destinationUrl ?? "",
    secondaryDestinationUrl: secondary?.destinationUrl ?? "",
    secondaryButtonLabel: secondary?.label ?? null,
    isActive: campaign.isActive,
    wholeWordMatch: campaign.wholeWordMatch,
  };
}

/** DMs that failed, newest first, with Instagram's reason. */
export async function listFailedDms(
  workspaceId: string,
  filter: { instagramAccountId: string } | { campaignId: string },
  limit: number
) {
  const rows = await prisma.dmLog.findMany({
    where: {
      workspaceId,
      status: "FAILED",
      ...("campaignId" in filter
        ? { automationId: filter.campaignId }
        : { instagramAccountId: filter.instagramAccountId }),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: { automation: { select: { id: true, name: true } } },
  });
  return rows.map((row) => ({
    campaign: row.automation,
    commenter: row.commenterName,
    commentText: row.commentText,
    reason: row.errorMessage,
    deliveryUnconfirmed: row.dmDeliveryUnconfirmed,
    attempts: row.attempts,
    failedAt: row.updatedAt.toISOString(),
  }));
}
