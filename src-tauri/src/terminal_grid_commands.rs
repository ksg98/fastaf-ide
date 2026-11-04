/// Publish the terminal theme used to answer OSC 10/11/12 queries.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn set_terminal_theme_colors(
    foreground: [u8; 3],
    background: [u8; 3],
    cursor: [u8; 3],
) -> Result<(), String> {
    crate::terminal_grid::set_terminal_theme_colors(foreground, background, cursor)
}
