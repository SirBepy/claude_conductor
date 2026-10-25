//! Which browser a chat's `browser_*` tools drive: the daemon's own Chrome
//! profile, or one of Joe's real browsers reached through the Playwright
//! extension, which opens a connect page in that browser for him to approve.

use std::path::PathBuf;

use serde_json::Value;

use crate::types::Settings;

/// Settings keys (all in `Settings.extra`, so no struct change). They give
/// the browser a chat starts on and the app/profile "mine" falls back to; a
/// chat can override them with `browser_target`.
const MODE_KEY: &str = "claudeBrowserMode";
const APP_KEY: &str = "claudeBrowserMineApp";
const PROFILE_KEY: &str = "claudeBrowserMineProfile";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum App {
    Chrome,
    Edge,
    Brave,
}

impl App {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "chrome" => Some(App::Chrome),
            "edge" => Some(App::Edge),
            "brave" => Some(App::Brave),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            App::Chrome => "Chrome",
            App::Edge => "Edge",
            App::Brave => "Brave",
        }
    }
}

/// One of Joe's own browsers. `profile` is the profile directory name
/// ("Default", "Profile 1"); `None` lets the browser pick its last-used one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mine {
    pub app: App,
    pub profile: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Own,
    Mine(Mine),
}

/// What a `browser_target` call asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    /// No `target` given: report the chat's current browser, change nothing.
    Report,
    /// Drop the chat's own choice, back to what Settings says.
    Default,
    Set(Target),
}

impl Target {
    /// The browser a chat starts on.
    pub fn from_settings(settings: &Settings) -> Self {
        if settings.str_extra(MODE_KEY) == Some("mine") {
            Target::Mine(Mine::from_settings(settings))
        } else {
            Target::Own
        }
    }

    /// Plain words for a tool result.
    pub fn describe(&self) -> String {
        match self {
            Target::Own => "Claude's own Chrome profile, signed in only to accounts set up for Claude".to_string(),
            Target::Mine(mine) => {
                let profile = match &mine.profile {
                    Some(p) => format!("profile folder \"{p}\""),
                    None => "the profile he used last".to_string(),
                };
                format!("Joe's own {}, {profile}", mine.app.label())
            }
        }
    }

    /// Parses a `browser_target` call. `fallback` supplies the app and
    /// profile a "mine" request leaves out (Settings' values).
    pub fn parse_request(args: &Value, fallback: &Mine) -> Result<Request, String> {
        let Some(target) = args["target"].as_str() else {
            return Ok(Request::Report);
        };
        match target {
            "default" => Ok(Request::Default),
            "own" => Ok(Request::Set(Target::Own)),
            "mine" => {
                let app = match args["app"].as_str() {
                    Some(name) => App::parse(name).ok_or_else(|| format!("app must be chrome, edge or brave, not \"{name}\""))?,
                    None => fallback.app,
                };
                let profile = match args["profile"].as_str() {
                    Some(p) => Some(p.trim().to_string()).filter(|p| !p.is_empty()),
                    None => fallback.profile.clone(),
                };
                let mine = Mine { app, profile };
                // Refuse a bad profile name or a missing Brave now, not on the first page load.
                mine.playwright_args()?;
                Ok(Request::Set(Target::Mine(mine)))
            }
            other => Err(format!("target must be own, mine or default, not \"{other}\"")),
        }
    }
}

impl Mine {
    /// The app and profile Settings holds, whether or not it is the starting mode.
    pub fn from_settings(settings: &Settings) -> Self {
        let app = settings.str_extra(APP_KEY).and_then(App::parse).unwrap_or(App::Chrome);
        let profile = settings.str_extra(PROFILE_KEY).map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
        Mine { app, profile }
    }

    /// Playwright MCP flags that attach to this browser through its extension.
    pub fn playwright_args(&self) -> Result<Vec<String>, String> {
        self.playwright_args_with(|| brave_candidates().into_iter().find(|p| p.is_file()))
    }

