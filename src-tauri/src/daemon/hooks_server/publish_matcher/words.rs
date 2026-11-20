use super::*;

/// Stands in a word for a substitution whose output is unknown.
pub(super) const SUBSTITUTED: char = '\u{1}';

/// One shell word: its text, the byte offset in `text` where its first quote
/// opened, and whether it starts with an unquoted redirection operator (`>log`,
/// `2>&1`, `<in`, `<<EOF`).
#[derive(Clone)]
pub(super) struct Word {
    pub(super) text: String,
    pub(super) first_quote: Option<usize>,
    pub(super) op: bool,
}

/// Splits into command segments of words (quotes honored, backslashes literal so
/// Windows paths survive) plus the text of `$(..)` and backtick substitutions
/// found in double quotes or bare, which are commands of their own. The third
/// value says, per segment, whether a single `|` (or `|&`) feeds it.
// The final `end_segment!` resets state nothing reads again.
#[allow(unused_assignments)]
pub(super) fn split_segments(command: &str, ps: bool) -> (Vec<Vec<Word>>, Vec<String>, Vec<bool>) {
    let chars: Vec<char> = command.chars().collect();
    let mut segments: Vec<Vec<Word>> = vec![];
    let mut piped: Vec<bool> = vec![];
    let mut nested: Vec<String> = vec![];
    let mut cur: Vec<Word> = vec![];
    let mut word = String::new();
    let mut has_word = false;
    let mut first_quote: Option<usize> = None;
    let mut op = false;
    // Set by a `|`, consumed by the segment that follows it.
    let mut pending_pipe = false;
    let mut i = 0;
    macro_rules! end_word {
        () => {{
            if has_word {
                push_expanded(&mut cur, std::mem::take(&mut word), first_quote, op);
                has_word = false;
                first_quote = None;
                op = false;
            }
        }};
    }
    macro_rules! end_segment {
        () => {{
            end_word!();
            if !cur.is_empty() {
                segments.push(std::mem::take(&mut cur));
                piped.push(pending_pipe);
                pending_pipe = false;
            }
        }};
    }
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                has_word = true;
                first_quote.get_or_insert(word.len());
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
            }
            '"' => {
                has_word = true;
                first_quote.get_or_insert(word.len());
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if ps && chars[i] == '`' && i + 1 < chars.len() {
                        // PowerShell's escape character: the next char is literal text.
                        word.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    if !ps && chars[i] == '\\' && i + 1 < chars.len() && matches!(chars[i + 1], '"' | '\\' | '$' | '`') {
                        i += 1;
                    } else if chars[i] == '`' || (chars[i] == '$' && chars.get(i + 1) == Some(&'(')) {
                        let (inner, next) = substitution(&chars, i);
                        nested.push(inner);
                        i = next;
                        continue;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
            }
            // A comment runs to the end of the line; its apostrophes open no quote.
            '#' if !has_word => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            // Line continuation (`\` in sh, a backtick in PowerShell): the lines are one command.
            '\\' | '`' if (c == '`') == ps && matches!(chars.get(i + 1), Some('\n' | '\r')) => {
                end_word!();
                i += if chars.get(i + 1) == Some(&'\r') && chars.get(i + 2) == Some(&'\n') { 2 } else { 1 };
            }
            // sh: a backslash outside quotes makes the next char literal (`it\'s`).
            '\\' if !ps => {
                has_word = true;
                if let Some(&next) = chars.get(i + 1) {
                    word.push(next);
                    i += 1;
                }
            }
            '`' if ps => {
                // PowerShell's escape character, not a substitution.
                has_word = true;
                if let Some(&next) = chars.get(i + 1) {
                    word.push(next);
                    i += 1;
                }
            }
            // `${VAR}` is one argument, not three segments split at the braces.
            // `$'..'` (ANSI-C quoting: `$'\x67it'` is `git`) and `$".."`: the `$` is not part
            // of the word.
            '$' if !ps && chars.get(i + 1) == Some(&'\'') && quote_opens_ansi_c(&chars, i + 1) => {
                has_word = true;
                first_quote.get_or_insert(word.len());
                i += 2;
                while i < chars.len() && chars[i] != '\'' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        let (ch, used) = ansi_c_escape(&chars[i + 1..]);
                        word.push(ch);
                        i += 1 + used;
                    } else {
                        word.push(chars[i]);
                        i += 1;
                    }
                }
            }
            '$' if !ps && chars.get(i + 1) == Some(&'"') => {}
            // Unquoted `$IFS` and `${IFS}` split a word (`git${IFS}push`).
            '$' if !ps
                && (chars[i + 1..].starts_with(&['I', 'F', 'S']) && !chars.get(i + 4).is_some_and(|n| n.is_alphanumeric() || *n == '_')
                    || chars[i + 1..].starts_with(&['{', 'I', 'F', 'S', '}'])) =>
            {
                end_word!();
                i += if chars[i + 1] == '{' { 6 } else { 4 };
                continue;
            }
            '$' if chars.get(i + 1) == Some(&'{') => {
                let end = chars[i..].iter().position(|&c| c == '}').map_or(chars.len(), |p| i + p + 1);
                // A command inside (`${X:-$(git push)}`) still runs.
                nested.push(chars[i + 2..end.saturating_sub(1).max(i + 2)].iter().collect());
                has_word = true;
                word.push(SUBSTITUTED);
                i = end;
                continue;
            }
            '`' | '$' if c == '`' || chars.get(i + 1) == Some(&'(') => {
                let (inner, next) = substitution(&chars, i);
                nested.push(inner);
                // The substitution stands for part of ONE argument, glued to what is
                // around it: `git -C $(pwd) push` keeps `-C`'s value out of the
                // subcommand, and `FOO=$(pwd) git push` stays an assignment.
                has_word = true;
                word.push(SUBSTITUTED);
                i = next;
                continue;
            }
            // `||` is a list operator, `|` and `|&` a pipe: what comes out of the left
            // side is the right side's input.
            '|' => {
                end_segment!();
                if chars.get(i + 1) == Some(&'|') {
                    pending_pipe = false;
                    i += 1;
                } else {
                    pending_pipe = true;
                    if chars.get(i + 1) == Some(&'&') {
                        i += 1;
                    }
                }
            }
            // The `&` of `2>&1` / `<&3` belongs to the redirection, not a new command.
            '&' if i > 0 && matches!(chars[i - 1], '>' | '<') => {
                has_word = true;
                word.push(c);
            }
            // A redirection ends the word before it (`git push>log`); a digits-only word
            // is its file descriptor (`2>x`).
            '>' | '<' => {
                // `>>`, `<<<` and `>&` are one operator, not three words.
                let in_operator = op && word.chars().all(|d| d.is_ascii_digit() || matches!(d, '<' | '>' | '&'));
                if has_word && !in_operator && !word.chars().all(|d| d.is_ascii_digit()) {
                    end_word!();
                }
                if !has_word || word.chars().all(|d| d.is_ascii_digit()) {
                    op = true;
                }
                has_word = true;
                word.push(c);
            }
            '&' | ';' => {
                end_segment!();
                pending_pipe = false;
            }
            // A `{` or `}` standing alone is a command group; inside a word it is brace
            // expansion (`git {push,status}`) and `push_expanded` reads it.
            // In PowerShell they are script blocks and there is no brace expansion, so `{git push}`
            // and `try{ git push }` hold commands whatever stands beside them.
            '{' | '}' if ps => end_segment!(),
            '{' if !has_word && chars.get(i + 1).is_none_or(|n| n.is_whitespace()) => end_segment!(),
            '}' if !has_word => end_segment!(),
            '{' | '}' => {
                has_word = true;
                word.push(c);
            }
            '\n' | '\r' | '(' | ')' => end_segment!(),
            c if c.is_whitespace() => end_word!(),
            c => {
                has_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    end_segment!();
    (segments, nested, piped)
}

