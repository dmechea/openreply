import type { Automation, TrackedLink } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { CreateCampaignInput } from "@/lib/campaigns/campaign";
import { campaignTarget } from "@/lib/campaigns/target";
import {
  calculateCtr,
  CLICK_ROW_SELECT,
  countUniqueClicksBy,
} from "@/lib/tracking/analytics";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { buildTrackedUrl } from "@/lib/tracking/message";

/** How campaigns read: their settings, target and how they are doing. */

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

type StoredCampaign = Automation & { trackedLinks: TrackedLink[] };

/**
 * The settings both reads give alike, in the field names create and update
 * take. A link that is not set reads as null. A campaign saved before public
 * replies could vary, or by the CSV import, keeps its reply in the legacy
 * single field only; it reads as the list, as the DM worker and the
 * dashboard's edit page read it.
 */
function campaignSettings(campaign: StoredCampaign) {
  const [primary, secondary]: (TrackedLink | undefined)[] = campaign.trackedLinks;
  return {
    name: campaign.name,
    goal: campaign.goal,
    isActive: campaign.isActive,
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
    requireFollow: campaign.requireFollow,
    followPromptMessage: campaign.followPromptMessage,
    followPromptButtonLabel: campaign.followPromptButtonLabel,
    followUpEnabled: campaign.followUpEnabled,
    followUpMessage: campaign.followUpMessage,
    followUpDelayMinutes: campaign.followUpDelayMinutes,
    publicReplyEnabled: campaign.publicReplyEnabled,
    publicReplyMessages:
      campaign.publicReplyMessages.length > 0
        ? campaign.publicReplyMessages
        : campaign.publicReplyMessage
          ? [campaign.publicReplyMessage]
          : [],
  };
}

type CampaignAccount = { id: string; username: string };

/** Every setting, in the field names create and update take, plus its stats. */
function campaignDetails(
  campaign: StoredCampaign,
  instagramAccount: CampaignAccount,
  stats: CampaignStats
) {
  return {
    id: campaign.id,
    instagramAccount,
    target: campaignTarget(campaign),
    ...campaignSettings(campaign),
    trackedLinks: campaign.trackedLinks.map((link) => ({
      destinationUrl: link.destinationUrl,
      trackedUrl: buildTrackedUrl(link.slug),
    })),
    reportShareEnabled: campaign.reportShareEnabled,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    stats,
  };
}

export async function getCampaign(workspaceId: string, campaignId: string) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  const stats = await campaignStats(workspaceId, [campaign.id]);
  return campaignDetails(campaign, campaign.instagramAccount, stats.get(campaign.id) ?? EMPTY_STATS);
}

/**
 * A campaign just created, as getCampaign reads it, without reading it back:
 * it has no DMs or clicks yet, and its links, numbered in button order as
 * they were created, are put in that order.
 */
export function newCampaignDetails(campaign: StoredCampaign, instagramAccount: CampaignAccount) {
  const trackedLinks = [...campaign.trackedLinks].sort((a, b) => a.position - b.position);
  return campaignDetails({ ...campaign, trackedLinks }, instagramAccount, EMPTY_STATS);
}

/**
 * A stored campaign as an edit needs it: its settings in the shape the create
 * rules check, so the edit can be checked as the campaign it would leave
 * behind; its account; and when it was last saved, so the edit can be written
 * only if nothing else saved it in between.
 */
export async function getCampaignForEdit(workspaceId: string, campaignId: string) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  const settings = {
    ...campaignSettings(campaign),
    instagramAccountId: campaign.instagramAccountId,
    postId: campaign.postId,
    postUrl: campaign.postUrl,
    pendingNextReel: campaign.pendingNextReel,
    matchAnyPost: campaign.matchAnyPost,
    publicReplyMessage: campaign.publicReplyMessage,
  } satisfies Record<keyof CreateCampaignInput, unknown>;
  return { settings, instagramAccount: campaign.instagramAccount, updatedAt: campaign.updatedAt };
}

/** The account a campaign is on, or null when the workspace has no such campaign. */
export async function getCampaignAccount(workspaceId: string, campaignId: string) {
  const campaign = await prisma.automation.findFirst({
    where: { id: campaignId, workspaceId },
    select: { instagramAccount: { select: { id: true, username: true } } },
  });
  return campaign?.instagramAccount ?? null;
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
