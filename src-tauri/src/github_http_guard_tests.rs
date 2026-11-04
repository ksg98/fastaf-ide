#[cfg(test)]
mod tests {
    // Catches: new runtime GitHub access bypasses account auth by spawning gh.
    #[test]
    fn production_code_spawns_no_gh() {
        use std::collections::BTreeMap;
        use std::path::Path;

        fn scan(dir: &Path, root: &Path, counts: &mut BTreeMap<String, usize>) {
            for entry in std::fs::read_dir(dir).expect("source directory exists") {
                let path = entry.expect("source entry is readable").path();
                if path.is_dir() {
                    scan(&path, root, counts);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    let source = std::fs::read_to_string(&path).expect("Rust source is readable");
                    let production = source.split("#[cfg(test)]\nmod tests").next().unwrap();
                    let count: usize = production
                        .lines()
                        .filter(|line| !line.trim_start().starts_with("//"))
                        .map(|line| {
                            ["resolve_cli(\"gh\")", "Command::new(\"gh\")", "gh_token::"]
                                .iter()
                                .map(|pattern| line.matches(pattern).count())
                                .sum::<usize>()
                        })
                        .sum();
                    if count != 0 {
                        let name = path
                            .strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        counts.insert(name, count);
                    }
                }
            }
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut actual = BTreeMap::new();
        scan(&root.join("src"), root, &mut actual);
        for entry in std::fs::read_dir(root.join("crates")).unwrap() {
            let src = entry.unwrap().path().join("src");
            if src.is_dir() {
                scan(&src, root, &mut actual);
            }
        }
        assert!(
            actual.is_empty(),
            "production code spawns gh; use the HTTP layer: {actual:?}"
        );
    }
}
