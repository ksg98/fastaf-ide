//! Argv consent policy. Templates are user-created and never model-created.
#[derive(Clone)]
pub(crate) struct Template(Vec<String>);

impl Template {
    pub(crate) fn new(argv: Vec<String>) -> Result<Self, String> {
        validate_argv(&argv)?;
        Ok(Self(argv))
    }

    pub(crate) fn matches(&self, argv: &[String]) -> bool {
        self.0 == argv
    }
}

pub(crate) fn validate_argv(argv: &[String]) -> Result<(), String> {
    let Some(program) = argv.first().filter(|p| !p.is_empty()) else {
        return Err("argv must include a program".into());
    };
    if argv.len() > 128 || argv.iter().any(|a| a.contains('\0') || a.len() > 8192) {
        return Err("Invalid argv".into());
    }
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    // Accepted risk (Boss, 2026-10-03): wrappers such as nohup env are not
    // recursively inspected; approved executables can already exfiltrate.
    if matches!(name, "env" | "printenv") {
        return Err("Environment dumpers are forbidden".into());
    }
    if name.ends_with(".bat") || name.ends_with(".cmd") {
        return Err("Implicit shell batch execution is forbidden".into());
    }
    if argv.iter().skip(1).any(|a| {
        let a = a.to_ascii_lowercase();
        a.starts_with("--eval")
            || a.starts_with("--command")
            || a.starts_with("-command")
            || a.starts_with("-encodedcommand")
            || a.starts_with("/c")
            || a.starts_with("/k")
            || (a.starts_with('-') && !a.starts_with("--") && a[1..].contains(['c', 'e', 'p']))
            || matches!(a.as_str(), "eval" | "-r")
    }) {
        return Err("Shell and interpreter command evaluation is forbidden".into());
    }
    Ok(())
}