    fn playwright_args_with(&self, find_brave: impl Fn() -> Option<PathBuf>) -> Result<Vec<String>, String> {
        let mut args = vec!["--extension".to_string()];
        match self.app {
            App::Chrome => args.extend(["--browser".to_string(), "chrome".to_string()]),
            App::Edge => args.extend(["--browser".to_string(), "msedge".to_string()]),
            // Playwright's channels only name Chrome and Edge; Brave is
            // Chromium, so its executable takes the same extension connect page.
            App::Brave => {
                let exe = find_brave().ok_or("Brave is not installed in a standard location")?;
                args.extend(["--executable-path".to_string(), exe.to_string_lossy().into_owned()]);
            }
        }
        if let Some(profile) = &self.profile {
            // Joined onto the browser's user-data dir by Playwright, and a
            // leading dash would be read as a flag.
            if profile.contains(['/', '\\']) || profile.starts_with('-') {
                return Err(format!("\"{profile}\" is not a browser profile folder name (try \"Default\" or \"Profile 1\")"));
            }
            args.extend(["--profile-dir-name".to_string(), profile.clone()]);
        }
        Ok(args)
    }
}

/// The Playwright extension's id; it is the same in every Chromium browser.
const EXTENSION_ID: &str = "mmlmfjhmonkocbjadbfplnigmagldckm";

/// Settings key (in `Settings.extra`, like the keys above) of an object mapping
/// "<app>/<profile folder>" to that profile's extension token. Every extension
/// install generates its own token, so one global env token only ever fits one
/// profile.
const TOKENS_KEY: &str = "claudeBrowserExtensionTokens";

/// Lookup key for a token: lowercase app name and the profile folder, which is
/// empty when the profile cannot be resolved.
pub fn token_key(app: App, profile: Option<&str>) -> String {
    format!("{}/{}", app.label().to_lowercase(), profile.unwrap_or(""))
}

/// The token stored for `app` and `profile`, else the one stored for the app
/// with a blank profile (what the settings page writes when no folder is named).
fn lookup_token(tokens: &serde_json::Map<String, Value>, app: App, profile: Option<&str>) -> Option<String> {
    [token_key(app, profile), token_key(app, None)]
        .iter()
        .filter_map(|k| tokens.get(k).and_then(Value::as_str))
        .map(|t| t.trim().to_string())
        .find(|t| !t.is_empty())
}

impl Mine {
    /// The extension token Settings holds for this browser profile, resolved
    /// the way the one-chat-per-profile guard resolves it.
    pub fn profile_token(&self, settings: &Settings) -> Option<String> {
        let tokens = settings.extra.get(TOKENS_KEY)?.as_object()?;
        lookup_token(tokens, self.app, self.resolved_profile().as_deref())
    }

    /// Appends the fix for a connect failure when no per-profile token exists:
    /// an unmatched token is the usual reason the connect page rejects a profile.
    pub fn with_token_hint(&self, err: String, has_token: bool) -> String {
        let lower = err.to_lowercase();
        if has_token || !["token", "extension", "connect", "timed out", "timeout"].iter().any(|w| lower.contains(w)) {
            return err;
        }
        format!(
            "{err} If the connect page in {} said \"Invalid token provided\" or never appeared, tell Joe with send_message to copy the token \
shown on the Playwright extension's connect page in that profile and paste it into Settings > Claude's browser > Extension token \
(profile folder \"{}\"); each profile's extension has its own token.",
            self.app.label(),
            self.resolved_profile().unwrap_or_default()
        )
    }
}

impl Mine {
    /// The profile folder this choice really drives: the named one, else the
    /// browser's last-used one, else `None` when neither can be read.
    pub fn resolved_profile(&self) -> Option<String> {
        self.profile.clone().or_else(|| user_data_dir(self.app).and_then(|d| last_used_profile(&d)))
    }

    /// Fails at once when the Playwright extension is not installed in this
    /// browser profile. Without it playwright-mcp waits for a connection that
    /// can never arrive (Brave hung 300s; Chrome fails fast on its own). An
    /// unresolvable profile directory never blocks: the child then behaves as
    /// it did before this check.
    pub fn check_extension_installed(&self) -> Result<(), String> {
        self.check_extension_in(user_data_dir(self.app))
    }

