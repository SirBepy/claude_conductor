//! Which browser a chat's `browser_*` tools drive: the daemon's own Chrome
//! profile, or one of Joe's real browsers reached through the Playwright
//! extension, which opens a connect page in that browser for him to approve.

use std::path::PathBuf;

use crate::types::Settings;

/// Settings keys (all in `Settings.extra`, so no struct change).
const MODE_KEY: &str = "claudeBrowserMode";
const APP_KEY: &str = "claudeBrowserMineApp";
const PROFILE_KEY: &str = "claudeBrowserMineProfile";

/// Rides on the MCP child's `CC_BROWSER` env so the tool descriptions can say
/// whose browser the tools drive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Own,
    Mine,
}

impl Mode {
    pub fn env_value(self) -> &'static str {
        match self {
            Mode::Own => "1",
            Mode::Mine => "mine",
        }
    }

    pub fn from_env(value: &str) -> Self {
        if value == "mine" { Mode::Mine } else { Mode::Own }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum App {
    Chrome,
    Edge,
    Brave,
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

impl Target {
    pub fn from_settings(settings: &Settings) -> Self {
        if settings.str_extra(MODE_KEY) != Some("mine") {
            return Target::Own;
        }
        let app = match settings.str_extra(APP_KEY) {
            Some("edge") => App::Edge,
            Some("brave") => App::Brave,
            _ => App::Chrome,
        };
        let profile = settings.str_extra(PROFILE_KEY).map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
        Target::Mine(Mine { app, profile })
    }

    pub fn mode(&self) -> Mode {
        match self {
            Target::Own => Mode::Own,
            Target::Mine(_) => Mode::Mine,
        }
    }
}

impl Mine {
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

    #[test]
    fn a_profile_that_is_a_path_or_a_flag_is_refused() {
        for bad in ["../Other", "a\\b", "-x"] {
            assert!(mine(App::Chrome, Some(bad)).playwright_args_with(|| None).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_mode_round_trips_through_the_mcp_env() {
        assert_eq!(Mode::from_env(Mode::Own.env_value()), Mode::Own);
        assert_eq!(Mode::from_env(Mode::Mine.env_value()), Mode::Mine);
        assert_eq!(Target::Own.mode(), Mode::Own);
        assert_eq!(Target::Mine(mine(App::Chrome, None)).mode(), Mode::Mine);
    }
}
