//! Server configuration: env vars + optional `config.toml`, env wins.
//!
//! [`Settings::from_env`] is the single constructor called at boot. Resolution
//! precedence per field: `TALETREK_*` env var > `config.toml` value > built-in
//! default. The bearer token is required (single-user model, ADR-0013) — boot
//! fails with [`ConfigError::MissingToken`] when no source provides it.
//!
//! # Testability
//!
//! The env-reading and the resolution logic are split: [`Settings::from_env`]
//! reads the real process env, then delegates to [`Settings::resolve`] which
//! takes an env getter closure. Unit tests drive `resolve` with stub getters so
//! they never mutate (or depend on) the real process env and can run in
//! parallel.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::thread::available_parallelism;

use serde::Deserialize;

use taletrek_worker::default_cache_dir;

/// Env var: path to an optional `config.toml` override file (`TALETREK_CONFIG`).
const ENV_CONFIG: &str = "TALETREK_CONFIG";
/// Env var: on-disk library + SQLite root (`TALETREK_DATA_DIR`, default `./data`).
const ENV_DATA_DIR: &str = "TALETREK_DATA_DIR";
/// Env var: bind address (`TALETREK_BIND`, default `0.0.0.0:7878`).
const ENV_BIND: &str = "TALETREK_BIND";
/// Env var: single-user bearer token (`TALETREK_TOKEN`, required).
const ENV_TOKEN: &str = "TALETREK_TOKEN";
/// Env var: Piper voice-model cache dir (`TALETREK_VOICES_CACHE_DIR`).
const ENV_VOICES_CACHE_DIR: &str = "TALETREK_VOICES_CACHE_DIR";
/// Env var: parallel synth worker count (`TALETREK_JOBS`).
const ENV_JOBS: &str = "TALETREK_JOBS";
/// Env var: `piper` binary name/path (`TALETREK_PIPER`).
const ENV_PIPER: &str = "TALETREK_PIPER";
/// Env var: `ffmpeg` binary name/path (`TALETREK_FFMPEG`).
const ENV_FFMPEG: &str = "TALETREK_FFMPEG";

/// Resolved server settings.
///
/// Built once by [`Settings::from_env`] at boot; fields are final (no builder).
/// Fields beyond `data_dir`/`bind`/`token` are consumed by later tasks (db,
/// store, synth runner) but are loaded here so configuration is resolved in a
/// single place.
#[derive(Debug, Clone)]
pub struct Settings {
    /// On-disk root for `library/<book-id>/bundle.taletrek` + `taletrek.db`.
    pub data_dir: PathBuf,
    /// TCP bind address for the axum listener.
    pub bind: SocketAddr,
    /// Single-user bearer auth token (ADR-0013). Never logged.
    ///
    /// GOTCHA: the bearer token is the *only* auth surface (ADR-0013 single-user
    /// model). There are no users, no ACLs. Operate only over a trusted LAN or
    /// behind a TLS terminator.
    pub token: String,
    /// Piper voice-model cache dir (models land here on first download).
    pub voices_cache_dir: PathBuf,
    /// Parallel synth worker count (default = available parallelism).
    pub jobs: usize,
    /// `piper` binary name or absolute path (default `"piper"`).
    pub piper: String,
    /// `ffmpeg` binary name or absolute path (default `"ffmpeg"`).
    pub ffmpeg: String,
}

