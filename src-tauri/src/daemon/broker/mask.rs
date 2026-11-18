//! Secret masker: removes every stored secret's exact value, in each encoded
//! form, from any text the broker returns or writes.
//!
//! Hard rules (docs/api-broker-plan.md, "Masking" and "Rejected"):
//! - Exact values only. There is no regex and no match by token shape, so a
//!   look-alike string is never touched and a secret is never guessed at.
//! - A mask is the fixed `MARKER`, never a run of `*` sized to the secret, so
//!   the output does not reveal the secret's length class.
//! - An empty secret is ignored. It would otherwise match everywhere.
//! - Overlapping, repeated and adjacent hits collapse into one marker per
//!   merged region, so no fragment of a secret survives between two hits.
//! - A stream masks across chunk boundaries: `MaskStream` holds back the tail
//!   that could still be the start of a hit, and its total output equals what
//!   `Masker::mask_bytes` gives for the whole body.
//!
//! The forms come from `util::secret_store::encoded_variants` (raw, percent,
//! JSON, hex, base64 flavours, Basic payloads of `secret:` and `:secret`) plus
//! the extras in `extra_variants`. Masking is a single pass: the marker is
//! never rescanned, so a secret that happens to occur inside the marker text
//! cannot loop.

use crate::util::secret_store::encoded_variants;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;

/// What a masked region becomes. Fixed text, independent of what was removed.
pub const MARKER: &str = "[MASKED]";

/// Shortest base64 fragment the alignment variants use. Shorter fragments of a
/// short secret would mask unrelated text.
const MIN_ALIGNED_B64: usize = 12;

/// Collects secrets, then builds the matcher.
#[derive(Default)]
pub struct MaskerBuilder {
    patterns: Vec<Vec<u8>>,
}

impl MaskerBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a secret in every form. An empty secret is ignored.
    pub fn secret(mut self, secret: &str) -> Self {
        if secret.is_empty() {
            return self;
        }
        let mut forms = encoded_variants(secret);
        forms.extend(extra_variants(secret, &forms));
        for f in forms {
            self.add(f.into_bytes());
        }
        self
    }

    /// Adds a secret and the base64 forms of a Basic credential `user:secret`.
    /// `encoded_variants` cannot derive those without the user. An empty user
    /// adds nothing beyond `secret` (the `:secret` form is already covered).
    pub fn secret_with_user(self, user: &str, secret: &str) -> Self {
        if secret.is_empty() {
            return self;
        }
        let mut b = self.secret(secret);
        if !user.is_empty() {
            let shaped = format!("{user}:{secret}");
            for f in base64_flavours(shaped.as_bytes()) {
                b.add(f.into_bytes());
            }
        }
        b
    }

    fn add(&mut self, p: Vec<u8>) {
        if !p.is_empty() && !self.patterns.contains(&p) {
            self.patterns.push(p);
        }
    }

    pub fn build(self) -> Masker {
        let mut by_first: Vec<Vec<u32>> = vec![Vec::new(); 256];
        let mut max_len = 0;
        for (i, p) in self.patterns.iter().enumerate() {
            by_first[p[0] as usize].push(i as u32);
            max_len = max_len.max(p.len());
        }
        Masker { patterns: self.patterns, by_first, max_len }
    }
}

/// Exact-value matcher over every form of every secret it was built with.
pub struct Masker {
    patterns: Vec<Vec<u8>>,
    /// Pattern indexes keyed by first byte, so a scan only compares candidates.
    by_first: Vec<Vec<u32>>,
    max_len: usize,
}

// Never prints the patterns: a stray `{:?}` in a log line would leak them.
impl std::fmt::Debug for Masker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Masker({} patterns)", self.patterns.len())
    }
}

impl Masker {
    /// Masker for plain secrets (no Basic user known). Empties are ignored.
    pub fn new<S: AsRef<str>>(secrets: &[S]) -> Self {
        let mut b = MaskerBuilder::new();
        for s in secrets {
            b = b.secret(s.as_ref());
        }
        b.build()
    }

    /// True when nothing would ever be masked (no secrets, or only empty ones).
    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// True when `hay` still holds any known form of a secret.
    pub fn contains_secret(&self, hay: &[u8]) -> bool {
        (0..hay.len()).any(|i| self.hits_at(hay, i).next().is_some())
    }

