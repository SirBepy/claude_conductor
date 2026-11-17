# Forever chat: routing measurement on Joe's real transcripts (todo pc-1682, step 1)

Measured 2026-11-17. This is the offline measurement that todo pc-1682 asks for before the [ARCH] approval of topic records and recency-first routing. It decides nothing. No app code changed.

The transcripts are private. This file holds counts and method only, no message text and no topic or sub names.

## Headline numbers

| What | Result |
|---|---|
| Corpus | 65 main chats (of 190 chats that spawned or sent to a sub), 1090 messages Joe typed |
| Of the typed messages: card answers | 303 (27.8%), they carry their own target chat |
| ... no topic (/close, ping, status, ack, app complaint) | 218 (20.0%) |
| ... a new job | 366 (33.6%), of which 60 are the first message of a chat |
| ... continues the most recent topic | 153 (14.0%) |
| ... belongs to an older topic | 50 (4.6%) |
| **Most-recent rule right, among messages that belong to a topic** | **153 of 203 = 75.4%** (24.6% belong to an older topic) |
| Most-recent rule right, among every non-card message after the first job of a chat | 153 of 727 = 21.0% (older topic 6.9%, new job 42.1%, no topic 30.0%) |
| Ambiguous (could not be placed from the message text plus topic names alone) | 107 of the 569 continue / older / new messages = 18.8% |
| Records-only pick of the older topic, Claude (sonnet) | 24 of 50 = 48% (63% of the 38 whose answer was in the window) |
| Records-only pick, local Qwen (`qwen3.5:9b`) | 16 of 50 = 32% (42% of the 38 in-window) |
| Trivial baseline, always the second most recent topic | 19 of 50 = 38% (50% of the 38 in-window) |

## Reading the numbers (no decision)

- For a message that has a topic at all, "send it to the most recent topic" is right three times in four.
- Most of what Joe types into a main chat today is not a continuation: 33.6% start a new job and 20.0% have no topic. Those are the messages a "not mine" exit has to handle, so on this corpus the bounce is the common path, not the rare one. Recency-first as proposed assumes the typed-into chat is a topic chat; these main chats are dispatchers (the main agent spawns subs from the typed message), so the corpus skews toward new jobs. It cannot say how the split would look in a topic-chat world.
- Records-only lookup of an older topic reached 48% with Claude and 32% with Qwen, from a one-line record (name plus the first 100 characters of the task). Qwen came out below always guessing the second most recent topic (38%), and Claude 10 points above it (5 items out of 50). The records in this test are poor: the actual design would have decided / rejected / open rows (pc-1663 is about record quality), so this is a floor for records, not a ceiling.
- About one message in five cannot be placed from its own text and the topic names. That is the share a front router would guess on and the share that needs the current chat's context.

## Method

### Corpus

Transcripts under `~/.claude-personal/projects/*` (all Conductor project folders, worktree and scratch folders excluded). A chat counted as a main chat if it called `spawn_chat` or `subchat send` at least 3 times and had at least 4 typed messages: 65 chats from 12 project folders (11 of the 65 chats are from this repo). A "typed message" is a `user` record with text content, not a tool result, not `isMeta`, not a `[daemon-meta]` note, with `<system-reminder>` and slash-command context blocks stripped and text cut at 350 characters. The timeline for each chat also carried every `spawn_chat` (sub name plus the first 100 characters of its task), every `subchat send` (sub name and the first 150 characters of the text), drop/merge/retry, and a one-line mark where a sub finished.

A topic is a sub (a named job). The most recent topic at a message is the sub last spawned, sent to, or finished before it.

### Labelling

Eight read-only sonnet subagents, one per bin of 7 to 9 chats (about 77 KB of timeline each, balanced by size). Each saw only its own chats and returned codes and counts, never text. Code per message:

- C: answer to a question card (excluded from routing)
- M: no topic
- N: a new job, including the first job of a chat
- R: belongs to the most recent topic
- O: belongs to an older topic (sub named)
- `?` on R, O or N: ambiguous, a person could not place it from the message text and topic names alone

The labeler may use what the main agent did next (spawn or send lines after the message) as evidence of where it belonged. Counts from the eight reports add up to the 1090 messages exactly. Their totals per report: C 39/18/28/30/52/47/50/39, M 21/28/28/27/27/40/23/24, N 48/31/57/45/25/70/33/57, R 33/12/20/25/13/8/17/25, O 20/1/5/5/6/5/3/5, ambiguous 10/8/20/15/10/17/8/19.

The 60 first-message N values were counted from the per-chat J1 codes (60 of 65 chats start with N; the other five start with M or C). 306 N messages therefore arrive after the chat's first job, which is what the 727 figure uses (153 + 50 + 306 + 218). It keeps every M message, including the few typed before any topic existed, so it slightly overstates "while a topic existed".

### Records-only test

Test set: the 50 messages labelled O. For each, the candidates were the 5 topics ranked just behind the most recent one by spawn/send recency, each shown as name plus task line, plus F "none of these, a new job" (the current topic is assumed to have said "not mine"). The true older topic sat inside that window for 38 of the 50 (rank 2 to 6), so no window of 5 can score above 76%. The 12 outside the window (one was the most recent topic by my ranking, one could not be matched to a topic by name, 10 were 7th or older) count as misses in the "of 50" figures.

- **Claude**: one blind sonnet subagent given only the message and the candidate records, no other files. 48% overall, 63% in-window. It answered F (new job) for 13 of the 50 and marked 19 as low confidence.
- **Local Qwen**: `qwen3.5:9b` through Ollama, one prompt per message, temperature 0, 4 tokens out, 4 CPU threads, calls strictly one at a time with a 3 second idle gap. 50 calls took 333 s with the model fully on the GPU (5.5 GB). It answered F for 25 of 50. Run gently on purpose (no parallel calls, no big context); peak CPU and GPU load were not recorded.
- **Jev** was not run: text leaves the machine, so it needs Joe's OK, and nothing here asked for it.

### Limits (read before trusting a digit)

- One labelling pass per chat, by an LLM, never checked by Joe or a second labeler. The O test set and its true topics come from that same pass. Treat each percentage as plus or minus about 10 points; the records-only figures rest on 50 items (a binomial 95% interval of about 14 points either way).
- The labeler saw what the main agent did after each message, so R and O partly reflect the agent's own routing, not an independent judgement of where Joe meant it to go.
- Topic = sub, which is the main agent's split of the work, not Joe's. Many N messages may be a fresh task Joe would call part of an older topic.
- Recency ranks ignore the finish notes (they carry no sub name in the timeline), so rank 2 to 6 is approximate.
- Messages and records are truncated (350, 100 and 150 characters), which hurts every records-only score the same way.
- The 65 main chats come from the Conductor era of one user's work in 12 folders, mostly client and tooling projects; the largest share is not this repo.
- Not measured: how often a working chat would say "not mine" (the first weak point in pc-1682), what the CLI does near its context limit, and Jev.

## What is still open for Joe

The [ARCH] question in pc-1682 stays as written: approve topic records plus recency-first routing, stay with the main chat as router, or put a small model in front. Whatever is chosen, the figures above are the evidence for it.
