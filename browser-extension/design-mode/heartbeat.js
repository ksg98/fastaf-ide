export const HEARTBEAT_MS = 5000;
// Persist the acknowledged sequences across MV3 worker restarts.
async function reviewedTabId(tabs, saved, reviewedTab) {
  return reviewedTab ?? saved ?? (await tabs.query({active: true, lastFocusedWindow: true}))[0]?.id;
}
// Applies one sequenced request once. A backend restart restarts the counter below
// the saved acknowledgement: rebase, no action.
async function once(storage, key, seq, act) {
  const acknowledged = (await storage.get(key))[key] ?? 0;
  if (!Number.isSafeInteger(seq)) return;
  if (seq < acknowledged) await storage.set({[key]: seq});
  if (seq <= acknowledged) return;
  if (!(await act())) return;
  await storage.set({[key]: seq});
}
export async function heartbeatReply(reply, storage, tabs, reviewedTab) {
  if (!reply.armed) return;
  const tab = async () => reviewedTabId(tabs, (await storage.get('reviewedTab')).reviewedTab, reviewedTab);
  await once(storage, 'reloadSeq', reply.reloadSeq, async () => {
    const id = await tab();
    if (!id) return false;
    await tabs.reload(id);
    return true;
  });
  const {seq = 0, url} = reply.navigate ?? {};
  if (!Number.isSafeInteger(seq) || seq < 0) return;
  const saved = await storage.get(['navigateSeq', 'backendId']);
  // A backend identity distinguishes equal counters when a command precedes the first idle beat.
  const restarted = typeof reply.backendId === 'string' && reply.backendId !== saved.backendId;
  if (restarted || seq < (saved.navigateSeq ?? 0)) {
    await storage.set({navigateSeq: 0, ...(typeof reply.backendId === 'string' ? {backendId: reply.backendId} : {})});
  }
  if (typeof url !== 'string') {
    await storage.set({navigateSeq: seq});
    return;
  }
  await once(storage, 'navigateSeq', seq, async () => {
    const id = await tab();
    if (!id) return false;
    await tabs.update(id, {url});
    return true;
  });
}