/// The character an ANSI-C escape (`$'\x67'`, `\147`, `g`, `\n`) stands for, given
/// the chars after the backslash, and how many of them it used.
pub(super) fn ansi_c_escape(after: &[char]) -> (char, usize) {
    let digits = |radix: u32, max: usize, skip: usize| {
        let n = after[skip..].iter().take(max).take_while(|c| c.is_digit(radix)).count();
        let value: String = after[skip..skip + n].iter().collect();
        (u32::from_str_radix(&value, radix).ok().and_then(char::from_u32), skip + n)
    };
    match after.first() {
        Some('x') => {
            let (c, used) = digits(16, 2, 1);
            c.map_or(('x', 1), |c| (c, used))
        }
        Some('u') => {
            let (c, used) = digits(16, 4, 1);
            c.map_or(('u', 1), |c| (c, used))
        }
        Some('0'..='7') => {
            let (c, used) = digits(8, 3, 0);
            c.map_or(('0', 1), |c| (c, used))
        }
        Some('n') => ('\n', 1),
        Some('t') => ('\t', 1),
        Some('e' | 'E') => ('\u{1b}', 1),
        Some(&c) => (c, 1),
        None => ('\\', 0),
    }
}

/// The words a brace expansion makes of `text` (`{push,status}`, `pu{s,}h`): one word per
/// alternative of the first group that has a top-level comma, expanded recursively. At
/// most 64 words; text with no such group is returned as it is.
pub(super) const EXPANSION_CAP: usize = 64;
/// The word that marks a brace expansion cut at `EXPANSION_CAP`; a segment holding it is refused.
pub(super) const EXPANSION_CAPPED: &str = "\u{1}brace-expansion-capped";

