use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Schema version for future migration support.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TunnelProfile {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates id for the current owner.","operations":["get"],"confirmationClass":"ordinary"}))]
    pub id: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates name for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub name: String,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates host for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub host: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates port for the current owner.","operations":["get","set"],"confirmationClass":"execution_authority"}))]
    pub port: u16,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates user for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub user: String,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates identity file for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub identity_file: Option<PathBuf>,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Replaces all forwards for the current tunnel profile.","operations":["get","set"],"confirmationClass":"execution_authority"}, "x-atomic-list" = true))]
    pub forwards: Vec<ForwardSpec>,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates options for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub options: ProfileOptions,
    #[serde(default)]
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates auto connect for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub auto_connect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type")]
pub enum ForwardSpec {
    Local {
        #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates bind port for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
        bind_port: u16,
        #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates remote host for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
        remote_host: String,
        #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates remote port for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
        remote_port: u16,
    },
    Remote {
        #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates bind port for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
        bind_port: u16,
        #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates local host for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
        local_host: String,
        #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates local port for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
        local_port: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProfileOptions {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates server alive interval for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub server_alive_interval: u16,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates server alive count max for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub server_alive_count_max: u16,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates strict host key checking for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub strict_host_key_checking: StrictHostKeyChecking,
    /// `ssh -C`. On by default, and the reason the WebSocket layer refuses to
    /// deflate a loopback peer: a tunnelled client reaches this machine through
    /// the local ssh process, so its address is loopback and its link is
    /// already compressed here. Turn it off for a link that is fast and a CPU
    /// that is not — a tunnel to another machine on the same LAN.
    #[serde(default = "compression_on")]
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates compression for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub compression: bool,
}

/// Serde's default for a profile written before this field existed. Matching
/// `ProfileOptions::default` so an old profile and a new one behave the same.
fn compression_on() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub enum StrictHostKeyChecking {
    Yes,
    AcceptNew,
}

impl TunnelProfile {
    pub fn new(name: impl Into<String>, host: impl Into<String>, user: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            host: host.into(),
            port: 22,
            user: user.into(),
            identity_file: None,
            forwards: Vec::new(),
            options: ProfileOptions::default(),
            auto_connect: false,
        }
    }

    pub fn validate(&mut self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.id).is_err() {
            return Err("id must be a valid UUID".to_string());
        }
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            return Err("name must not be empty".to_string());
        }
        self.host = self.host.trim().to_string();
        if self.host.is_empty() {
            return Err("host must not be empty".to_string());
        }
        self.user = self.user.trim().to_string();
        if self.user.is_empty() {
            return Err("user must not be empty".to_string());
        }
        if self.port == 0 {
            return Err("SSH port must be in range 1-65535".to_string());
        }
        for forward in &self.forwards {
            match forward {
                ForwardSpec::Local {
                    bind_port,
                    remote_port,
                    ..
                } => {
                    if *bind_port == 0 {
                        return Err("forward bind_port must be in range 1-65535".to_string());
                    }
                    if *remote_port == 0 {
                        return Err("forward remote_port must be in range 1-65535".to_string());
                    }
                }
                ForwardSpec::Remote {
                    bind_port,
                    local_port,
                    ..
                } => {
                    if *bind_port == 0 {
                        return Err("forward bind_port must be in range 1-65535".to_string());
                    }
                    if *local_port == 0 {
                        return Err("forward local_port must be in range 1-65535".to_string());
                    }
                }
            }
        }
        // Check for duplicate bind ports across all forwards
        let mut seen_bind_ports = std::collections::HashSet::new();
        for forward in &self.forwards {
            let bind_port = match forward {
                ForwardSpec::Local { bind_port, .. } | ForwardSpec::Remote { bind_port, .. } => {
                    *bind_port
                }
            };
            if !seen_bind_ports.insert(bind_port) {
                return Err(format!("duplicate bind_port {bind_port} across forwards"));
            }
        }
        Ok(())
    }
}

