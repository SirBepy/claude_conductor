// Docker/Codespaces-style random name generator ("swift-otter") for things
// that need a default identifier nobody wants to type - currently just the
// worktree-picker's "New worktree" step.

const ADJECTIVES = [
  "swift", "brave", "calm", "quiet", "bold", "eager", "gentle", "lively",
  "misty", "nimble", "proud", "quick", "rapid", "sunny", "wild", "witty",
  "amber", "azure", "coral", "golden", "hazy", "ivory", "jolly", "keen",
  "lucky", "merry", "noble", "plucky", "rusty", "silver", "sleek", "stormy",
  "tidy", "vivid", "warm", "young", "zesty", "bright", "crisp", "dusty",
];

const NOUNS = [
  "otter", "falcon", "badger", "heron", "lynx", "raven", "sparrow", "wren",
  "beaver", "cobra", "dolphin", "eagle", "ferret", "gecko", "hawk", "ibis",
  "jaguar", "koala", "lemur", "mantis", "newt", "osprey", "panther", "quail",
  "rabbit", "swan", "tiger", "urchin", "viper", "walrus", "yak", "zebra",
  "canyon", "comet", "meadow", "harbor", "summit", "delta", "ridge", "cove",
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** e.g. "swift-otter". Not guaranteed unique - callers that need uniqueness
 *  (worktree folder names) already collision-check on the resulting path. */
export function randomName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
