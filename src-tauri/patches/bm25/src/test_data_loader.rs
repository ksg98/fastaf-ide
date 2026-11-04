// TUICommander patch: `data/` and `snapshots/` are vendored from the upstream
// git repository (Michael-JB/bm25, tag v2.3.2), NOT from the published crate.
// `Cargo.toml` carries `exclude = ["/data/**", "/snapshots/**"]`, so the .crate
// this fork was imported from could never contain them, and the eight tests that
// read them — the two below plus the six `it_matches_snapshot_*` — failed with
// `NotFound` from the day of the import until 2026-09-13. Re-vendoring the fork
// from crates.io will silently delete them again; copy these two directories
// back from upstream git when that happens.
#[cfg(test)]
pub mod tests {
    use std::{fs::File, io::BufReader};

    use csv::Reader;

    #[derive(Clone)]
    pub struct Recipe {
        pub title: String,
        pub recipe: String,
    }

    pub fn read_recipes(recipe_file_name: &str) -> Vec<Recipe> {
        let file_path = format!("data/{}", recipe_file_name);
        let file = File::open(file_path).unwrap();
        let reader = BufReader::new(file);
        let mut csv_reader = Reader::from_reader(reader);

        csv_reader
            .records()
            .map(|r| r.unwrap())
            .map(|r| {
                let title = r.get(0).unwrap().to_string();
                let recipe = r.get(1).unwrap().to_string();
                Recipe { title, recipe }
            })
            .collect()
    }

    #[test]
    // The OS message differs per platform ("No such file or directory" against
    // "The system cannot find the file specified"); the error kind does not.
    #[should_panic(expected = "NotFound")]
    fn it_should_panic_if_the_file_does_not_exist() {
        read_recipes("non_existent_file.csv");
    }

    #[test]
    fn it_should_read_recipes_from_a_csv_file() {
        let recipes = read_recipes("recipes_en.csv");
        assert_eq!(recipes.len(), 50);
        assert_eq!(recipes[0].title, "French Toast");
    }
}
