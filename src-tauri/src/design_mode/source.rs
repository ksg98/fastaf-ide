use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceLoc {
    pub(crate) file: String,
    pub(crate) line: u32,
    pub(crate) column: u32,
}

pub(super) fn clean_file(file: &str) -> String {
    file.trim_start_matches("webpack-internal://")
        .trim_start_matches("turbopack://")
        .trim_start_matches("./")
        .to_owned()
}

fn direct_loc(value: &Value) -> Option<SourceLoc> {
    let file = value
        .get("fileName")
        .or_else(|| value.get("file"))?
        .as_str()?;
    let line = value
        .get("lineNumber")
        .or_else(|| value.get("line"))?
        .as_u64()?;
    let column = value
        .get("columnNumber")
        .or_else(|| value.get("column"))
        .and_then(Value::as_u64)
        .unwrap_or(1);
    Some(SourceLoc {
        file: clean_file(file),
        line: line.try_into().ok()?,
        column: column.try_into().ok()?,
    })
}

pub(crate) fn resolve(hints: &Value) -> Option<SourceLoc> {
    if let Some(location) = hints.get("reactSource").and_then(direct_loc) {
        return Some(location);
    }
    if let Some(location) = hints.get("svelteLoc").and_then(direct_loc) {
        return Some(location);
    }
    hints
        .get("vueFile")
        .and_then(Value::as_str)
        .map(|file| SourceLoc {
            file: clean_file(file),
            line: 0,
            column: 0,
        })
}
