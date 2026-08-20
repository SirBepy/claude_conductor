// Todo 661: loadFromStore now fires an unconditional get_skipped_question_marks
// call alongside load_history_page, which stole a raw FIFO
// mockResolvedValueOnce() slot from the next real page. Route by command name.

export function makeInvokeRouter(invokeMock) {
  const queues = new Map();
  invokeMock.mockImplementation((cmd) => {
    const q = queues.get(cmd);
    if (q && q.length > 0) return q.shift()();
    if (cmd === "get_skipped_question_marks") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  return {
    queueOnce(cmd, value) {
      const q = queues.get(cmd) ?? [];
      q.push(() => Promise.resolve(value));
      queues.set(cmd, q);
    },
  };
}