/// Errors surfaced while resolving [`Settings`]. Each carries enough context
/// for `main` to print an actionable message through `anyhow`.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The required bearer token was in neither env nor config.toml.
    #[error(
        "{ENV_TOKEN} is required (single-user bearer auth — ADR-0013). \
         Set the {ENV_TOKEN} env var or a `token` key in config.toml."
    )]
    MissingToken,

    /// `TALETREK_BIND` (or config `bind`) did not parse as a socket address.
    #[error("invalid bind address {0:?}: {1}")]
    InvalidBind(String, #[source] std::net::AddrParseError),

    /// `TALETREK_JOBS` was not a positive integer.
    #[error("invalid jobs count {0:?}: {1}")]
    InvalidJobs(String, #[source] std::num::ParseIntError),

    /// The `TALETREK_CONFIG` file could not be read from disk.
    #[error("reading config file {0}: {1}")]
    ConfigFileRead(PathBuf, #[source] std::io::Error),

    /// The `TALETREK_CONFIG` file was not valid TOML or did not match the schema.
    #[error("parsing config file {0}: {1}")]
    ConfigFileParse(PathBuf, #[source] toml::de::Error),
}

/// The optional `config.toml` shape — every field optional; env overlays on top.
#[derive(Debug, Default, Clone, Deserialize)]
struct ConfigFile {
    /// Mirrors `TALETREK_DATA_DIR`.
    data_dir: Option<String>,
    /// Mirrors `TALETREK_BIND`.
    bind: Option<String>,
    /// Mirrors `TALETREK_TOKEN`.
    token: Option<String>,
    /// Mirrors `TALETREK_VOICES_CACHE_DIR`.
    voices_cache_dir: Option<String>,
    /// Mirrors `TALETREK_JOBS`.
    jobs: Option<usize>,
    /// Mirrors `TALETREK_PIPER`.
    piper: Option<String>,
    /// Mirrors `TALETREK_FFMPEG`.
    ffmpeg: Option<String>,
}

impl Settings {
    /// Resolve settings from the process env + optional `TALETREK_CONFIG` file.
    ///
    /// Precedence (highest wins): env var > `config.toml` value > built-in
    /// default. The token is required — [`ConfigError::MissingToken`] is
    /// returned when no source provides it.
    pub fn from_env() -> Result<Self, ConfigError> {
        let config = std::env::var(ENV_CONFIG)
            .ok()
            .map(PathBuf::from)
            .map(read_config_file)
            .transpose()?;
        Self::resolve(&|key: &str| std::env::var(key).ok(), config.as_ref())
    }

    /// The testable core: resolve from an env getter + optional config file.
    ///
    /// For each field the env getter is checked first, then the config file,
    /// then the built-in default. `env` is `&dyn Fn(&str) -> Option<String>`
    /// so tests pass a stub getter instead of mutating the real process env.
    fn resolve(
        env: &dyn Fn(&str) -> Option<String>,
        config: Option<&ConfigFile>,
    ) -> Result<Self, ConfigError> {
        let cfg = config.cloned().unwrap_or_default();

        let data_dir = env(ENV_DATA_DIR)
            .or(cfg.data_dir)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("./data"));

        let bind = match env(ENV_BIND).or(cfg.bind) {
            Some(raw) => raw.parse().map_err(|e| ConfigError::InvalidBind(raw, e))?,
            None => default_bind(),
        };

        let token = env(ENV_TOKEN)
            .or(cfg.token)
            .ok_or(ConfigError::MissingToken)?;

        let voices_cache_dir = env(ENV_VOICES_CACHE_DIR)
            .or(cfg.voices_cache_dir)
            .map(PathBuf::from)
            .unwrap_or_else(|| default_voices_cache_dir(&data_dir));

        let jobs = match env(ENV_JOBS) {
            Some(raw) => raw.parse().map_err(|e| ConfigError::InvalidJobs(raw, e))?,
            None => cfg.jobs.unwrap_or_else(default_jobs),
        };

        let piper = env(ENV_PIPER)
            .or(cfg.piper)
            .unwrap_or_else(|| "piper".to_string());
        let ffmpeg = env(ENV_FFMPEG)
            .or(cfg.ffmpeg)
            .unwrap_or_else(|| "ffmpeg".to_string());

        Ok(Self {
            data_dir,
            bind,
            token,
            voices_cache_dir,
            jobs,
            piper,
            ffmpeg,
        })
    }
}

/// Default bind address: all interfaces, port 7878.
fn default_bind() -> SocketAddr {
    SocketAddr::from(([0, 0, 0, 0], 7878))
}

/// Default voice cache dir: the platform cache dir (XDG on Linux) when
/// discoverable, otherwise `<data_dir>/voices` (the Docker fallback when
/// `$HOME` is unset).
fn default_voices_cache_dir(data_dir: &std::path::Path) -> PathBuf {
    default_cache_dir().unwrap_or_else(|| data_dir.join("voices"))
}

/// Default job count: available parallel workers, falling back to 1 when the
/// platform can't report it. Equivalent to the `num_cpus` crate without the dep.
fn default_jobs() -> usize {
    available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// Read + parse a `config.toml` file into [`ConfigFile`].
fn read_config_file(path: PathBuf) -> Result<ConfigFile, ConfigError> {
    let body =
        std::fs::read_to_string(&path).map_err(|e| ConfigError::ConfigFileRead(path.clone(), e))?;
    toml::from_str(&body).map_err(|e| ConfigError::ConfigFileParse(path, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_token_is_a_clear_error() {
        let err = Settings::resolve(&|_| None, None).unwrap_err();
        assert!(matches!(err, ConfigError::MissingToken));
        // The message names the env var + ADR so it's actionable.
        assert!(err.to_string().contains(ENV_TOKEN));
        assert!(err.to_string().contains("ADR-0013"));
    }

    #[test]
    fn env_overrides_defaults() {
        let s = Settings::resolve(
            &|k: &str| match k {
                ENV_TOKEN => Some("sekrit".into()),
                ENV_BIND => Some("127.0.0.1:9999".into()),
                ENV_DATA_DIR => Some("/tmp/tt-data".into()),
                ENV_JOBS => Some("7".into()),
                _ => None,
            },
            None,
        )
        .unwrap();
        assert_eq!(s.token, "sekrit");
        assert_eq!(s.bind, "127.0.0.1:9999".parse::<SocketAddr>().unwrap());
        assert_eq!(s.data_dir, PathBuf::from("/tmp/tt-data"));
        assert_eq!(s.jobs, 7);
        // Unspecified fields keep their defaults.
        assert_eq!(s.piper, "piper");
        assert_eq!(s.ffmpeg, "ffmpeg");
    }

    #[test]
    fn defaults_when_only_token_set() {
        let s = Settings::resolve(
            &|k: &str| match k {
                ENV_TOKEN => Some("t".into()),
                _ => None,
            },
            None,
        )
        .unwrap();
        assert_eq!(s.token, "t");
        assert_eq!(s.bind, default_bind());
        assert_eq!(s.data_dir, PathBuf::from("./data"));
        assert_eq!(s.piper, "piper");
        assert_eq!(s.ffmpeg, "ffmpeg");
        assert!(s.jobs >= 1);
    }

    #[test]
    fn env_wins_over_config_file() {
        let cfg = ConfigFile {
            token: Some("from-file".into()),
            bind: Some("0.0.0.0:3000".into()),
            ..Default::default()
        };
        let s = Settings::resolve(
            &|k: &str| match k {
                ENV_TOKEN => Some("from-env".into()),
                _ => None,
            },
            Some(&cfg),
        )
        .unwrap();
        // Env overrides config for token.
        assert_eq!(s.token, "from-env");
        // Config supplies bind (no env override for it).
        assert_eq!(s.bind, "0.0.0.0:3000".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn config_file_supplies_defaults() {
        let cfg = ConfigFile {
            token: Some("from-file".into()),
            piper: Some("/usr/local/bin/piper".into()),
            jobs: Some(3),
            ..Default::default()
        };
        let s = Settings::resolve(&|_| None, Some(&cfg)).unwrap();
        assert_eq!(s.token, "from-file");
        assert_eq!(s.piper, "/usr/local/bin/piper");
        assert_eq!(s.jobs, 3);
        // Untouched fields fall back to built-in defaults.
        assert_eq!(s.bind, default_bind());
        assert_eq!(s.ffmpeg, "ffmpeg");
    }

    #[test]
    fn invalid_bind_surfaces_error() {
        let err = Settings::resolve(
            &|k: &str| match k {
                ENV_TOKEN => Some("t".into()),
                ENV_BIND => Some("not-an-addr".into()),
                _ => None,
            },
            None,
        )
        .unwrap_err();
        assert!(matches!(err, ConfigError::InvalidBind(..)));
        assert!(err.to_string().contains("not-an-addr"));
    }

    #[test]
    fn invalid_jobs_surfaces_error() {
        let err = Settings::resolve(
            &|k: &str| match k {
                ENV_TOKEN => Some("t".into()),
                ENV_JOBS => Some("not-a-number".into()),
                _ => None,
            },
            None,
        )
        .unwrap_err();
        assert!(matches!(err, ConfigError::InvalidJobs(..)));
    }

    #[test]
    fn parse_config_file_round_trip() {
        let toml_src = r#"
token = "abc"
bind = "127.0.0.1:8080"
data_dir = "/var/lib/taletrek"
jobs = 4
piper = "/opt/piper/piper"
ffmpeg = "ffmpeg"
voices_cache_dir = "/var/cache/taletrek/voices"
"#;
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), toml_src).unwrap();
        let parsed = read_config_file(tmp.path().to_path_buf()).unwrap();
        assert_eq!(parsed.token.as_deref(), Some("abc"));
        assert_eq!(parsed.bind.as_deref(), Some("127.0.0.1:8080"));
        assert_eq!(parsed.jobs, Some(4));
        assert_eq!(parsed.piper.as_deref(), Some("/opt/piper/piper"));
    }
}
