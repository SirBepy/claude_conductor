// The in-app "What's new" content, one entry per release, newest first.
//
// To add a release: append an entry at the TOP of ENTRIES whose `version`
// equals the version being shipped (the same string the app reports, no "v"),
// drop its pictures in ./img/<version>/ and import them below. A release with
// no entry is simply not announced on the empty screen: the panel auto-opens
// only when the entry's version equals the version the app just updated to
// (views/sessions/whats-new/whats-new-state.ts). How to pick the items and
// capture the pictures: docs/architecture/release-shape.md (What's new section).
//
// Keep it visual: a title of a few words, ONE short caption in plain words,
// and a real screenshot. No release-note prose, no internals.

import lightboxGallery from "./img/0.2.157/lightbox-gallery.png";
import questionKeepsPlace from "./img/0.2.157/question-keeps-place.png";
import queuedSubs from "./img/0.2.157/queued-subs.png";
import headBadge from "./img/0.2.157/head-badge.png";
import secretCard from "./img/0.2.157/secret-card.png";
import doneCard from "./img/0.2.157/done-card.png";
import attachmentsTabs from "./img/0.2.157/attachments-tabs.png";
import accountPicker from "./img/0.2.154/account-picker.png";
import missedItems from "./img/0.2.154/missed-items.png";
import orderedQuestion from "./img/0.2.153/ordered-question.png";
import resultCard from "./img/0.2.152/result-card.png";

export interface ChangelogItem {
  /** Phosphor icon class, e.g. "ph-users". */
  icon: string;
  title: string;
  caption: string;
  /** Bundled picture URL (a vite asset import) of the real UI. */
  image: string;
  /** Alt text for the picture. */
  alt: string;
}

export interface ChangelogEntry {
  /** App version without the leading "v", e.g. "0.2.154". */
  version: string;
  /** ISO date of the release. */
  date: string;
  items: ChangelogItem[];
}

export const ENTRIES: ChangelogEntry[] = [
  {
    version: "0.2.157",
    date: "2026-11-20",
    items: [
      {
        icon: "ph-images",
        title: "Flip through images",
        caption: "Left and Right, the arrows or a swipe step through a group of images, with a counter.",
        image: lightboxGallery,
        alt: "An image open in the viewer with previous and next arrows and a 2 / 4 counter",
      },
      {
        icon: "ph-arrow-line-down",
        title: "Questions keep your place",
        caption: "Picking an answer no longer throws the card back to the top.",
        image: questionKeepsPlace,
        alt: "A scrolled question card with two options ticked part way down the list",
      },
      {
        icon: "ph-clock",
        title: "See what is queued",
        caption: "The Subchats card counts waiting chats, and the count lists them in the order they will start.",
        image: queuedSubs,
        alt: "The Subchats card with a 3 queued count and a popup listing each waiting chat",
      },
      {
        icon: "ph-number-circle-one",
        title: "One clear number per chat",
        caption: "A chat head shows a single number for what waits on you, the same open or not, and hidden chats show none.",
        image: headBadge,
        alt: "Side column of heads, a folder head and a chat head each with a red 1, and a third chat head with none",
      },
      {
        icon: "ph-lock-key",
        title: "Secret requests wait in line",
        caption: "A secret request joins the other questions in a picker, so it no longer hides them.",
        image: secretCard,
        alt: "A Secret requested card with a masked value field and a picker tab for another chat's question",
      },
      {
        icon: "ph-check-circle",
        title: "Tidier Done list",
        caption: "Finished tasks are plain rows that say how long ago they finished, like 20 min ago.",
        image: doneCard,
        alt: "The Done card with three rows ending in 20 min ago, 3 hr ago and 1 d ago",
      },
      {
        icon: "ph-paperclip",
        title: "Attachments in one card",
        caption: "Links, Files, Previews and Images each get a tab, and an image opens in the gallery.",
        image: attachmentsTabs,
        alt: "The Attachments card with Links, Files, Previews and Images tabs and two image rows",
      },
    ],
  },
  {
    version: "0.2.154",
    date: "2026-11-16",
    items: [
      {
        icon: "ph-users",
        title: "A cleaner account picker",
        caption: "Accounts sit in tidy rows, hover one for its numbers, and a limited account gets a red tag.",
        image: accountPicker,
        alt: "The Change account picker with Subscriptions and API credit sections and a red limit tag on one account",
      },
      {
        icon: "ph-clock-countdown",
        title: "Close the missed items panel",
        caption: "A Close button hides it until the next launch, and your missed items stay put.",
        image: missedItems,
        alt: "The missed scheduled items panel with its new Close button",
      },
    ],
  },
  {
    version: "0.2.153",
    date: "2026-11-15",
    items: [
      {
        icon: "ph-list-numbers",
        title: "Answer a question in order",
        caption: "Tap the options in the order you want and Claude gets them numbered.",
        image: orderedQuestion,
        alt: "A question card with options numbered 1, 2 and 3 in the order they were tapped",
      },
    ],
  },
  {
    version: "0.2.152",
    date: "2026-11-14",
    items: [
      {
        icon: "ph-check-circle",
        title: "The result stays in view",
        caption: "A chat's final result is a green card on the left with a Got it button.",
        image: resultCard,
        alt: "The chat dashboard with a green Result card and a Got it button",
      },
    ],
  },
];