impl Default for ProfileOptions {
    fn default() -> Self {
        Self {
            server_alive_interval: 15,
            server_alive_count_max: 3,
            strict_host_key_checking: StrictHostKeyChecking::Yes,
            compression: compression_on(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_profile() -> TunnelProfile {
        TunnelProfile::new("my-tunnel", "example.com", "alice")
    }

    #[test]
    fn a_profile_written_before_compression_existed_still_compresses() {
        // Every profile already on disk lacks the key. Deserializing it to
        // `false` would silently stop compressing the tunnels Boss already has,
        // which is the opposite of what adding the option was for.
        let options: ProfileOptions = toml::from_str(
            r#"
            server_alive_interval = 15
            server_alive_count_max = 3
            strict_host_key_checking = "Yes"
            "#,
        )
        .expect("an old profile must still parse");

        assert!(options.compression);
    }

    #[test]
    fn toml_round_trip() {
        let mut profile = make_profile();
        profile.port = 2222;
        profile.identity_file = Some(PathBuf::from("/home/alice/.ssh/id_ed25519"));
        profile.forwards = vec![
            ForwardSpec::Local {
                bind_port: 8080,
                remote_host: "internal.example.com".to_string(),
                remote_port: 80,
            },
            ForwardSpec::Remote {
                bind_port: 9090,
                local_host: "127.0.0.1".to_string(),
                local_port: 9090,
            },
        ];

        let serialized = toml::to_string(&profile).expect("serialize");
        let deserialized: TunnelProfile = toml::from_str(&serialized).expect("deserialize");

        assert_eq!(deserialized.id, profile.id);
        assert_eq!(deserialized.name, profile.name);
        assert_eq!(deserialized.host, profile.host);
        assert_eq!(deserialized.port, profile.port);
        assert_eq!(deserialized.user, profile.user);
        assert_eq!(deserialized.identity_file, profile.identity_file);
        assert_eq!(deserialized.forwards.len(), 2);
        assert_eq!(
            deserialized.options.server_alive_interval,
            profile.options.server_alive_interval
        );
        assert_eq!(
            deserialized.options.server_alive_count_max,
            profile.options.server_alive_count_max
        );
    }

    #[test]
    fn validate_ssh_port_zero_rejected() {
        let mut profile = make_profile();
        profile.port = 0;
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_forward_bind_port_zero_rejected() {
        let mut profile = make_profile();
        profile.forwards = vec![ForwardSpec::Local {
            bind_port: 0,
            remote_host: "host".to_string(),
            remote_port: 80,
        }];
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_forward_remote_port_zero_rejected() {
        let mut profile = make_profile();
        profile.forwards = vec![ForwardSpec::Local {
            bind_port: 8080,
            remote_host: "host".to_string(),
            remote_port: 0,
        }];
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_duplicate_bind_ports_rejected() {
        let mut profile = make_profile();
        profile.forwards = vec![
            ForwardSpec::Local {
                bind_port: 8080,
                remote_host: "host".to_string(),
                remote_port: 80,
            },
            ForwardSpec::Remote {
                bind_port: 8080,
                local_host: "127.0.0.1".to_string(),
                local_port: 9000,
            },
        ];
        let err = profile.validate().unwrap_err();
        assert!(err.contains("duplicate bind_port"));
    }

    #[test]
    fn validate_empty_name_rejected() {
        let mut profile = make_profile();
        profile.name = String::new();
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_empty_host_rejected() {
        let mut profile = make_profile();
        profile.host = String::new();
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_empty_user_rejected() {
        let mut profile = make_profile();
        profile.user = String::new();
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_valid_profile_ok() {
        let mut profile = make_profile();
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn default_profile_options_values() {
        let opts = ProfileOptions::default();
        assert_eq!(opts.server_alive_interval, 15);
        assert_eq!(opts.server_alive_count_max, 3);
        assert!(matches!(
            opts.strict_host_key_checking,
            StrictHostKeyChecking::Yes
        ));
    }

    #[test]
    fn forward_local_serializes_with_type_tag() {
        let forward = ForwardSpec::Local {
            bind_port: 8080,
            remote_host: "host".to_string(),
            remote_port: 80,
        };
        let serialized = toml::to_string(&forward).expect("serialize");
        assert!(serialized.contains("type = \"Local\""));
        assert!(serialized.contains("bind_port"));
        assert!(serialized.contains("remote_host"));
        assert!(serialized.contains("remote_port"));
    }

    #[test]
    fn forward_remote_serializes_with_type_tag() {
        let forward = ForwardSpec::Remote {
            bind_port: 9090,
            local_host: "127.0.0.1".to_string(),
            local_port: 9090,
        };
        let serialized = toml::to_string(&forward).expect("serialize");
        assert!(serialized.contains("type = \"Remote\""));
        assert!(serialized.contains("bind_port"));
        assert!(serialized.contains("local_host"));
        assert!(serialized.contains("local_port"));
    }

    #[test]
    fn schema_version_is_one() {
        assert_eq!(SCHEMA_VERSION, 1);
    }

    #[test]
    fn validate_invalid_uuid_rejected() {
        let mut profile = make_profile();
        profile.id = "../../malicious".to_string();
        let err = profile.validate().unwrap_err();
        assert!(
            err.contains("valid UUID"),
            "expected UUID error, got: {err}"
        );
    }

    #[test]
    fn validate_whitespace_only_name_rejected() {
        let mut profile = make_profile();
        profile.name = "   ".to_string();
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_whitespace_only_host_rejected() {
        let mut profile = make_profile();
        profile.host = "   ".to_string();
        assert!(profile.validate().is_err());
    }

    #[test]
    fn validate_whitespace_only_user_rejected() {
        let mut profile = make_profile();
        profile.user = "   ".to_string();
        assert!(profile.validate().is_err());
    }
}
