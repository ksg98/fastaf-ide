use std::panic::catch_unwind;
use std::path::PathBuf;
use std::sync::mpsc::channel;

/// The drag image, compiled in.
///
/// `drag::Image` has no "no image" variant, so a path that does not resolve is
/// not a missing decoration — it is `ImageNotFound`, and the whole drag session
/// is refused. That made a cosmetic resource load-bearing: the frontend resolves
/// `icons/drag-file.png` through `resolveResource`, caches the answer for the
/// life of the window, and every drag out of the file browser died with
/// `drag error: drag image not found` the moment that file was not where the
/// bundle said it would be. Observed with a dev build whose `target/` was pruned
/// underneath the running process, but an installed app with a stripped or
/// relocated Resources directory fails identically.
///
/// Bytes in the binary cannot go missing. The resolved path is still preferred
/// when it exists — that is the packaged, possibly higher-DPI asset — and this is
/// the floor under it.
const FALLBACK_DRAG_ICON: &[u8] = include_bytes!("../icons/drag-file.png");

/// Prefer the resolved resource, fall back to the compiled-in bytes.
fn drag_image(icon: &str) -> drag::Image {
    let path = PathBuf::from(icon);
    if !icon.is_empty() && path.is_file() {
        drag::Image::File(path)
    } else {
        drag::Image::Raw(FALLBACK_DRAG_ICON.to_vec())
    }
}

#[tauri::command]
pub async fn start_native_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    paths: Vec<String>,
    icon: String,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let (tx, rx) = channel::<Result<(), String>>();

    let items: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let image = drag_image(&icon);

    app.run_on_main_thread(move || {
        let result = catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(target_os = "linux")]
            {
                let gtk_win = window
                    .gtk_window()
                    .map_err(|e| drag::Error::Io(std::io::Error::other(e.to_string())))?;
                drag::start_drag(
                    &gtk_win,
                    drag::DragItem::Files(items),
                    image,
                    |_result, _cursor_pos| {},
                    Default::default(),
                )
            }
            #[cfg(not(target_os = "linux"))]
            {
                drag::start_drag(
                    &window,
                    drag::DragItem::Files(items),
                    image,
                    |_result, _cursor_pos| {},
                    Default::default(),
                )
            }
        }));

        let mapped = match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("drag error: {e}")),
            Err(_) => Err("native drag session failed (NULL from macOS)".into()),
        };
        let _ = tx.send(mapped);
    })
    .map_err(|e| format!("run_on_main_thread: {e}"))?;

    rx.recv().map_err(|_| "drag channel closed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_icon_falls_back_to_the_compiled_in_bytes() {
        // The regression: an empty string (resolveResource threw) and a stale
        // cached path (the file was there when the window opened, and is not now)
        // both reached `Image::File` and killed the drag.
        assert!(matches!(drag_image(""), drag::Image::Raw(_)));
        assert!(matches!(
            drag_image("/nonexistent/drag-file.png"),
            drag::Image::Raw(_)
        ));
        // A directory is not an image either — `is_file` and not `exists`.
        assert!(matches!(drag_image("/tmp"), drag::Image::Raw(_)));
    }

    #[test]
    fn a_resolvable_icon_is_still_preferred() {
        let packaged = concat!(env!("CARGO_MANIFEST_DIR"), "/icons/drag-file.png");
        assert!(matches!(drag_image(packaged), drag::Image::File(_)));
    }

    #[test]
    fn the_compiled_in_icon_is_a_png() {
        assert_eq!(&FALLBACK_DRAG_ICON[..8], b"\x89PNG\r\n\x1a\n");
    }
}
