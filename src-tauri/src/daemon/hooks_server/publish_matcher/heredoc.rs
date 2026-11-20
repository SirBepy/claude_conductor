use super::*;

/// How a heredoc body ends: its delimiter as a whole line, the same with leading
/// tabs allowed (`<<-`), or a PowerShell here-string's `'@` at line start. `expands`
/// is set when the shell substitutes `$(..)` and backticks in the body: an unquoted
/// delimiter (`<<EOF`) or a double-quoted here-string.
#[derive(Clone)]
pub(super) enum Terminator {
    Line { delim: String, expands: bool },
    TabbedLine { delim: String, expands: bool },
    HereStringEnd(String),
}

impl Terminator {
    pub(super) fn closes(&self, line: &str) -> bool {
        let line = line.trim_end_matches('\r');
        match self {
            Terminator::Line { delim, .. } => line == delim,
            Terminator::TabbedLine { delim, .. } => line.trim_start_matches('\t') == delim,
            Terminator::HereStringEnd(d) => line.starts_with(d.as_str()),
        }
    }

    pub(super) fn expands(&self) -> bool {
        match self {
            Terminator::Line { expands, .. } | Terminator::TabbedLine { expands, .. } => *expands,
            Terminator::HereStringEnd(d) => d.starts_with('"'),
        }
    }
}

/// The here-string a PowerShell line opens (`@'` or `@"` as its last characters).
pub(super) fn here_string_terminators(line: &str) -> Vec<Terminator> {
    let t = line.trim_end();
    if t.ends_with("@'") {
        vec![Terminator::HereStringEnd("'@".into())]
    } else if t.ends_with("@\"") {
        vec![Terminator::HereStringEnd("\"@".into())]
    } else {
        vec![]
    }
}

/// Whether the `'` at `q` opens a `$'..'` (ANSI-C) string. The `$` before it counts only
/// when it is not half of `$$` (the pid) and not escaped (`\$'..'` is a literal `$` and a
/// plain string): of the run of `$` before the quote, an escaped first one does not count,
/// and an odd count of the rest means the last `$` is the opener.
pub(super) fn quote_opens_ansi_c(chars: &[char], q: usize) -> bool {
    let dollars = chars[..q].iter().rev().take_while(|&&ch| ch == '$').count();
    let backslashes = chars[..q - dollars].iter().rev().take_while(|&&ch| ch == '\\').count();
    (dollars - usize::from(dollars > 0 && backslashes % 2 == 1)) % 2 == 1
}

/// One level of quoting while `heredoc_openers` scans: a double-quoted string (where
/// `$(` opens code again) or code, whose parentheses are counted so the `)` that
/// closes a `$(` is found.
pub(super) struct Level {
    pub(super) in_string: bool,
    pub(super) parens: usize,
}

