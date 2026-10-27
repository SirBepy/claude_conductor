//! Which browser a chat's `browser_*` tools drive: the daemon's own Chrome
//! profile, or one of Joe's real browsers reached through the Claude
//! Conductor Browser Bridge extension (`bridge/`).

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
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "chrome" => Some(App::Chrome),
            "edge" => Some(App::Edge),
            "brave" => Some(App::Brave),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
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
                // The extension's hello carries no profile, so a requested folder
                // only steers which profile is launched, never which one answers.
                match &mine.profile {
                    Some(p) => format!(
                        "Joe's own {} (profile folder \"{p}\" was asked for; the bridge cannot verify which profile answers)",
                        mine.app.label()
                    ),
                    None => format!("Joe's own {}, the profile he used last", mine.app.label()),
                }
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
                // Refuse a bad profile name now, not on the first page load.
                mine.validate()?;
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

    /// Refuses a profile name the browser would read as a path or a flag.
    fn validate(&self) -> Result<(), String> {
        match &self.profile {
            Some(p) if p.contains(['/', '\\']) || p.starts_with('-') => {
                Err(format!("\"{p}\" is not a browser profile folder name (try \"Default\" or \"Profile 1\")"))
            }
            _ => Ok(()),
        }
    }

    /// Flags that start the browser (or wake a running one) on this profile
    /// without opening a window, so the bridge extension comes up and
    /// connects without anything landing on Joe's screen.
    fn launch_args(&self) -> Vec<String> {
        let mut args = vec!["--no-startup-window".to_string()];
        if let Some(p) = &self.profile {
            args.push(format!("--profile-directory={p}"));
        }
        args
    }

    /// Starts the browser detached from the daemon, so it outlives it.
    pub fn launch_in_background(&self) -> Result<(), String> {
        self.validate()?;
        let exe = exe_candidates(self.app).into_iter().find(|p| p.is_file()).ok_or_else(|| format!("{} is not installed in a standard location", self.app.label()))?;
        crate::daemon::spawn_self::spawn_detached(&exe, &self.launch_args()).map(|_| ()).map_err(|e| e.to_string())
    }
}

fn exe_candidates(app: App) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let rel = match app {
            App::Chrome => r"Google\Chrome\Application\chrome.exe",
            App::Edge => r"Microsoft\Edge\Application\msedge.exe",
            App::Brave => r"BraveSoftware\Brave-Browser\Application\brave.exe",
        };
        ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].iter().filter_map(|var| std::env::var_os(var)).map(|base| PathBuf::from(base).join(rel)).collect()
    }
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from(match app {
            App::Chrome => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            App::Edge => "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            App::Brave => "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        })]
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let names: &[&str] = match app {
            App::Chrome => &["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
            App::Edge => &["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
            App::Brave => &["/usr/bin/brave-browser", "/usr/bin/brave", "/opt/brave.com/brave/brave-browser"],
        };
        names.iter().map(PathBuf::from).collect()
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
    fn the_browser_starts_on_the_profile_without_a_window() {
        assert_eq!(mine(App::Chrome, None).launch_args(), ["--no-startup-window"]);
        assert_eq!(mine(App::Brave, Some("Profile 2")).launch_args(), ["--no-startup-window", "--profile-directory=Profile 2"]);
    }

    #[test]
    fn a_profile_that_is_a_path_or_a_flag_is_refused() {
        for bad in ["../Other", "a\\b", "-x"] {
            assert!(mine(App::Chrome, Some(bad)).validate().is_err(), "{bad}");
            assert!(mine(App::Chrome, Some(bad)).launch_in_background().is_err(), "{bad}");
        }
        assert!(mine(App::Chrome, Some("Profile 1")).validate().is_ok());
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
            "Joe's own Brave (profile folder \"Profile 1\" was asked for; the bridge cannot verify which profile answers)"
        );
        assert_eq!(Target::Mine(mine(App::Chrome, None)).describe(), "Joe's own Chrome, the profile he used last");
        let named = Target::Mine(mine(App::Edge, Some("Profile 3"))).describe();
        assert!(named.contains("cannot verify"), "{named}");
    }
}
