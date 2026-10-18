import { z } from "zod";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { generateReportShareSlug } from "@/lib/reports/share";

/**
 * Creating, editing and switching campaigns on or off. The dashboard's
 * /api/automations routes and the MCP tools both go through here, so a
 * campaign set up either way follows the same rules.
 */

export const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(64).optional().nullable(),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    // Minutes to wait before the follow-up. Capped at 24h so it stays inside
    // Instagram's messaging window.
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  })
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) => d.matchAnyPost || d.pendingNextReel || Boolean(d.postId),
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  );

export const updateCampaignSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
});

export type CreateCampaignInput = z.output<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.output<typeof updateCampaignSchema>;

/**
 * Why a write was refused, with the message the dashboard has always shown.
 * The dashboard never asks for an edit to wait on the stored version, so it
 * never gets campaign_changed.
 */
export type CampaignRefusal = {
  ok: false;
  reason:
    | "workspace_not_found"
    | "instagram_not_connected"
    | "campaign_not_found"
    | "campaign_changed";
  message: string;
};

export async function createCampaign(
  workspaceId: string,
  input: CreateCampaignInput
) {
  // The account asked for, or the workspace's main one without it (or with "all").
  const [workspace, instagramAccount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    getWorkspaceInstagramAccount(workspaceId, input.instagramAccountId),
  ]);

  if (!workspace) {
    return {
      ok: false,
      reason: "workspace_not_found",
      message: "Workspace not found",
    } satisfies CampaignRefusal;
  }

  if (!instagramAccount) {
    return {
      ok: false,
      reason: "instagram_not_connected",
      message: "Connect Instagram before creating campaigns",
    } satisfies CampaignRefusal;
  }

  const linkCreates = buildInitialCampaignLinks({
    workspaceId,
    primaryUrl: input.trackedDestinationUrl,
    secondaryUrl: input.secondaryDestinationUrl,
    secondaryLabel: input.secondaryButtonLabel,
  });

  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    input;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    input.publicReplyMessages.length > 0
      ? input.publicReplyMessages
      : input.publicReplyMessage
        ? [input.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  const automation = await prisma.automation.create({
    data: {
      name: input.name,
      goal: input.goal,
      // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
      postId: isSpecificPost ? input.postId : null,
      postUrl: isSpecificPost ? input.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      keywords: matchAnyWord ? [] : input.keywords,
      matchAnyWord,
      dmTriggerEnabled: input.dmTriggerEnabled,
      dmMessage: input.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? input.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? input.openingDmButtonLabel || null
        : null,
      linkButtonLabel: input.linkButtonLabel || null,
      requireFollow: input.requireFollow,
      followPromptMessage: input.requireFollow
        ? input.followPromptMessage || null
        : null,
      followPromptButtonLabel: input.requireFollow
        ? input.followPromptButtonLabel || null
        : null,
      followUpEnabled: input.followUpEnabled,
      followUpMessage: input.followUpEnabled
        ? input.followUpMessage || null
        : null,
      followUpDelayMinutes: input.followUpEnabled
        ? input.followUpDelayMinutes
        : 0,
      publicReplyEnabled: input.publicReplyEnabled,
      publicReplyMessages: input.publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: input.publicReplyEnabled
        ? publicReplyList[0] ?? input.publicReplyMessage ?? null
        : null,
      isActive: input.isActive,
      wholeWordMatch: input.wholeWordMatch,
      workspaceId,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
    include: {
      trackedLinks: true,
    },
  });

  return { ok: true as const, campaign: automation };
}

/**
 * An edit as it is written: the fields that depend on the ones it changes are
 * brought in line with them.
 */
function withDependentFieldsCleared(input: UpdateCampaignInput) {
  const edit = { ...input };

  // Keep dependent fields consistent: any-word clears keywords; a disabled
  // opening DM clears its message and button.
  if (edit.matchAnyWord === true) edit.keywords = [];
  if (edit.openingDmEnabled === false) {
    edit.openingDmMessage = null;
    edit.openingDmButtonLabel = null;
  }
  if (edit.requireFollow === false) {
    edit.followPromptMessage = null;
    edit.followPromptButtonLabel = null;
  }
  if (edit.followUpEnabled === false) {
    edit.followUpMessage = null;
    edit.followUpDelayMinutes = 0;
  }
  // Any-post / next-reel campaigns carry no specific post.
  if (edit.matchAnyPost === true || edit.pendingNextReel === true) {
    edit.postId = null;
    edit.postUrl = null;
  }
  // Keep the public-reply variations list and the legacy single field in sync.
  if (edit.publicReplyMessages !== undefined) {
    const list = edit.publicReplyMessages
      .map((m) => m.trim())
      .filter(Boolean);
    edit.publicReplyMessages = list;
    edit.publicReplyMessage = list[0] ?? null;
  }
  if (edit.publicReplyEnabled === false) {
    edit.publicReplyMessages = [];
    edit.publicReplyMessage = null;
  }
  return edit;
}

const issueKey = (issue: z.core.$ZodIssue) => `${issue.path.join(".")}: ${issue.message}`;

/**
 * The create rules an edit would break, checked on the campaign it would
 * leave behind. Rules the stored campaign already breaks are left out, so a
 * campaign saved before a rule existed, or by the CSV import (which does not
 * check its post link), still takes every edit that leaves that alone. The
 * MCP tools refuse an edit that breaks one; the dashboard does not check.
 */
export function editIssues(stored: Record<string, unknown>, input: UpdateCampaignInput) {
  const before = createCampaignSchema.safeParse(stored);
  const known = new Set(before.success ? [] : before.error.issues.map(issueKey));
  const changes = Object.entries(withDependentFieldsCleared(input)).filter(
    ([, value]) => value !== undefined
  );
  const after = createCampaignSchema.safeParse({ ...stored, ...Object.fromEntries(changes) });
  return after.success ? [] : after.error.issues.filter((issue) => !known.has(issueKey(issue)));
}

/**
 * Apply an edit to one of the workspace's campaigns. Switching a campaign on
 * or off is an edit of `isActive` alone.
 *
 * With `unchangedSince`, the edit is written only if the campaign was last
 * saved at that time, so checks made against that version still hold; if it
 * was saved since, or is not one of the workspace's campaigns, nothing is
 * written and the refusal is campaign_changed.
 */
export async function updateCampaign(
  workspaceId: string,
  campaignId: string,
  input: UpdateCampaignInput,
  { unchangedSince }: { unchangedSince?: Date } = {}
) {
  // An edit waiting on a version its caller has just read needs no lookup:
  // the write below matches only that version, in this workspace.
  if (!unchangedSince) {
    const existing = await prisma.automation.findFirst({
      where: { id: campaignId, workspaceId },
    });

    if (!existing) {
      return {
        ok: false,
        reason: "campaign_not_found",
        message: "Campaign not found",
      } satisfies CampaignRefusal;
    }
  }

  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    ...automationData
  } = withDependentFieldsCleared(input);

  // One transaction, so a save never lands half applied. Updating the campaign
  // first locks its row, which makes a second save of the same campaign wait
  // for this one before it reads the links.
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const campaign = await tx.automation.update({
        where: {
          id: campaignId,
          workspaceId,
          ...(unchangedSince ? { updatedAt: unchangedSince } : {}),
        },
        // An edit of only the links has nothing else to write, and without a
        // write the row is neither locked nor marked saved. So an edit waiting
        // on a version always marks a new one, which another edit read before
        // it then sees as a change.
        data: unchangedSince ? { ...automationData, updatedAt: new Date() } : automationData,
      });

      await syncCampaignLinks(tx, {
        workspaceId,
        automationId: campaignId,
        primaryUrl: trackedDestinationUrl,
        secondaryUrl: secondaryDestinationUrl,
        secondaryLabel: secondaryButtonLabel,
      });

      return campaign;
    });

    return { ok: true as const, campaign: updated };
  } catch (error) {
    // No row matched the stored version: the campaign was saved, or deleted,
    // meanwhile.
    if (
      unchangedSince &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return {
        ok: false,
        reason: "campaign_changed",
        message:
          "The campaign was changed meanwhile, so this edit was not saved. Read it again and try again.",
      } satisfies CampaignRefusal;
    }
    throw error;
  }
}
