// The Answers card's calls to the daemon (daemon/methods/answers.rs) and the
// Ask threads its follow-ups live in (methods/ask.rs). Swappable so the unit
// tests and the view harness can drive the card without a daemon.

import { invoke } from "../../../shared/ipc";
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
  send(req: ThreadSend): Promise<{ thread: AskThread; state: AnswerStore }>;
}

/** The daemon answers with serde's shape; anything missing reads as empty. */
export function normaliseStore(raw: unknown): AnswerStore {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<AnswerStore>;
  return {
    read: s.read && typeof s.read === "object" ? { ...s.read } : {},
    threads: s.threads && typeof s.threads === "object" ? { ...s.threads } : {},
    questions: Array.isArray(s.questions) ? s.questions.filter((q) => q && typeof q.thread_id === "string") : [],
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
  async send(req) {
    const out = await invoke<{ thread: AskThread; state: unknown }>("answers_thread_send", {
      sessionId: req.sessionId,
      key: req.key,
      question: req.question,
      cwd: req.cwd,
      aboutQuestion: req.aboutQuestion ?? null,
      aboutAnswer: req.aboutAnswer ?? null,
    });
    return { thread: out.thread, state: normaliseStore(out.state) };
  },
};

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