    /// Masks text: bodies, header values, error strings, `out_file` text.
    pub fn mask_str(&self, text: &str) -> String {
        // Hits start and end on char boundaries (UTF-8 is self-synchronizing
        // and every pattern is whole chars), so the result stays valid UTF-8.
        String::from_utf8(self.mask_bytes(text.as_bytes()))
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
    }

    /// Masks raw bytes (a body that is not known to be UTF-8).
    pub fn mask_bytes(&self, hay: &[u8]) -> Vec<u8> {
        let iv = self.merged(hay, None);
        render(hay, &iv, hay.len(), false)
    }

    /// Streaming masker for a body that arrives in chunks.
    pub fn stream(&self) -> MaskStream<'_> {
        MaskStream { masker: self, pending: Vec::new(), lead: None }
    }

    /// End offsets of every pattern that starts at `i`.
    fn hits_at<'a>(&'a self, hay: &'a [u8], i: usize) -> impl Iterator<Item = usize> + 'a {
        self.by_first[hay[i] as usize].iter().filter_map(move |&pi| {
            let p = &self.patterns[pi as usize];
            hay[i..].starts_with(p).then(|| i + p.len())
        })
    }

    /// Hits as sorted, disjoint, non-adjacent regions: overlapping and touching
    /// hits are one region, so one marker and no leftover fragment. Hits are
    /// folded in as they are found (starts only grow), so a body that is one
    /// long self-overlapping hit costs one region, not one entry per hit.
    ///
    /// `lead` is a region of the stream already answered with a marker that
    /// reaches `lead` bytes into `hay`; a hit that overlaps or touches it joins it.
    fn merged(&self, hay: &[u8], lead: Option<usize>) -> Vec<(usize, usize)> {
        let mut out: Vec<(usize, usize)> = lead.map(|l| (0, l)).into_iter().collect();
        for i in 0..hay.len() {
            for e in self.hits_at(hay, i) {
                match out.last_mut() {
                    Some(last) if i <= last.1 => last.1 = last.1.max(e),
                    _ => out.push((i, e)),
                }
            }
        }
        out
    }
}

/// Copies `hay[..upto]`, swapping each region that ends within `upto` for the
/// marker. With `first_marked` the first region is the stream's `lead`, whose
/// marker went out earlier, so its bytes are dropped and no second marker is written.
fn render(hay: &[u8], regions: &[(usize, usize)], upto: usize, first_marked: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(upto);
    let mut at = 0;
    for (idx, &(s, e)) in regions.iter().enumerate() {
        if e > upto {
            break;
        }
        out.extend_from_slice(&hay[at..s]);
        if !(idx == 0 && first_marked) {
            out.extend_from_slice(MARKER.as_bytes());
        }
        at = e;
    }
    out.extend_from_slice(&hay[at..upto]);
    out
}

/// Masks a body arriving in chunks. Keeps back only the bytes that could still
/// be the start (or an extension) of a hit, so a secret split across two chunks
/// is still caught and nothing is delayed beyond `longest pattern - 1` bytes.
pub struct MaskStream<'a> {
    masker: &'a Masker,
    /// Bytes not released yet: at most `longest pattern - 1` plus a char's worth
    /// after any push, whatever the body looks like.
    pending: Vec<u8>,
    /// A marker was already released for the region that covers the first
    /// `lead` bytes of `pending`. A hit that overlaps or touches it extends that
    /// region without a second marker, so a hit that keeps growing (a one-char
    /// secret in a body of that char) never has to be held back whole.
    lead: Option<usize>,
}

/// UTF-8 continuation bytes are `10xxxxxx`; a char has at most 3 of them.
const MAX_CONTINUATION: usize = 3;