    fn check_extension_in(&self, user_data: Option<PathBuf>) -> Result<(), String> {
        let Some(user_data) = user_data.filter(|d| d.is_dir()) else { return Ok(()) };
        // No profile named means the browser's last-used one, recorded in Local State.
        let profile = match &self.profile {
            Some(p) => p.clone(),
            None => match last_used_profile(&user_data) {
                Some(p) => p,
                None => return Ok(()),
            },
        };
        let profile_dir = user_data.join(&profile);
        if !profile_dir.is_dir() || profile_dir.join("Extensions").join(EXTENSION_ID).is_dir() {
            return Ok(());
        }
        Err(format!(
            "The Playwright extension is not installed in {} (profile folder \"{profile}\"), so Joe's browser cannot be driven there. \
Tell Joe with send_message to install \"Playwright MCP Bridge\" (extension id {EXTENSION_ID}) from the Chrome Web Store in that profile, \
or use browser_target to switch to Claude's own browser.",
            self.app.label()
        ))
    }
}

fn last_used_profile(user_data: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(user_data.join("Local State")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v["profile"]["last_used"].as_str().map(str::to_string).filter(|p| !p.is_empty())
}

fn user_data_dir(app: App) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let base = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
        Some(match app {
            App::Chrome => base.join(r"Google\Chrome\User Data"),
            App::Edge => base.join(r"Microsoft\Edge\User Data"),
            App::Brave => base.join(r"BraveSoftware\Brave-Browser\User Data"),
        })
    }
    #[cfg(target_os = "macos")]
    {
        let base = PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support");
        Some(match app {
            App::Chrome => base.join("Google/Chrome"),
            App::Edge => base.join("Microsoft Edge"),
            App::Brave => base.join("BraveSoftware/Brave-Browser"),
        })
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let base = PathBuf::from(std::env::var_os("HOME")?).join(".config");
        Some(match app {
            App::Chrome => base.join("google-chrome"),
            App::Edge => base.join("microsoft-edge"),
            App::Brave => base.join("BraveSoftware/Brave-Browser"),
        })
    }
}

