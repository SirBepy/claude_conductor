//! Where the engine gets a secret. The trait is what the engine sees; the
//! system implementation reads the protected broker store first and `.env`
//! second (`api_keys::resolve_secret`), and writes a rotated value back to the
//! place it was read from.

use crate::api_keys::{self, SecretOrigin};
use crate::util::secret_store::{native_backend, Backend, CommandRunner, SystemRunner};
use std::path::PathBuf;
use std::sync::Mutex;

pub trait SecretSource: Send + Sync {
    /// `Ok(None)` when no secret is stored under `name`. An `Err` never
    /// carries the value.
    fn get(&self, name: &str) -> Result<Option<String>, String>;

    /// Replaces `name` with a rotated value, in the place `get` found it.
    fn put(&self, name: &str, value: &str) -> Result<(), String>;

    /// Whether this machine can hold Hubstaff's rotating refresh token: it
    /// must live in a protected store that can be rewritten on every use.
    fn can_rotate(&self) -> bool;
}

/// The real store: `<data_dir>/broker-secrets.json`, then `~/.claude/.env`.
pub struct SystemSecrets {
    store_path: PathBuf,
    env_file: Option<PathBuf>,
    backend: Backend,
    runner: Box<dyn CommandRunner + Send + Sync>,
    /// Where each name was last read from, so `put` writes the same place.
    origins: Mutex<std::collections::HashMap<String, SecretOrigin>>,
}

impl SystemSecrets {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self::with_parts(
            api_keys::broker_store_path(data_dir),
            api_keys::env_path(),
            native_backend(),
            Box::new(SystemRunner),
        )
    }

    pub fn with_parts(
        store_path: PathBuf,
        env_file: Option<PathBuf>,
        backend: Backend,
        runner: Box<dyn CommandRunner + Send + Sync>,
    ) -> Self {
        Self { store_path, env_file, backend, runner, origins: Mutex::new(Default::default()) }
    }
}

impl SecretSource for SystemSecrets {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let found = api_keys::resolve_secret(&self.store_path, self.env_file.as_deref(), self.backend, &*self.runner, name)?;
        Ok(found.map(|(v, origin)| {
            self.origins.lock().unwrap().insert(name.to_string(), origin);
            v
        }))
    }

    fn put(&self, name: &str, value: &str) -> Result<(), String> {
        let origin = self.origins.lock().unwrap().get(name).copied().unwrap_or(SecretOrigin::BrokerStore);
        match origin {
            SecretOrigin::BrokerStore => {
                api_keys::set_broker_secret(&self.store_path, self.backend, &*self.runner, name, value)
            }
            SecretOrigin::EnvFile => {
                let path = self.env_file.as_deref().ok_or("no .env path to write the rotated value to")?;
                api_keys::set_key(path, name, value)
            }
        }
    }

    fn can_rotate(&self) -> bool {
        // PC only: the value is rewritten on every refresh, and a Keychain
        // round trip per refresh is the case the plan rules out (a rotating
        // token is never copied between machines).
        self.backend == Backend::Dpapi
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::collections::HashMap;

    /// In-memory store for engine tests. Records every `put`.
    #[derive(Default)]
    pub struct MemSecrets {
        pub map: Mutex<HashMap<String, String>>,
        pub puts: Mutex<Vec<(String, String)>>,
        /// Names `get` was asked for, so a test can prove a denied call read nothing.
        pub reads: Mutex<Vec<String>>,
        pub rotate: bool,
        pub fail_put: bool,
    }

    impl MemSecrets {
        pub fn with(pairs: &[(&str, &str)]) -> Self {
            Self {
                map: Mutex::new(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
                rotate: true,
                ..Default::default()
            }
        }
    }

    impl SecretSource for MemSecrets {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            self.reads.lock().unwrap().push(name.to_string());
            Ok(self.map.lock().unwrap().get(name).cloned())
        }
        fn put(&self, name: &str, value: &str) -> Result<(), String> {
            if self.fail_put {
                return Err("disk full".into());
            }
            self.puts.lock().unwrap().push((name.to_string(), value.to_string()));
            self.map.lock().unwrap().insert(name.to_string(), value.to_string());
            Ok(())
        }
        fn can_rotate(&self) -> bool {
            self.rotate
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoRunner;
    impl CommandRunner for NoRunner {
        fn run(&self, _: &str, _: &[&str], _: &str) -> anyhow::Result<(bool, String)> {
            Err(anyhow::anyhow!("no keychain in tests"))
        }
    }

    #[test]
    fn a_value_read_from_env_is_rotated_back_into_env_and_a_missing_one_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let env = dir.path().join(".env");
        std::fs::write(&env, "HUBSTAFF_REFRESH_TOKEN=canary-rt-1\nOTHER=1\n").unwrap();
        let s = SystemSecrets::with_parts(dir.path().join("broker-secrets.json"), Some(env.clone()), Backend::Dpapi, Box::new(NoRunner));
        assert_eq!(s.get("HUBSTAFF_REFRESH_TOKEN").unwrap().as_deref(), Some("canary-rt-1"));
        assert_eq!(s.get("FIGMA_TOKEN").unwrap(), None);
        s.put("HUBSTAFF_REFRESH_TOKEN", "canary-rt-2").unwrap();
        assert_eq!(std::fs::read_to_string(&env).unwrap(), "HUBSTAFF_REFRESH_TOKEN=canary-rt-2\nOTHER=1\n");
        assert!(!dir.path().join("broker-secrets.json").exists(), "a rotation must not create a store the value was never in");
    }

    #[test]
    fn can_rotate_only_on_dpapi() {
        let mk = |b| SystemSecrets::with_parts(PathBuf::from("x.json"), None, b, Box::new(NoRunner));
        assert!(mk(Backend::Dpapi).can_rotate());
        assert!(!mk(Backend::Keychain).can_rotate());
        assert!(!mk(Backend::Unavailable).can_rotate());
    }
}
