// Keep the screenshot prerequisite separate from Chrome startup so failed probes
// can be verified without opening a browser or changing the console session.
export function lockProbeFailure(lock) {
  if (lock.error) return 'macOS lock probe failed: ' + lock.error.message;
  if (lock.status !== 0) return 'macOS lock probe failed with status ' + lock.status;
  // ioreg can omit CGSSessionScreenIsLocked on an unlocked console. The root
  // IOConsoleLocked property is an explicit state, not an absence-as-unlocked guess.
  const states = [...(lock.stdout ?? '').matchAll(/<key>(?:CGSSessionScreenIsLocked|IOConsoleLocked)<\/key>\s*<(true|false)\/>/g)];
  if (!states.length) return 'macOS lock probe returned no usable lock state';
  if (states.some(state => state[1] === 'true')) {
    return 'macOS screen is locked; unlock the display before screenshot or rAF checks';
  }
  return null;
}
