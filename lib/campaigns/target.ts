import type { Automation } from "@/app/generated/prisma/client";

/**
 * Which comments trigger a campaign: those on one post or reel, on any post,
 * or on the next reel posted. A campaign stores this as three flags (its post,
 * matchAnyPost and pendingNextReel). The campaign reads and the MCP tools turn
 * the flags into a target, and a chosen target back into flags, here.
 */

export type CampaignTarget =
  | { type: "post"; postId: string | null; postUrl: string | null }
  | { type: "any_post" }
  | { type: "next_reel" };

/** A target as someone chooses it, so a post target always names its post. */
export type ChosenTarget =
  | { type: "post"; postId: string; postUrl?: string | null }
  | { type: "any_post" }
  | { type: "next_reel" };

export function campaignTarget(
  campaign: Pick<Automation, "pendingNextReel" | "matchAnyPost" | "postId" | "postUrl">
): CampaignTarget {
  if (campaign.pendingNextReel) return { type: "next_reel" };
  if (campaign.matchAnyPost) return { type: "any_post" };
  return { type: "post", postId: campaign.postId, postUrl: campaign.postUrl };
}

/**
 * The flags a chosen target sets, in the field names create and update take.
 * Any post and the next reel name no post; the write clears the stored one.
 */
export function targetFlags(target: ChosenTarget) {
  switch (target.type) {
    case "post":
      return {
        postId: target.postId,
        postUrl: target.postUrl ?? null,
        matchAnyPost: false,
        pendingNextReel: false,
      };
    case "any_post":
      return { matchAnyPost: true, pendingNextReel: false };
    case "next_reel":
      return { pendingNextReel: true, matchAnyPost: false };
  }
}
