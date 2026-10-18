import { DEFAULT_LINK_BUTTON_LABEL } from "@/lib/campaigns/links";

/**
 * The checks and defaults the dashboard's campaign builder applies in the
 * browser before it saves (components/campaign-builder.tsx). The shared
 * create and edit schemas never had to apply them, because the builder was
 * their only caller. The MCP tools skip the builder, so they apply them here,
 * and a campaign set up through Claude is stored as the same campaign set up
 * in the dashboard. The dashboard's API does not use this module.
 *
 * Refusals read "field: reason", in the field names the tools take.
 */

export const DEFAULT_FOLLOW_PROMPT_BUTTON_LABEL = "i'm following";

/** The settings these rules read and fill in, as create and update take them. */
type BuilderFields = {
  name?: string;
  keywords?: string[];
  dmMessage?: string;
  linkButtonLabel?: string | null;
  trackedDestinationUrl?: string | null;
  secondaryDestinationUrl?: string | null;
  secondaryButtonLabel?: string | null;
  requireFollow?: boolean;
  followPromptMessage?: string | null;
  followPromptButtonLabel?: string | null;
  followUpMessage?: string | null;
};

/** What the stored campaign holds of them, as its read gives them. */
type StoredFields = {
  dmMessage: string;
  linkButtonLabel: string | null;
  trackedDestinationUrl: string | null;
  secondaryDestinationUrl: string | null;
  secondaryButtonLabel: string | null;
  followPromptButtonLabel: string | null;
};

type AsBuilt<T> = { ok: true; fields: T } | { ok: false; message: string };

/** The builder appends the {link} token when a link is set and the DM has none. */
function withLinkToken(message: string) {
  return message.includes("{link}") ? message : `${message.trim()} {link}`.trim();
}

/** A link's URL after the write: a given one replaces it, null and undefined keep it. */
function linkAfter(given: string | null | undefined, stored: string | null | undefined) {
  return given === undefined || given === null ? stored || null : given || null;
}

function asBuilt<T extends BuilderFields>(
  given: T,
  stored: StoredFields | null,
  accountUsername: string
): AsBuilt<T> {
  const fields: BuilderFields = { ...given };
  const refuse = (message: string) => ({ ok: false as const, message });

  // Trimmed as the builder trims them; a blank name gets the builder's default.
  if (fields.name !== undefined) {
    fields.name = fields.name.trim() || `Campaign for @${accountUsername}`;
  }
  if (fields.keywords !== undefined) {
    fields.keywords = fields.keywords.map((keyword) => keyword.trim()).filter(Boolean);
  }
  if (typeof fields.followPromptMessage === "string") {
    fields.followPromptMessage = fields.followPromptMessage.trim();
  }
  if (typeof fields.followUpMessage === "string") {
    fields.followUpMessage = fields.followUpMessage.trim();
  }

  // The builder will not save a DM without text.
  if (fields.dmMessage !== undefined && !fields.dmMessage.trim()) {
    return refuse("dmMessage: Add the DM's text; it cannot be blank");
  }

  // The second link's URL and label are one button, so an edit of one keeps
  // the stored other: a label alone renames the button, a URL alone moves it.
  const secondUrlGiven =
    fields.secondaryDestinationUrl !== undefined && fields.secondaryDestinationUrl !== null;
  if (typeof fields.secondaryButtonLabel === "string" && !secondUrlGiven) {
    if (!stored?.secondaryDestinationUrl) {
      return refuse(
        "secondaryButtonLabel: There is no second link to label; set secondaryDestinationUrl too"
      );
    }
    fields.secondaryDestinationUrl = stored.secondaryDestinationUrl;
  } else if (fields.secondaryDestinationUrl && fields.secondaryButtonLabel === undefined) {
    fields.secondaryButtonLabel = stored?.secondaryButtonLabel ?? null;
  }
  if (typeof fields.secondaryButtonLabel === "string") {
    fields.secondaryButtonLabel = fields.secondaryButtonLabel.trim() || DEFAULT_LINK_BUTTON_LABEL;
  }

  // The second button is only ever shown under the first.
  const firstLink = linkAfter(fields.trackedDestinationUrl, stored?.trackedDestinationUrl);
  const secondLink = linkAfter(fields.secondaryDestinationUrl, stored?.secondaryDestinationUrl);
  if (secondLink && !firstLink) {
    return refuse(
      'secondaryDestinationUrl: A second link needs a first one; set trackedDestinationUrl, or remove the second link too with secondaryDestinationUrl ""'
    );
  }

  // The link button's label: the builder always sends one, "Open link" when
  // left blank. A link added to a campaign stored without a label gets it too.
  const linkAdded =
    typeof fields.trackedDestinationUrl === "string" && fields.trackedDestinationUrl !== "";
  if (fields.linkButtonLabel !== undefined || !stored) {
    fields.linkButtonLabel = fields.linkButtonLabel?.trim() || DEFAULT_LINK_BUTTON_LABEL;
  } else if (linkAdded && !stored.linkButtonLabel?.trim()) {
    fields.linkButtonLabel = DEFAULT_LINK_BUTTON_LABEL;
  }

  // With a link, the DM carries the {link} token, which the builder adds when
  // the link is entered. It is where the link shows when Instagram refuses the
  // button, so a DM given while there is a link gets it too. An edit of
  // neither the DM nor the link leaves the DM as it is.
  const message = fields.dmMessage ?? stored?.dmMessage;
  if (firstLink && message !== undefined && (fields.dmMessage !== undefined || linkAdded)) {
    const linked = withLinkToken(message);
    if (fields.dmMessage !== undefined || linked !== stored?.dmMessage) fields.dmMessage = linked;
  }

  // The follow prompt's button, "i'm following" when left blank.
  if (fields.followPromptButtonLabel !== undefined) {
    fields.followPromptButtonLabel =
      fields.followPromptButtonLabel?.trim() || DEFAULT_FOLLOW_PROMPT_BUTTON_LABEL;
  } else if (fields.requireFollow === true && !stored?.followPromptButtonLabel?.trim()) {
    fields.followPromptButtonLabel = DEFAULT_FOLLOW_PROMPT_BUTTON_LABEL;
  }

  return { ok: true, fields: fields as T };
}

/** A new campaign's settings as the builder would save them, or why it would not. */
export function newCampaignAsBuilt<T extends BuilderFields>(fields: T, accountUsername: string) {
  return asBuilt(fields, null, accountUsername);
}

/**
 * An edit as the builder would save it, given the stored campaign it changes,
 * or why it would not. Only fields the edit gives change, plus those the
 * builder would fill in alongside them.
 */
export function campaignEditAsBuilt<T extends BuilderFields>(
  edit: T,
  stored: StoredFields,
  accountUsername: string
) {
  return asBuilt(edit, stored, accountUsername);
}

// The flags a target sets, which the tools take as one target.
const TARGET_FIELDS: Record<string, string> = {
  postId: "target.postId",
  postUrl: "target.postUrl",
  matchAnyPost: "target",
  pendingNextReel: "target",
};

/** Zod's issues as one sentence per field, in the field names the tools take. */
export function describeCampaignIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
) {
  return issues
    .map((issue) => {
      if (!issue.path.length) return issue.message;
      const [field, ...rest] = issue.path.map(String);
      return `${[TARGET_FIELDS[field] ?? field, ...rest].join(".")}: ${issue.message}`;
    })
    .join("; ");
}