impl MaskStream<'_> {
    /// Takes the next chunk and returns the bytes now safe to release. Chunks
    /// may split a UTF-8 char anywhere; valid UTF-8 is never released half a char.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        let len = self.pending.len();
        let hold = self.masker.max_len.saturating_sub(1);
        if self.masker.is_empty() {
            return std::mem::take(&mut self.pending);
        }
        if len <= hold {
            return Vec::new();
        }
        // A hit starting before `len - hold` ends inside the buffer, so it has
        // been found. One starting later may be incomplete or still growing.
        let mut cut = len - hold;
        // Move left to a char boundary. Only ever left, so nothing past the
        // safe point is released; the region handling below runs after this, so
        // it holds for non-UTF-8 input too.
        let mut back = 0;
        while back < MAX_CONTINUATION && cut > 0 && (self.pending[cut] & 0xC0) == 0x80 {
            cut -= 1;
            back += 1;
        }
        if cut == 0 {
            return Vec::new();
        }
        let regions = self.masker.merged(&self.pending, self.lead);
        let marked = self.lead.is_some();
        let done = regions.iter().take_while(|r| r.1 < cut).count();
        // The next region, if it begins before the cut, reaches it (or touches
        // it), so a later hit may still join it: answer it with its marker now
        // and remember how far it reaches into what stays.
        let straddler = regions.get(done).filter(|r| r.0 < cut).copied();
        let upto = straddler.map_or(cut, |r| r.0);
        let mut out = render(&self.pending, &regions[..done], upto, marked);
        if let Some((_, e)) = straddler {
            if !(done == 0 && marked) {
                out.extend_from_slice(MARKER.as_bytes());
            }
            self.lead = Some(e - cut);
        } else {
            self.lead = None;
        }
        self.pending.drain(..cut);
        out
    }

    /// Releases what is left once the body has ended.
    pub fn finish(&mut self) -> Vec<u8> {
        let rest = std::mem::take(&mut self.pending);
        let regions = self.masker.merged(&rest, self.lead);
        let out = render(&rest, &regions, rest.len(), self.lead.is_some());
        self.lead = None;
        out
    }
}

/// The four base64 alphabets and paddings a Basic or token header may use.
fn base64_flavours(bytes: &[u8]) -> [String; 4] {
    [STANDARD.encode(bytes), STANDARD_NO_PAD.encode(bytes), URL_SAFE.encode(bytes), URL_SAFE_NO_PAD.encode(bytes)]
}