fn brave_candidates() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(|var| std::env::var_os(var))
            .map(|base| PathBuf::from(base).join(r"BraveSoftware\Brave-Browser\Application\brave.exe"))
            .collect()
    }
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")]
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        ["/usr/bin/brave-browser", "/usr/bin/brave", "/opt/brave.com/brave/brave-browser"].iter().map(PathBuf::from).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(pairs: &[(&str, &str)]) -> Settings {
        let mut s = Settings::default();
        for (k, v) in pairs {
            s.extra.insert((*k).to_string(), json!(v));
        }
        s
    }

    fn mine(app: App, profile: Option<&str>) -> Mine {
        Mine { app, profile: profile.map(str::to_string) }
    }

    #[test]
    fn default_settings_drive_the_daemons_own_browser() {
        assert_eq!(Target::from_settings(&Settings::default()), Target::Own);
        assert_eq!(Target::from_settings(&settings(&[("claudeBrowserMode", "own")])), Target::Own);
        assert_eq!(Target::from_settings(&settings(&[("claudeBrowserMode", "nonsense")])), Target::Own);
    }

    #[test]
    fn mine_reads_the_app_and_the_profile() {
        let s = settings(&[("claudeBrowserMode", "mine"), ("claudeBrowserMineApp", "brave"), ("claudeBrowserMineProfile", " Profile 2 ")]);
        assert_eq!(Target::from_settings(&s), Target::Mine(mine(App::Brave, Some("Profile 2"))));
        let bare = settings(&[("claudeBrowserMode", "mine")]);
        assert_eq!(Target::from_settings(&bare), Target::Mine(mine(App::Chrome, None)));
        let blank = settings(&[("claudeBrowserMode", "mine"), ("claudeBrowserMineApp", "edge"), ("claudeBrowserMineProfile", "  ")]);
        assert_eq!(Target::from_settings(&blank), Target::Mine(mine(App::Edge, None)));
    }

    #[test]
    fn chrome_and_edge_attach_through_their_playwright_channels() {
        let none = || None;
        assert_eq!(mine(App::Chrome, None).playwright_args_with(none).unwrap(), ["--extension", "--browser", "chrome"]);
        assert_eq!(
            mine(App::Edge, Some("Profile 1")).playwright_args_with(none).unwrap(),
            ["--extension", "--browser", "msedge", "--profile-dir-name", "Profile 1"]
        );
    }

    #[test]
    fn brave_attaches_through_its_executable() {
        let exe = PathBuf::from("/opt/brave/brave");
        let args = mine(App::Brave, None).playwright_args_with(|| Some(exe.clone())).unwrap();
        assert_eq!(args, ["--extension", "--executable-path", exe.to_str().unwrap()]);
        let err = mine(App::Brave, None).playwright_args_with(|| None).unwrap_err();
        assert!(err.contains("Brave is not installed"), "{err}");
    }

    fn user_data_with(profile: &str, extension: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let profile_dir = dir.path().join(profile);
        std::fs::create_dir_all(&profile_dir).unwrap();
        if extension {
            std::fs::create_dir_all(profile_dir.join("Extensions").join(EXTENSION_ID)).unwrap();
        }
        dir
    }

    #[test]
    fn a_profile_without_the_extension_fails_at_once() {
        let dir = user_data_with("Profile 1", false);
        let err = mine(App::Brave, Some("Profile 1")).check_extension_in(Some(dir.path().to_path_buf())).unwrap_err();
        assert!(err.contains("not installed") && err.contains("Brave") && err.contains("Profile 1"), "{err}");
    }

    #[test]
    fn a_profile_with_the_extension_passes() {
        let dir = user_data_with("Profile 1", true);
        assert!(mine(App::Brave, Some("Profile 1")).check_extension_in(Some(dir.path().to_path_buf())).is_ok());
    }

    #[test]
    fn an_unresolvable_profile_never_blocks() {
        let dir = user_data_with("Default", false);
        assert!(mine(App::Chrome, Some("Profile 9")).check_extension_in(Some(dir.path().to_path_buf())).is_ok(), "profile folder absent");
        assert!(mine(App::Chrome, Some("Default")).check_extension_in(None).is_ok(), "no user-data dir");
        assert!(mine(App::Chrome, None).check_extension_in(Some(dir.path().to_path_buf())).is_ok(), "no Local State");
    }

    #[test]
    fn no_profile_named_checks_the_last_used_one() {
        let dir = user_data_with("Profile 2", false);
        std::fs::write(dir.path().join("Local State"), r#"{"profile":{"last_used":"Profile 2"}}"#).unwrap();
        let err = mine(App::Edge, None).check_extension_in(Some(dir.path().to_path_buf())).unwrap_err();
        assert!(err.contains("Profile 2"), "{err}");
    }

    fn tokens(pairs: &[(&str, &str)]) -> serde_json::Map<String, Value> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect()
    }

    #[test]
    fn each_profile_gets_its_own_token() {
        let t = tokens(&[("brave/Default", "tok-a"), ("brave/Profile 1", " tok-b "), ("chrome/Default", "tok-c")]);
        assert_eq!(lookup_token(&t, App::Brave, Some("Default")).as_deref(), Some("tok-a"));
        assert_eq!(lookup_token(&t, App::Brave, Some("Profile 1")).as_deref(), Some("tok-b"));
        assert_eq!(lookup_token(&t, App::Chrome, Some("Default")).as_deref(), Some("tok-c"));
    }

    #[test]
    fn a_profile_without_a_token_falls_back() {
        let t = tokens(&[("brave/Default", "tok-a"), ("edge/", "tok-edge"), ("chrome/Default", "  ")]);
        assert_eq!(lookup_token(&t, App::Brave, Some("Profile 9")), None, "caller then uses the global token");
        assert_eq!(lookup_token(&t, App::Chrome, Some("Default")), None, "blank token is no token");
        assert_eq!(lookup_token(&t, App::Edge, Some("Profile 2")).as_deref(), Some("tok-edge"), "blank-profile entry covers the app");
        assert_eq!(lookup_token(&tokens(&[]), App::Brave, None), None);
    }

    #[test]
    fn profile_token_reads_settings_extra() {
        let mut s = Settings::default();
        s.extra.insert(TOKENS_KEY.to_string(), json!({"brave/Profile 1": "tok-b", "brave/Default": "tok-a"}));
        assert_eq!(mine(App::Brave, Some("Profile 1")).profile_token(&s).as_deref(), Some("tok-b"));
        assert_eq!(mine(App::Brave, Some("Default")).profile_token(&s).as_deref(), Some("tok-a"));
        assert_eq!(mine(App::Brave, Some("Profile 2")).profile_token(&s), None);
        assert_eq!(mine(App::Brave, Some("Default")).profile_token(&Settings::default()), None);
    }

    #[test]
    fn a_connect_failure_without_a_profile_token_says_where_to_paste_it() {
        let m = mine(App::Brave, Some("Profile 1"));
        let hinted = m.with_token_hint("Invalid token provided".to_string(), false);
        assert!(hinted.contains("Settings > Claude's browser > Extension token") && hinted.contains("Profile 1"), "{hinted}");
        assert_eq!(m.with_token_hint("Invalid token provided".to_string(), true), "Invalid token provided");
        assert_eq!(m.with_token_hint("page crashed".to_string(), false), "page crashed");
    }

    #[test]
    fn a_profile_that_is_a_path_or_a_flag_is_refused() {
        for bad in ["../Other", "a\\b", "-x"] {
            assert!(mine(App::Chrome, Some(bad)).playwright_args_with(|| None).is_err(), "{bad}");
        }
    }

    fn request(args: serde_json::Value, fallback: &Mine) -> Result<Request, String> {
        Target::parse_request(&args, fallback)
    }

    #[test]
    fn a_call_without_a_target_only_reports() {
        let fallback = mine(App::Chrome, None);
        assert_eq!(request(json!({}), &fallback), Ok(Request::Report));
        assert_eq!(request(json!({"target": "default"}), &fallback), Ok(Request::Default));
        assert_eq!(request(json!({"target": "own"}), &fallback), Ok(Request::Set(Target::Own)));
    }

    #[test]
    fn mine_takes_what_the_call_names_and_settings_fills_the_rest() {
        let fallback = mine(App::Edge, Some("Profile 3"));
        assert_eq!(request(json!({"target": "mine"}), &fallback), Ok(Request::Set(Target::Mine(fallback.clone()))));
        assert_eq!(
            request(json!({"target": "mine", "app": "chrome", "profile": " Profile 1 "}), &fallback),
            Ok(Request::Set(Target::Mine(mine(App::Chrome, Some("Profile 1")))))
        );
        // An empty profile means "the browser's last used", overriding Settings' folder.
        assert_eq!(
            request(json!({"target": "mine", "profile": ""}), &fallback),
            Ok(Request::Set(Target::Mine(mine(App::Edge, None))))
        );
    }

    #[test]
    fn a_bad_request_is_refused_with_a_reason() {
        let fallback = mine(App::Chrome, None);
        assert!(request(json!({"target": "elsewhere"}), &fallback).unwrap_err().contains("own, mine or default"));
        assert!(request(json!({"target": "mine", "app": "firefox"}), &fallback).unwrap_err().contains("chrome, edge or brave"));
        assert!(request(json!({"target": "mine", "profile": "../x"}), &fallback).unwrap_err().contains("not a browser profile"));
    }

    #[test]
    fn mine_from_settings_reads_app_and_profile_even_when_own_is_the_start() {
        let s = settings(&[("claudeBrowserMode", "own"), ("claudeBrowserMineApp", "edge"), ("claudeBrowserMineProfile", "Profile 4")]);
        assert_eq!(Mine::from_settings(&s), mine(App::Edge, Some("Profile 4")));
        assert_eq!(Target::from_settings(&s), Target::Own);
    }

    #[test]
    fn describe_names_whose_browser_it_is() {
        assert!(Target::Own.describe().contains("accounts set up for Claude"));
        assert_eq!(
            Target::Mine(mine(App::Brave, Some("Profile 1"))).describe(),
            "Joe's own Brave, profile folder \"Profile 1\""
        );
        assert_eq!(Target::Mine(mine(App::Chrome, None)).describe(), "Joe's own Chrome, the profile he used last");
    }
}
