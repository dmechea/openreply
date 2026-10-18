import type { ProviderAccount } from "./context";
import { createInstagramContext } from "./context";
import { getAllUserMedia, getUserMedia } from "./read-content";

// The dashboard's post picker offers up to this much of an account's library.
const POST_PICKER_LIBRARY = 300;

function postType(mediaType: string, productType?: string) {
  if (productType === "REELS") return "reel";
  if (mediaType === "VIDEO") return "video";
  if (mediaType === "CAROUSEL_ALBUM") return "carousel";
  return "image";
}

/** The account's recent posts and reels, newest first, for picking a campaign's post. */
export async function listRecentPosts(account: ProviderAccount, limit = 25) {
  const context = await createInstagramContext(account);
  const media = await getUserMedia({ context, limit });
  return media.map((item) => ({
    id: item.id,
    type: postType(item.media_type, item.media_product_type),
    caption: item.caption ?? "",
    postedAt: item.timestamp,
    permalink: item.permalink ?? null,
    thumbnailUrl:
      item.thumbnail_url ?? (item.media_type === "VIDEO" ? null : item.media_url ?? null),
  }));
}

/**
 * One of the account's own posts or reels with its permalink, or null when
 * the id is not among them. Neither provider client can look a single post up
 * by id, so this reads the library the dashboard's post picker offers for the
 * account. Instagram's errors are passed on.
 */
export async function findAccountPost(account: ProviderAccount, postId: string) {
  const context = await createInstagramContext(account);
  const media = await getAllUserMedia({ context, max: POST_PICKER_LIBRARY });
  const post = media.find((item) => item.id === postId);
  return post ? { id: post.id, permalink: post.permalink ?? null } : null;
}