/// The heredoc delimiters each line of an sh command opens, by line (`cat <<'EOF'`,
/// `<<-EOF`; not `<<<`, not `<<` inside quotes or `$((..))` arithmetic). The scan runs
/// over the whole text, so a quote spanning lines stays open and a body already read
/// is not scanned for more openers.
pub(super) fn heredoc_openers(command: &str) -> Vec<Vec<Terminator>> {
    let chars: Vec<char> = command.chars().collect();
    let lines: Vec<&str> = command.split('\n').collect();
    let mut out: Vec<Vec<Terminator>> = lines.iter().map(|_| vec![]).collect();
    let mut stack = vec![Level { in_string: false, parens: 0 }];
    let mut pending: Vec<Terminator> = vec![];
    let mut line = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        let top = stack.len() - 1;
        if c == '\n' {
            line += 1;
            i += 1;
            if !stack[top].in_string && !pending.is_empty() {
                // The bodies follow the line that opened them, one after another; the
                // scan resumes after the last delimiter line. A body that never ends
                // is not skipped.
                'bodies: for t in std::mem::take(&mut pending) {
                    match lines.get(line..).and_then(|rest| rest.iter().position(|l| t.closes(l))) {
                        Some(p) => {
                            i += lines[line..=line + p].iter().map(|l| l.chars().count() + 1).sum::<usize>();
                            line += p + 1;
                        }
                        None => break 'bodies,
                    }
                }
            }
            continue;
        }
        if stack[top].in_string {
            match c {
                '\\' => {
                    if chars.get(i + 1) == Some(&'\n') {
                        line += 1;
                    }
                    i += 1;
                }
                '"' => {
                    stack.pop();
                }
                '$' if chars.get(i + 1) == Some(&'(') => {
                    stack.push(Level { in_string: false, parens: 0 });
                    i += 1;
                }
                _ => {}
            }
            i += 1;
            continue;
        }
        match c {
            '\\' => {
                if chars.get(i + 1) == Some(&'\n') {
                    line += 1;
                }
                i += 1;
            }
            '\'' => {
                // `$'..'` (ANSI-C quoting) escapes its quote with a backslash; a plain
                // single-quoted string has no escapes and ends at the next quote.
                let ansi_c = quote_opens_ansi_c(&chars, i);
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    if chars[i] == '\n' {
                        line += 1;
                    }
                    if ansi_c && chars[i] == '\\' {
                        if chars.get(i + 1) == Some(&'\n') {
                            line += 1;
                        }
                        i += 1;
                    }
                    i += 1;
                }
            }
            '"' => stack.push(Level { in_string: true, parens: 0 }),
            // A comment runs to the end of the line; its apostrophes open no quote.
            '#' if i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], ';' | '&' | '|' | '(') => {
                while i + 1 < chars.len() && chars[i + 1] != '\n' {
                    i += 1;
                }
            }
            // `$((1 << 3))` is arithmetic, not a heredoc.
            '$' if chars.get(i + 1) == Some(&'(') && chars.get(i + 2) == Some(&'(') => {
                let end = (i + 3..chars.len().saturating_sub(1)).find(|&k| chars[k] == ')' && chars[k + 1] == ')').map_or(chars.len(), |k| k + 1);
                line += chars[i..end.min(chars.len())].iter().filter(|&&ch| ch == '\n').count();
                i = end;
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                stack.push(Level { in_string: false, parens: 0 });
                i += 1;
            }
            '(' => stack[top].parens += 1,
            ')' => {
                if stack[top].parens > 0 {
                    stack[top].parens -= 1;
                } else if stack.len() > 1 {
                    stack.pop();
                }
            }
            '<' if chars.get(i + 1) == Some(&'<') && (i == 0 || chars[i - 1] != '<') && chars.get(i + 2) != Some(&'<') => {
                let mut j = i + 2;
                let dash = chars.get(j) == Some(&'-');
                if dash {
                    j += 1;
                }
                while matches!(chars.get(j), Some(' ' | '\t')) {
                    j += 1;
                }
                let word_end = |from: usize| chars[from.min(chars.len())..].iter().position(|ch| ch.is_whitespace() || ";&|<>()".contains(*ch)).map_or(chars.len(), |p| from + p);
                // A quoted or backslashed delimiter makes the body literal text.
                let (delim, expands): (String, bool) = match chars.get(j) {
                    Some(&q) if q == '\'' || q == '"' => {
                        let body: String = chars[j + 1..].iter().take_while(|&&ch| ch != q).collect();
                        j += body.chars().count() + 2;
                        (body, false)
                    }
                    Some('\\') => {
                        let end = word_end(j + 1);
                        let word: String = chars[j + 1..end].iter().collect();
                        j = end;
                        (word, false)
                    }
                    _ => {
                        let end = word_end(j);
                        let word: String = chars[j.min(chars.len())..end].iter().collect();
                        j = end;
                        (word, true)
                    }
                };
                if !delim.is_empty() {
                    let t = if dash { Terminator::TabbedLine { delim, expands } } else { Terminator::Line { delim, expands } };
                    let slot = line.min(out.len() - 1);
                    out[slot].push(t.clone());
                    pending.push(t);
                }
                i = j.max(i + 2);
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// Whether a stage after a `|` on this line is a shell (`cat <<EOF | bash`), possibly
/// behind a wrapper (`| sudo bash`).
pub(super) fn line_pipes_into_shell(line: &str) -> bool {
    line.split('|').skip(1).any(|stage| {
        let words: Vec<&str> = stage.split_whitespace().collect();
        let mut i = 0;
        // The first word that is not a wrapper (with its flags and their values) is the program.
        while let Some(w) = words.get(i) {
            i += 1;
            let name = program_name(w);
            if *w == "&" {
                continue;
            }
            if !WRAPPERS.contains(&name.as_str()) {
                return SHELLS.contains(&name.as_str());
            }
            let values = wrapper_value_flags(&name);
            while let Some(x) = words.get(i) {
                if flag_consumes_next(values, x) {
                    i += 2;
                } else if x.starts_with('-') || x.contains('=') {
                    i += 1;
                } else {
                    break;
                }
            }
            if name == "timeout" && words.get(i).is_some_and(|w| w.starts_with(|c: char| c.is_ascii_digit())) {
                i += 1;
            }
        }
        false
    })
}

/// A heredoc body line as the inside of a double-quoted word: its own quotes become `'` and an
/// escape is kept only where it escapes `$`, a backtick or itself (everything in PowerShell),
/// so no line can close the quote early or, with a trailing backslash, swallow the text after.
pub(super) fn quotable_body(body: &str, ps: bool) -> String {
    let escape = if ps { '`' } else { '\\' };
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            out.push('\'');
        } else if c == escape {
            if let Some(&n) = chars.get(i + 1).filter(|n| ps || matches!(n, '$' | '`' | '\\')) {
                out.push(c);
                out.push(n);
                i += 1;
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// Drops heredoc and here-string bodies: they are text handed to a program, and
/// a commit message or doc that has a line starting with the words of a publish
/// command is not a command. A body whose terminator never appears is kept, so
/// a stray `<<` cannot hide the lines after it. A body the shell expands (an
/// unquoted delimiter) still runs its `$(..)` and backticks, so a line holding one
/// is kept as the text of a double-quoted word.
pub(super) fn strip_heredocs(command: &str, ps: bool) -> String {
    let lines: Vec<&str> = command.split('\n').collect();
    let mut openers = if ps { vec![] } else { heredoc_openers(command) };
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let at = i;
        let line = lines[i];
        i += 1;
        let mut kept = line;
        let mut expanded: Vec<String> = vec![];
        // A shell reads its heredoc as commands (`bash <<EOF`, `cat <<EOF | bash`),
        // so that body stays.
        let feeds_a_shell = line.split("<<").next().unwrap_or("").split_whitespace().any(|w| SHELLS.contains(&program_name(w).as_str()))
            || line_pipes_into_shell(line);
        if !feeds_a_shell {
            let terms = if ps { here_string_terminators(line) } else { openers.get_mut(at).map(std::mem::take).unwrap_or_default() };
            for term in terms {
                match lines.get(i..).and_then(|rest| rest.iter().position(|l| term.closes(l))) {
                    Some(p) => {
                        if term.expands() {
                            for body in &lines[i..i + p] {
                                if body.contains("$(") || (!ps && body.contains('`')) {
                                    expanded.push(format!("echo \"{}\"", quotable_body(body, ps)));
                                }
                            }
                        }
                        i += p + 1;
                        // A here-string's opener (`@'`) goes with its body, or the
                        // tokenizer reads its quote as unterminated and swallows the
                        // lines after it. Only when the body really ends.
                        let t = line.trim_end();
                        if ps {
                            kept = t.strip_suffix("@'").or_else(|| t.strip_suffix("@\"")).unwrap_or(line);
                        }
                    }
                    None => break,
                }
            }
        }
        out.push(kept.to_string());
        out.extend(expanded);
    }
    out.join("\n")
}
