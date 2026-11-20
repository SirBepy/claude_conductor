// The Answers card's calls to the daemon (daemon/methods/answers.rs) and the
// Ask threads its follow-ups live in (methods/ask.rs). Swappable so the unit
// tests and the view harness can drive the card without a daemon.

import { invoke } from "../../../shared/ipc";
import { getTransport } from "../../../shared/transport";
import type { AskThread } from "../../../types/ipc.generated";
import { emptyStore, type AnswerSide, type AnswerStore } from "../../../shared/chat/dashboard/answers-model";

export interface ThreadSend {
  sessionId: string;
  /** The answer it follows up on; absent for a + question. */
  key: string | null;
  question: string;
  cwd: string | null;
  /** The answer's question on a follow-up; on a new thread, the question card
   *  it was asked from (question-ask.ts), else absent. */
  aboutQuestion?: string;
  aboutAnswer?: string;
}

export interface AnswersApi {
  load(sessionId: string): Promise<AnswerSide>;
  mark(sessionId: string, keys: string[], read: boolean): Promise<AnswerStore>;
  /** Has the daemon write the short question for an answer that carries none; stored once per answer. */
  rewrite(sessionId: string, key: string, joe: string, answer: string): Promise<AnswerStore>;
  /** `onDelta` gets the reply so far while it streams; "" means a retry started over. */
  send(req: ThreadSend, onDelta?: (text: string) => void): Promise<{ thread: AskThread; state: AnswerStore }>;
  /** Starts the thread's warm process while Joe types: `key` is the answer whose
   *  thread opened, null for a new question. Fire and forget. */
  prewarm?(sessionId: string, key: string | null): Promise<void>;
}

/** One `answers-thread-delta` event (daemon/methods/answers.rs). */
interface ThreadDelta {
  stream_id?: string;
  text?: string;
}

/** The daemon answers with serde's shape; anything missing reads as empty. */
export function normaliseStore(raw: unknown): AnswerStore {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<AnswerStore>;
  return {
    read: s.read && typeof s.read === "object" ? { ...s.read } : {},
    threads: s.threads && typeof s.threads === "object" ? { ...s.threads } : {},
    questions: Array.isArray(s.questions) ? s.questions.filter((q) => q && typeof q.thread_id === "string") : [],
    rewrites: s.rewrites && typeof s.rewrites === "object" ? { ...s.rewrites } : {},
  };
}

const daemonApi: AnswersApi = {
  async load(sessionId) {
    const [store, threads] = await Promise.all([
      invoke<unknown>("answers_state", { sessionId }).then(normaliseStore),
      invoke<AskThread[]>("ask_list_threads", { sessionId }),
    ]);
    return { store, threads };
  },
  async mark(sessionId, keys, read) {
    return normaliseStore(await invoke<unknown>("answers_mark", { sessionId, keys, read }));
  },
  async rewrite(sessionId, key, joe, answer) {
    return normaliseStore(await invoke<unknown>("answers_rewrite_question", { sessionId, key, joe, answer }));
  },
  async send(req, onDelta) {
    const streamId = onDelta ? crypto.randomUUID() : null;
    // Listening starts before the send, so no early delta is missed.
    const unlisten = streamId
      ? await getTransport()
        .listen<ThreadDelta>("answers-thread-delta", (d) => {
          if (d?.stream_id === streamId && typeof d.text === "string") onDelta!(d.text);
        })
        .catch(() => () => {})
      : () => {};
    try {
      const out = await invoke<{ thread: AskThread; state: unknown }>("answers_thread_send", {
        sessionId: req.sessionId,
        key: req.key,
        question: req.question,
        cwd: req.cwd,
        aboutQuestion: req.aboutQuestion ?? null,
        aboutAnswer: req.aboutAnswer ?? null,
        streamId,
      });
      return { thread: out.thread, state: normaliseStore(out.state) };
    } finally {
      unlisten();
    }
  },
  async prewarm(sessionId, key) {
    await invoke("answers_thread_prewarm", { sessionId, key });
  },
};

/** How long a failed follow-up waits before its one quiet retry: long enough for a
 *  reconnecting daemon link to be back. */
const SEND_RETRY_MS = 1200;
let retryMs = SEND_RETRY_MS;

/** Test seam: null puts the real delay back. */
export function setSendRetryDelay(ms: number | null): void {
  retryMs = ms ?? SEND_RETRY_MS;
}

/** A failure another try could clear: the call usually never reached the daemon (the phone's link
 *  says "could not reach your PC", the desktop pipe "daemon client not connected"), so a second try
 *  rarely doubles a message; the one gap is a phone link that drops after the PC finished, before the
 *  reply arrived. "client closed" is not retried: the desktop pipe also raises it after the request
 *  was written, while the daemon keeps running the Ask. Everything else is final at once: an error the daemon reports
 *  itself (empty question, unknown thread) would repeat, a Claude process that exited or hung was
 *  already retried by the daemon (ask/warm.rs), and "your PC did not answer" may still complete on
 *  the PC, so a resend could make a second thread. */
export function isRetryableSendError(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? err);
  return /could not reach your PC|daemon client not connected/i.test(msg);
}

/** One send and, on a failure worth it, one more after a short pause, so a hiccup
 *  never reaches Joe. `onDelta("")` tells the card the reply so far is discarded. */
export async function sendWithRetry(
  api: AnswersApi,
  req: ThreadSend,
  onDelta: (text: string) => void,
  alive: () => boolean,
): Promise<{ thread: AskThread; state: AnswerStore }> {
  try {
    return await api.send(req, onDelta);
  } catch (err) {
    if (!isRetryableSendError(err) || !alive()) throw err;
    onDelta("");
    await new Promise((res) => setTimeout(res, retryMs));
    if (!alive()) throw err;
    return api.send(req, onDelta);
  }
}

let active: AnswersApi = daemonApi;

export function answersApi(): AnswersApi {
  return active;
}

/** Test seam: null puts the daemon calls back. */
export function setAnswersApi(api: AnswersApi | null): void {
  active = api ?? daemonApi;
  cache.clear();
}

/** The last state seen per chat, in memory only: reopening a chat draws its
 *  card at once instead of waiting a round trip. The daemon stays the truth. */
const cache = new Map<string, AnswerSide>();

export function cachedSide(sessionId: string): AnswerSide | undefined {
  return cache.get(sessionId);
}

export function rememberSide(sessionId: string, side: AnswerSide): void {
  cache.set(sessionId, side);
}

export function emptySide(): AnswerSide {
  return { store: emptyStore(), threads: [] };
}
