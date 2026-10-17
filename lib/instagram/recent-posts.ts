import type { ProviderAccount } from "./context";
import { createInstagramContext } from "./context";
import { getUserMedia } from "./read-content";

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