pub(super) fn expand_braces(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let Some(open) = chars.iter().position(|&c| c == '{') else { return vec![text.to_string()] };
    let (mut depth, mut close, mut commas) = (0usize, None, vec![]);
    for (k, &c) in chars.iter().enumerate().skip(open) {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(k);
                    break;
                }
            }
            ',' if depth == 1 => commas.push(k),
            _ => {}
        }
    }
    let Some(close) = close.filter(|_| !commas.is_empty()) else {
        // No expansion here: look for a later group after this brace.
        let head: String = chars[..=open].iter().collect();
        let tail: String = chars[open + 1..].iter().collect();
        return expand_braces(&tail).into_iter().map(|t| format!("{head}{t}")).collect();
    };
    let prefix: String = chars[..open].iter().collect();
    let suffix: String = chars[close + 1..].iter().collect();
    let mut bounds = vec![open];
    bounds.extend(commas);
    bounds.push(close);
    let mut out = vec![];
    for pair in bounds.windows(2) {
        if out.len() >= EXPANSION_CAP {
            break;
        }
        let alt: String = chars[pair[0] + 1..pair[1]].iter().collect();
        for e in expand_braces(&format!("{prefix}{alt}{suffix}")) {
            if out.len() < EXPANSION_CAP {
                out.push(e);
            }
        }
    }
    out
}

/// Pushes a finished word, as one word per brace-expansion alternative when the part before
/// its first quote holds a group (`git {push,status}` runs `git push status`).
pub(super) fn push_expanded(cur: &mut Vec<Word>, text: String, first_quote: Option<usize>, op: bool) {
    let cut = first_quote.unwrap_or(text.len());
    if op || !text[..cut].contains('{') {
        cur.push(Word { text, first_quote, op });
        return;
    }
    let (head, tail) = text.split_at(cut);
    let words = expand_braces(head);
    // A group past the word cap is cut short, so the words it dropped are unknown and may be
    // the publish verb (even one split across the group's edge): the segment is refused.
    let capped = words.len() >= EXPANSION_CAP;
    for e in words {
        let quote_at = first_quote.map(|_| e.len());
        cur.push(Word { text: format!("{e}{tail}"), first_quote: quote_at, op });
    }
    if capped {
        cur.push(Word { text: EXPANSION_CAPPED.to_string(), first_quote: None, op });
    }
}

/// The text of a `$(..)` or backtick substitution starting at `at`, and the index
/// just past it. An unterminated one runs to the end.
pub(super) fn substitution(chars: &[char], at: usize) -> (String, usize) {
    if chars[at] == '`' {
        let end = chars[at + 1..].iter().position(|&c| c == '`').map_or(chars.len(), |p| at + 1 + p);
        return (chars[at + 1..end].iter().collect(), (end + 1).min(chars.len()));
    }
    let mut depth = 0usize;
    let mut j = at + 1;
    while j < chars.len() {
        match chars[j] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return (chars[at + 2..j].iter().collect(), j + 1);
                }
            }
            _ => {}
        }
        j += 1;
    }
    (chars[(at + 2).min(chars.len())..].iter().collect(), chars.len())
}

/// The command name of a word: last path part, `.exe` dropped, lowercased.
pub(super) fn program_name(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

/// `NAME=value`. Only a quote inside the NAME makes the word a command name instead, so
/// a quoted VALUE (`GIT_SSH_COMMAND="ssh -i k" git push`) is still an assignment.
pub(super) fn is_assignment(word: &Word) -> bool {
    word.text.split_once('=').is_some_and(|(k, _)| {
        !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '_') && word.first_quote.is_none_or(|q| q > k.len())
    })
}

/// A wrapper's own argument `NAME=value`, quoted or not: `env "A=b" git push` sets A,
/// while the same word LEADING a command is a command name (`is_assignment`). `env`
/// takes any name, so `env A.B=1 git push` runs git.
pub(super) fn is_wrapper_assignment(word: &Word) -> bool {
    word.text.split_once('=').is_some_and(|(k, _)| !k.is_empty())
}

/// Drops redirections (`>log`, `2>&1`, `< in`, `<<EOF`) from a segment, so one can
/// neither stand in the command position (`>log git push`) nor sit between a command
/// and its subcommand (`git >log push`). A here-string's text (`<<< 'git push'`) is
/// returned apart, because a shell reads it as commands.
pub(super) fn strip_redirects(words: &[Word]) -> (Vec<Word>, Vec<String>) {
    let mut out = vec![];
    let mut here = vec![];
    let mut i = 0;
    while let Some(w) = words.get(i) {
        i += 1;
        if !w.op {
            out.push(w.clone());
            continue;
        }
        let body = w.text.trim_start_matches(|c: char| c.is_ascii_digit());
        let here_string = body.starts_with("<<<");
        let operand = if here_string { body.trim_start_matches('<') } else { body.trim_start_matches(['<', '>', '&', '|']) };
        // An operator on its own (`> log`) takes the next word as its target.
        let operand = if operand.is_empty() {
            let next = words.get(i).map(|n| n.text.as_str()).unwrap_or("");
            i += 1;
            next
        } else {
            operand
        };
        if here_string {
            here.push(operand.to_string());
        }
    }
    (out, here)
}
