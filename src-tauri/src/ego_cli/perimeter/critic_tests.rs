use super::*;

// Catches: a profile inheriting user roots renders an empty draft, so saving it
// silently replaces the admitted inherited roots with workspace-only roots.
#[test]
fn inherited_profile_roots_must_not_render_as_empty_and_be_lost_on_save() {
    let stored = serde_json::from_str(include_str!(
        "../../../../src/__tests__/fixtures/ego-perimeter/stored-inherited-profile.json"
    ))
    .unwrap();
    let effective = serde_json::from_str(include_str!(
        "../../../../src/__tests__/fixtures/ego-perimeter/effective-inherited-profile.json"
    ))
    .unwrap();
    let view = project(stored, effective, Some("review".to_string())).unwrap();
    assert_eq!(
        view.roots.root_dir, "/Users/stefano.straus/Gits/.tmp/critic-1401/root",
        "inherited admitted root must appear in the editable form instead of an empty roots=[] draft"
    );
    assert_eq!(view.roots.root_access, RootAccess::Read);
}
