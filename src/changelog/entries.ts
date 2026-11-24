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

import planFeatures from "./img/0.2.159/plan-features.png";
import doneCard159 from "./img/0.2.159/done-card.png";
import noProjectMain from "./img/0.2.159/no-project-main.png";
import putAwayClosed from "./img/0.2.159/put-away-closed.png";
import dictation from "./img/0.2.159/dictation.png";
import modelsProviders from "./img/0.2.159/models-providers.png";
import paymentGroup from "./img/0.2.159/payment-group.png";
import usagePercentOnly from "./img/0.2.159/usage-percent-only.png";
import privateAskOff from "./img/0.2.159/private-ask-off.png";
import runPlan from "./img/0.2.158/run-plan.png";
import continuePlan from "./img/0.2.158/continue-plan.png";
import turnIntoProject from "./img/0.2.158/turn-into-project.png";
import subTabs from "./img/0.2.158/sub-tabs.png";
import attachmentsCard from "./img/0.2.158/attachments-card.png";
import idleHidden from "./img/0.2.158/idle-hidden.png";
import waitingOnYou from "./img/0.2.158/waiting-on-you.png";
import notesCard from "./img/0.2.158/notes-card.png";
import chipsWhole from "./img/0.2.158/chips-whole.png";
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
    version: "0.2.159",
    date: "2026-11-24",
    items: [
      {
        icon: "ph-kanban",
        title: "One Plan card per project",
        caption: "A main chat's Plan card has a line per feature, an icon per chat working on it, and todo and ticket ids as icons.",
        image: planFeatures,
        alt: "The Plan card with feature lines, a row of coloured chat icons on each and a time at the right edge",
      },
      {
        icon: "ph-check-circle",
        title: "Done has its own card",
        caption: "The newest three finished features sit in the Done card, in the Plan card's own rows. The rest are a click away.",
        image: doneCard159,
        alt: "The Done card unfolded with three finished features, each with its chat icons and how long ago it finished",
      },
      {
        icon: "ph-chats-circle",
        title: "No project chats stand alone",
        caption: "A chat in No project stays plain until you switch on Make this a main chat, and then it is a main chat of its own.",
        image: noProjectMain,
        alt: "A new chat's message box with the Make this a main chat switch on and the line A main chat of its own",
      },
      {
        icon: "ph-archive",
        title: "Put away means gone from the lists",
        caption: "A put-away chat and its paused subs stay out of every chat list, on the PC and the phone, until you reopen it.",
        image: putAwayClosed,
        alt: "The chat heads column with one open chat and the Hidden eye head showing a 1",
      },
      {
        icon: "ph-microphone",
        title: "Dictation keeps up",
        caption: "Your words land in the box when you stop talking, and a cleaned-up version swaps in behind them within seconds.",
        image: dictation,
        alt: "The message box holding dictated words with the red recording mic beside the send button",
      },
      {
        icon: "ph-plugs-connected",
        title: "Models and providers",
        caption: "Settings lists every account, Claude, Kimi Code, DeepSeek or your own endpoint, and sets which one does which job.",
        image: modelsProviders,
        alt: "The Models and providers page with four accounts, each with a badge, and the Who does what tabs below",
      },
      {
        icon: "ph-wallet",
        title: "A payment group per project",
        caption: "A project picks its payment group and can change the account, model or effort for single roles.",
        image: paymentGroup,
        alt: "A project's Payment group block with the group select, two role overrides and a Change a role button",
      },
      {
        icon: "ph-gauge",
        title: "Only numbers that are right",
        caption: "The token tracker widgets, chat drain chips and Usage card are gone. The claude.ai usage percent stays.",
        image: usagePercentOnly,
        alt: "The home dashboard with two account cards showing their 5 hour and 7 day usage rings",
      },
      {
        icon: "ph-prohibit",
        title: "The private ask chat is off",
        caption: "The Answers card no longer has Reply, plus or New question buttons, and a question card has no Ask.",
        image: privateAskOff,
        alt: "The Answers card with an answer and a Read more link, and no Reply or New question buttons",
      },
    ],
  },
  {
    version: "0.2.158",
    date: "2026-11-22",
    items: [
      {
        icon: "ph-list-checks",
        title: "Run plans start themselves",
        caption: "The main chat holds a run plan, its steps start on their own, and the Plan card shows the lanes and what comes after.",
        image: runPlan,
        alt: "The Plan card with the chat's own steps on top and a run under them: lane chips, a Running tag and a Then row",
      },
      {
        icon: "ph-play-circle",
        title: "Put away, then pick up",
        caption: "A project's main chat is put away instead of closed, and reopening it asks whether to continue the plan.",
        image: continuePlan,
        alt: "A small Continue the plan card above the message box with Yes, resume them and No buttons",
      },
      {
        icon: "ph-folder-plus",
        title: "Turn a chat into a project",
        caption: "A chat in no project can become a project: pick a folder and see what moves with it and what stays.",
        image: turnIntoProject,
        alt: "The Turn into a project dialog with a chosen folder and the lists of what moves and what stays behind",
      },
      {
        icon: "ph-browsers",
        title: "Look inside a sub",
        caption: "An opened sub has a Plan tab and an Attachments tab with that sub's previews, images, files and links.",
        image: subTabs,
        alt: "An opened sub card on its Attachments tab with three image rows and a message box",
      },
      {
        icon: "ph-paperclip",
        title: "Attachments in a fixed size",
        caption: "Previews, Images, Files and Links keep one size on every tab, and files show only their names.",
        image: attachmentsCard,
        alt: "The Attachments card on its Files tab with four file names and the Previews, Images, Files and Links tabs",
      },
      {
        icon: "ph-eye-slash",
        title: "Idle chats tuck themselves away",
        caption: "After 10 minutes of nothing, a chat whose result you saw moves into Hidden. A chat with a question or a wait stays.",
        image: idleHidden,
        alt: "The chat heads column with the Hidden eye head showing a 2 for two chats that hid by themselves",
      },
      {
        icon: "ph-bell",
        title: "Waiting on you stays current",
        caption: "A question you answered, skipped or that can no longer be answered leaves the list.",
        image: waitingOnYou,
        alt: "The Waiting on you card holding one open question, with no answered or skipped ones",
      },
      {
        icon: "ph-note",
        title: "Notes keep to the point",
        caption: "The Notes card shows only Claude's calls and corrections.",
        image: notesCard,
        alt: "The Notes card with a correction and a call",
      },
      {
        icon: "ph-arrows-in-line-vertical",
        title: "Suggestions stay whole",
        caption: "Quick-reply chips are no longer cut off above the message box, and the dashboard fades into it.",
        image: chipsWhole,
        alt: "Three quick-reply chips sitting whole above the message box",
      },
    ],
  },
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