/// Forms beyond `encoded_variants`, each one a way a server or client is seen to
/// re-encode a value:
/// - uppercase hex;
/// - percent-encoding with the other encoders' safe sets (JavaScript's
///   `encodeURIComponent` leaves `!*'()` raw, form encoding leaves `*` raw and
///   encodes `~`, Python's `quote` leaves `/` raw, path and query serialisers
///   leave sub-delimiters raw), in both hex cases, applied to the secret and to
///   every form that carries `+`, `/` or `=` (the base64 ones);
/// - `+` for a space in form encoding;
/// - JSON with the unicode escape for every non-ASCII char (Python's default),
///   and for `&`, `<` and `>` (Go's default), in both hex cases, with and
///   without the escaped slash;
/// - the escaped slash on the base64 forms (PHP's `json_encode`);
/// - base64 of the secret as it appears inside a longer base64 string at each of
///   the three byte alignments, which is how `base64(user:secret)` shows the
///   secret when the user is unknown. Only whole 3-byte groups inside the secret
///   are used, because the groups at the edges also encode neighbouring bytes;
///   the 1 to 5 secret bytes at the edges are therefore not covered.
fn extra_variants(secret: &str, known: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    out.push(secret.bytes().map(|b| format!("{b:02X}")).collect());
    for ascii in [false, true] {
        for html in [false, true] {
            for slash in [false, true] {
                for upper in [false, true] {
                    out.push(json_escape(secret, ascii, html, slash, upper));
                }
            }
        }
    }
    let bytes = secret.as_bytes();
    for offset in 0..3usize {
        let start = (3 - offset) % 3;
        if bytes.len() < start {
            continue;
        }
        let groups = (bytes.len() - start) / 3;
        if groups * 4 < MIN_ALIGNED_B64 {
            continue;
        }
        let inner = &bytes[start..start + groups * 3];
        out.push(STANDARD.encode(inner));
        out.push(URL_SAFE.encode(inner));
    }
    // Forms a container re-encodes: the secret itself, and base64 text, whose
    // `+`, `/` and `=` are the characters URLs and JSON rewrite.
    let mut carriers: Vec<String> = vec![secret.to_string()];
    carriers.extend(
        known
            .iter()
            .chain(out.iter())
            .filter(|v| v.contains(['+', '/', '=']) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=_-".contains(&b)))
            .cloned(),
    );
    carriers.sort();
    carriers.dedup();
    for c in &carriers {
        for keep in PERCENT_KEEP {
            for lower in [false, true] {
                out.push(percent(c, keep, lower));
            }
        }
        if c.contains('/') {
            out.push(c.replace('/', "\\/"));
        }
    }
    let spaced: Vec<String> =
        known.iter().chain(out.iter()).filter(|v| v.contains("%20")).map(|v| v.replace("%20", "+")).collect();
    out.extend(spaced);
    out.retain(|v| !v.is_empty() && !known.contains(v));
    out.sort();
    out.dedup();
    out
}

/// Characters, besides letters and digits, that an encoder in common use leaves
/// raw. The first is RFC 3986's unreserved set.
const PERCENT_KEEP: [&[u8]; 5] =
    [b"-_.~", b"-_.~!*'()", b"-_.*", b"-_.~/", b"-_.~!$&'()*+,;=:@/?"];

fn percent(s: &str, keep: &[u8], lower: bool) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || keep.contains(&b) {
            out.push(b as char);
        } else if lower {
            out.push_str(&format!("%{b:02x}"));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// JSON string body (no outer quotes) with the escaping choices servers differ on.
fn json_escape(s: &str, ascii_only: bool, html: bool, slash: bool, upper: bool) -> String {
    let hex = |u: u32| if upper { format!("\\u{u:04X}") } else { format!("\\u{u:04x}") };
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '/' if slash => out.push_str("\\/"),
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' if html => out.push_str(&hex(c as u32)),
            c if (c as u32) < 0x20 => out.push_str(&hex(c as u32)),
            c if ascii_only && !c.is_ascii() => {
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    out.push_str(&hex(*u as u32));
                }
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a real token: a canary with every character class the encoders touch.
    const CANARY: &str = "CNRY-Tok/en+9=&\"q\"~.é";

    fn pct(s: &str, lower: bool) -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                    (b as char).to_string()
                } else if lower {
                    format!("%{b:02x}")
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    }

    /// Independent of `encoded_variants`, so a regression there shows up here.
    fn every_form(secret: &str) -> Vec<(&'static str, String)> {
        let json = serde_json::to_string(secret).unwrap();
        let json = json[1..json.len() - 1].to_string();
        vec![
            ("raw", secret.to_string()),
            ("percent upper", pct(secret, false)),
            ("percent lower", pct(secret, true)),
            ("json", json.clone()),
            ("json escaped slash", json.replace('/', "\\/")),
            ("json ascii", json_escape(secret, true, false, false, false)),
            ("json ascii upper", json_escape(secret, true, false, false, true)),
            ("json go html", json_escape(secret, false, true, false, false)),
            ("hex lower", secret.bytes().map(|b| format!("{b:02x}")).collect()),
            ("hex upper", secret.bytes().map(|b| format!("{b:02X}")).collect()),
            ("b64 std", STANDARD.encode(secret)),
            ("b64 nopad", STANDARD_NO_PAD.encode(secret)),
            ("b64 url", URL_SAFE.encode(secret)),
            ("b64 url nopad", URL_SAFE_NO_PAD.encode(secret)),
            ("basic secret:", STANDARD.encode(format!("{secret}:"))),
            ("basic :secret", STANDARD.encode(format!(":{secret}"))),
            ("basic secret: url", URL_SAFE_NO_PAD.encode(format!("{secret}:"))),
        ]
    }

    #[test]
    fn every_encoded_form_is_masked_in_a_body() {
        let m = Masker::new(&[CANARY]);
        for (name, form) in every_form(CANARY) {
            let body = format!("{{\"echo\":\"{form}\",\"ok\":true}}");
            let out = m.mask_str(&body);
            assert_eq!(out, format!("{{\"echo\":\"{MARKER}\",\"ok\":true}}"), "form {name}");
            assert!(!m.contains_secret(out.as_bytes()), "form {name}");
        }
    }

    #[test]
    fn header_values_and_error_strings_are_masked() {
        let m = Masker::new(&[CANARY]);
        let hv = format!("Bearer {CANARY}");
        assert_eq!(m.mask_str(&hv), format!("Bearer {MARKER}"));
        let loc = format!("https://x.test/cb?token={}&next=1", pct(CANARY, false));
        assert_eq!(m.mask_str(&loc), format!("https://x.test/cb?token={MARKER}&next=1"));
        let err = format!("error sending request for url (https://x.test/?k={CANARY}): connection refused");
        assert!(!m.mask_str(&err).contains("CNRY"));
        let basic = format!("Authorization: Basic {}", STANDARD.encode(format!("{CANARY}:")));
        assert_eq!(m.mask_str(&basic), format!("Authorization: Basic {MARKER}"));
    }

    #[test]
    fn basic_user_colon_secret_is_masked_when_the_user_is_known() {
        let m = MaskerBuilder::new().secret_with_user("joe@example.test", CANARY).build();
        for enc in base64_flavours(format!("joe@example.test:{CANARY}").as_bytes()) {
            assert_eq!(m.mask_str(&format!("Basic {enc}")), format!("Basic {MARKER}"));
        }
    }

    #[test]
    fn basic_with_an_unknown_user_leaves_no_long_base64_fragment() {
        let canary = "CNRY-longer-canary-value-0123456789abcdef";
        let m = Masker::new(&[canary]);
        for user in ["", "a", "ab", "abc", "abcd", "someone@example.test"] {
            let enc = STANDARD.encode(format!("{user}:{canary}"));
            let out = m.mask_str(&format!("Authorization: Basic {enc}"));
            assert!(out.contains(MARKER), "user {user:?}: {out}");
            let aligned = (3 - ((user.len() + 1) % 3)) % 3;
            let inner = &canary.as_bytes()[aligned..aligned + (canary.len() - aligned) / 3 * 3];
            assert!(!out.contains(&STANDARD.encode(inner)), "user {user:?}");
        }
    }

    #[test]
    fn unicode_secrets_are_masked_in_every_form() {
        let canary = "pässwörd-日本語-😀";
        let m = Masker::new(&[canary]);
        for (name, form) in every_form(canary) {
            assert_eq!(m.mask_str(&format!("<{form}>")), format!("<{MARKER}>"), "form {name}");
        }
        // The astral char is a surrogate pair in ASCII-escaped JSON.
        assert_eq!(m.mask_str("\"p\\u00e4ssw\\u00f6rd-\\u65e5\\u672c\\u8a9e-\\ud83d\\ude00\""), format!("\"{MARKER}\""));
    }

    #[test]
    fn spaces_in_a_secret_also_match_the_form_encoded_plus() {
        let m = Masker::new(&["correct horse battery"]);
        assert_eq!(m.mask_str("p=correct+horse+battery&q=1"), format!("p={MARKER}&q=1"));
        assert_eq!(m.mask_str("p=correct%20horse%20battery"), format!("p={MARKER}"));
    }

    #[test]
    fn repeated_occurrences_each_get_one_marker() {
        let m = Masker::new(&["abcdef"]);
        assert_eq!(m.mask_str("abcdef and abcdef and abcdef"), format!("{MARKER} and {MARKER} and {MARKER}"));
    }

    #[test]
    fn touching_and_overlapping_hits_become_one_marker() {
        let m = Masker::new(&["abcd", "cdef"]);
        // Overlap of two different secrets: nothing of either survives.
        assert_eq!(m.mask_str("xabcdefx"), format!("x{MARKER}x"));
        // Self-overlap.
        let m = Masker::new(&["aaaa"]);
        assert_eq!(m.mask_str("aaaaaaa"), MARKER);
        // Back to back.
        let m = Masker::new(&["abc"]);
        assert_eq!(m.mask_str("abcabc"), MARKER);
        // One secret inside another's encoded form.
        let m = Masker::new(&["tok-1", "tok-12345"]);
        assert_eq!(m.mask_str("a tok-12345 b"), format!("a {MARKER} b"));
    }

    #[test]
    fn an_empty_secret_is_ignored_and_never_masks_everything() {
        let m = Masker::new(&[""]);
        assert!(m.is_empty());
        assert_eq!(m.mask_str("nothing to hide"), "nothing to hide");
        let m = Masker::new(&["", "real-secret-value", ""]);
        assert_eq!(m.mask_str("a real-secret-value b"), format!("a {MARKER} b"));
        let m = MaskerBuilder::new().secret_with_user("u", "").secret_with_user("", "").build();
        assert!(m.is_empty());
        assert_eq!(m.mask_str("abc"), "abc");
        let mut s = m.stream();
        assert_eq!(s.push(b"abc"), b"abc");
        assert!(s.finish().is_empty());
    }

    #[test]
    fn a_very_short_secret_is_still_masked_exactly() {
        // Not skipped: skipping would leak it. It over-masks, which is the safe side.
        let m = Masker::new(&["q"]);
        assert_eq!(m.mask_str("a q b"), format!("a {MARKER} b"));
        assert_eq!(m.mask_str("no hits here"), "no hits here");
        let m = Masker::new(&["ab"]);
        assert_eq!(m.mask_str("xabx ab"), format!("x{MARKER}x {MARKER}"));
        // Its encoded forms are masked too.
        assert_eq!(m.mask_str(&format!("v={}", STANDARD.encode("ab"))), format!("v={MARKER}"));
    }

    #[test]
    fn the_marker_does_not_reveal_the_secret_length() {
        let short = Masker::new(&["abcdefgh"]).mask_str("x abcdefgh y");
        let long = Masker::new(&["abcdefgh-".repeat(40).as_str()]).mask_str(&format!("x {} y", "abcdefgh-".repeat(40)));
        assert_eq!(short, long);
        assert_eq!(short, format!("x {MARKER} y"));
    }

    #[test]
    fn matching_is_exact_never_by_shape() {
        let m = Masker::new(&["Token123abc"]);
        for near in ["token123abc", "Token123abd", "Token123ab", "Token 123abc", "oken123abc", "TOKEN123ABC"] {
            assert_eq!(m.mask_str(near), near, "{near}");
        }
        // A token-shaped string that is not a stored secret is left alone.
        assert_eq!(m.mask_str("lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"), "lin_api_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    }

    #[test]
    fn several_secrets_are_all_masked() {
        let m = Masker::new(&["first-secret-aaa", "second-secret-bbb"]);
        let out = m.mask_str(&format!("{} / {}", pct("first-secret-aaa", false), STANDARD.encode("second-secret-bbb")));
        assert_eq!(out, format!("{MARKER} / {MARKER}"));
    }

    #[test]
    fn json_stays_parseable_after_masking() {
        let m = Masker::new(&[CANARY]);
        let body = serde_json::json!({"a": CANARY, "b": [CANARY, "x"], "c": {"k": format!("pre {CANARY} post")}}).to_string();
        let out = m.mask_str(&body);
        let v: serde_json::Value = serde_json::from_str(&out).expect("masked JSON still parses");
        assert_eq!(v["a"], MARKER);
        assert_eq!(v["c"]["k"], format!("pre {MARKER} post"));
        assert!(!m.contains_secret(out.as_bytes()));
    }

    #[test]
    fn masking_is_single_pass_when_the_secret_sits_inside_the_marker() {
        let m = Masker::new(&["MASK"]);
        assert_eq!(m.mask_str("a MASK b"), format!("a {MARKER} b"));
        // Different case than the marker text, but bytes of the marker never rescan.
        assert_eq!(m.mask_str("MASKMASK"), MARKER);
    }

    #[test]
    fn debug_never_prints_the_patterns() {
        let m = Masker::new(&[CANARY]);
        let d = format!("{m:?}");
        assert!(!d.contains("CNRY") && d.starts_with("Masker("), "{d}");
    }

    #[test]
    fn bytes_that_are_not_utf8_pass_through_around_a_hit() {
        let m = Masker::new(&["abc-secret"]);
        let mut input = vec![0xff, 0xfe];
        input.extend_from_slice(b"abc-secret");
        input.push(0x80);
        let mut want = vec![0xff, 0xfe];
        want.extend_from_slice(MARKER.as_bytes());
        want.push(0x80);
        assert_eq!(m.mask_bytes(&input), want);
    }

    fn whole(m: &Masker, input: &[u8]) -> Vec<u8> {
        m.mask_bytes(input)
    }

    /// What each `push` released, then what `finish` released.
    fn stream_chunks(m: &Masker, input: &[u8], sizes: &[usize]) -> Vec<Vec<u8>> {
        let mut s = m.stream();
        let mut out = Vec::new();
        let mut at = 0;
        let mut i = 0;
        while at < input.len() {
            let n = sizes[i % sizes.len()].min(input.len() - at);
            out.push(s.push(&input[at..at + n]));
            assert!(s.pending.len() <= m.max_len + MAX_CONTINUATION, "{} bytes held back", s.pending.len());
            at += n;
            i += 1;
        }
        out.push(s.finish());
        out
    }

    fn streamed(m: &Masker, input: &[u8], sizes: &[usize]) -> Vec<u8> {
        let chunks = stream_chunks(m, input, sizes);
        // Released text of a UTF-8 input is always whole chars.
        assert!(chunks.iter().all(|c| std::str::from_utf8(c).is_ok()), "a chunk split a char");
        chunks.concat()
    }

    fn sample() -> (Masker, String) {
        let m = Masker::new(&[CANARY, "second-ünïcode-secret", "aaaa"]);
        let body = format!(
            "{{\"a\":\"{CANARY}\",\"b\":\"{}\",\"c\":\"{}\",\"d\":\"second-ünïcode-secret\"}} aaaaaaa {CANARY}{CANARY} é end {}",
            pct(CANARY, true),
            STANDARD.encode(format!("{CANARY}:")),
            "second-ünïcode-secret"
        );
        (m, body)
    }

    #[test]
    fn a_secret_split_by_a_chunk_boundary_is_masked() {
        let m = Masker::new(&["split-me-secret-xyz"]);
        let mut s = m.stream();
        let mut out = s.push(b"before split-me-sec");
        out.extend(s.push(b"ret-xyz after"));
        out.extend(s.finish());
        assert_eq!(String::from_utf8(out).unwrap(), format!("before {MARKER} after"));
    }

    #[test]
    fn an_encoded_form_split_across_three_chunks_is_masked() {
        let m = Masker::new(&["split-me-secret-xyz"]);
        let enc = STANDARD.encode("split-me-secret-xyz");
        let (a, rest) = enc.split_at(5);
        let (b, c) = rest.split_at(7);
        let mut s = m.stream();
        let mut out = s.push(format!("x={a}").as_bytes());
        out.extend(s.push(b.as_bytes()));
        out.extend(s.push(format!("{c}&y").as_bytes()));
        out.extend(s.finish());
        assert_eq!(String::from_utf8(out).unwrap(), format!("x={MARKER}&y"));
    }

    #[test]
    fn every_two_way_split_gives_the_whole_body_result() {
        let (m, body) = sample();
        let bytes = body.as_bytes();
        let want = whole(&m, bytes);
        assert!(!m.contains_secret(&want));
        for cut in 0..=bytes.len() {
            let mut s = m.stream();
            let mut out = s.push(&bytes[..cut]);
            out.extend(s.push(&bytes[cut..]));
            out.extend(s.finish());
            assert_eq!(out, want, "split at {cut}");
        }
    }

    #[test]
    fn every_fixed_chunk_size_gives_the_whole_body_result() {
        let (m, body) = sample();
        let want = whole(&m, body.as_bytes());
        for n in 1..=40 {
            assert_eq!(streamed(&m, body.as_bytes(), &[n]), want, "chunk size {n}");
        }
        // Uneven chunks.
        assert_eq!(streamed(&m, body.as_bytes(), &[1, 7, 2, 30, 3]), want);
    }

    #[test]
    fn a_stream_with_no_hit_loses_nothing_and_releases_early() {
        let m = Masker::new(&["secret-value-0123456789"]);
        let mut s = m.stream();
        let first = s.push(&[b'x'; 200]);
        // Only the longest-pattern tail is held back.
        assert!(first.len() >= 200 - m.max_len, "released {}", first.len());
        let mut all = first;
        all.extend(s.finish());
        assert_eq!(all, vec![b'x'; 200]);
    }

    #[test]
    fn a_region_touching_the_cut_waits_for_a_following_hit() {
        // "abc" then "abc" arriving separately must still be one region.
        let m = Masker::new(&["abc"]);
        let mut s = m.stream();
        let mut out = s.push(b"abc");
        out.extend(s.push(b"abc"));
        out.extend(s.finish());
        assert_eq!(out, MARKER.as_bytes());
    }

    #[test]
    fn a_stream_of_non_utf8_bytes_never_releases_part_of_a_hit() {
        // Stray continuation bytes after a hit must not pull the cut back into it.
        let m = Masker::new(&["abc-secret-123"]);
        let mut body = b"abc-secret-123".to_vec();
        body.extend([0x80, 0x80]);
        body.extend(vec![b'x'; m.max_len * 2]);
        // A hit that ends in a multibyte char, followed by a lone continuation byte.
        let mc = Masker::new(&["tok-é"]);
        let mut body2 = "tok-é".as_bytes().to_vec();
        body2.push(0x80);
        body2.extend(vec![b'x'; mc.max_len * 2]);
        for (m, body) in [(&m, &body), (&mc, &body2)] {
            let want = m.mask_bytes(body);
            assert!(want.starts_with(MARKER.as_bytes()));
            for n in 1..=body.len() {
                let got = stream_chunks(m, body, &[n]).concat();
                assert_eq!(got, want, "chunk size {n}");
                assert!(!m.contains_secret(&got));
            }
        }
    }

    #[test]
    fn a_hit_that_keeps_growing_is_not_held_back_whole() {
        // One char in a body of that char: every hit touches the next. The
        // buffer stays small and the output is one marker.
        for secret in ["aaaa", "a"] {
            let m = Masker::new(&[secret]);
            let body = vec![b'a'; 20_000];
            for tail in [&b""[..], &b"b"[..], &b"ab"[..]] {
                let mut input = body.clone();
                input.extend_from_slice(tail);
                let got = stream_chunks(&m, &input, &[37]).concat();
                assert_eq!(got, m.mask_bytes(&input), "secret {secret:?} tail {tail:?}");
            }
            let mut want = MARKER.as_bytes().to_vec();
            want.push(b'b');
            let mut input = body.clone();
            input.push(b'b');
            assert_eq!(m.mask_bytes(&input), want);
        }
    }

    #[test]
    fn random_chunkings_match_the_whole_body_including_non_utf8() {
        let m = Masker::new(&["aaaa", "abc-secret-123", "tok-é"]);
        let pieces: [&[u8]; 10] =
            [b"a", b"aaaa", b"abc-secret-123", b"abc", &[0x80], &[0xc3, 0xa9], b"x", b"-secret-123", "tok-é".as_bytes(), &[0xff]];
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move |n: usize| {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 33) as usize) % n
        };
        for _ in 0..400 {
            let mut body = Vec::new();
            for _ in 0..next(40) + 1 {
                body.extend_from_slice(pieces[next(pieces.len())]);
            }
            let sizes: Vec<usize> = (0..next(5) + 1).map(|_| next(9) + 1).collect();
            let got = stream_chunks(&m, &body, &sizes).concat();
            assert_eq!(got, m.mask_bytes(&body), "body {body:?} sizes {sizes:?}");
        }
    }

    #[test]
    fn percent_encodings_with_other_safe_sets_are_masked() {
        let canary = "pa!ss*w~rd/x:y@z-0123";
        let m = Masker::new(&[canary]);
        for form in [
            // encodeURIComponent, form encoding, Python quote with its default safe '/'.
            "pa!ss*w~rd%2Fx%3Ay%40z-0123",
            "pa%21ss*w%7Erd%2Fx%3Ay%40z-0123",
            "pa%21ss%2Aw~rd/x%3Ay%40z-0123",
            "pa%21ss%2aw~rd%2fx%3ay%40z-0123",
        ] {
            assert_eq!(m.mask_str(&format!("?k={form}&n=1")), format!("?k={MARKER}&n=1"), "{form}");
        }
    }

    #[test]
    fn base64_forms_are_masked_when_a_container_rewrites_their_characters() {
        let canary = "???-???-canary-value";
        let m = Masker::new(&[canary]);
        let b64 = STANDARD.encode(canary);
        assert!(b64.contains('/'), "fixture must carry a slash: {b64}");
        let basic = STANDARD.encode(format!("{canary}:"));
        for plain in [&b64, &basic] {
            for form in [
                pct(plain, false),
                pct(plain, true),
                plain.replace('/', "\\/"),
                plain.replace('/', "%2F").replace('+', "%2B").replace('=', "%3D"),
            ] {
                assert_eq!(m.mask_str(&format!("v={form};")), format!("v={MARKER};"), "{form}");
            }
        }
    }
}
