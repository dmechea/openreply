import { z } from "zod";
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

/**
 * A target as someone chooses it, so a post target always names its post.
 * The MCP tools take it in this shape, described for the client. A key its
 * type does not take is refused rather than dropped, so a post meant for a
 * post target cannot quietly leave a campaign on any post.
 */
export const chosenTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("post"),
    postId: z
      .string()
      .min(1)
      .describe("The post's or reel's id, from list_posts for the campaign's account"),
    postUrl: z
      .url()
      .optional()
      .describe(
        "Its permalink from list_posts, shown in the dashboard. When left out, the campaign's current post keeps its own, and another post's is taken from Instagram"
      ),
  }),
  z.strictObject({ type: z.literal("any_post") }),
  z.strictObject({ type: z.literal("next_reel") }),
]);

export type ChosenTarget = z.infer<typeof chosenTargetSchema>;

export function campaignTarget(
  campaign: Pick<Automation, "pendingNextReel" | "matchAnyPost" | "postId" | "postUrl">
): CampaignTarget {
  if (campaign.pendingNextReel) return { type: "next_reel" };
  if (campaign.matchAnyPost) return { type: "any_post" };
  return { type: "post", postId: campaign.postId, postUrl: campaign.postUrl };
}

/**
 * The flags a chosen target sets, in the field names create and update take.
 * Any post and the next reel name no post, so they clear the stored one, as
 * the write would.
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
      return { postId: null, postUrl: null, matchAnyPost: true, pendingNextReel: false };
    case "next_reel":
      return { postId: null, postUrl: null, pendingNextReel: true, matchAnyPost: false };
  }
}
