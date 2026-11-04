// Per-tab draft model. The service worker serialises mutations into storage.local.
export function addPick(draft, pick) {
  if (draft.picks.length >= 32) throw new Error('Send or delete picks before collecting more (32 maximum).');
  return {...draft, picks: [...draft.picks, {...pick, comment: ''}]};
}
export function editPick(draft, id, comment) {
  return {...draft, picks: draft.picks.map((pick) => pick.id === id ? {...pick, comment: comment.slice(0, 4096)} : pick)};
}
export function deletePick(draft, id) {
  return {...draft, picks: draft.picks.filter((pick) => pick.id !== id)};
}
export function draftForTab(drafts, tabId) {
  return drafts[String(tabId)] ?? {picks: []};
}

// Page errors: bounded to the last 50, deduplicated by message+source, fields re-validated.
const ERROR_KINDS = ['error', 'unhandledrejection', 'console.error', 'resource'];
const errorKey = (error) => `${error.message}\u0000${error.source}`;
const cut = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function addError(draft, raw, now = Date.now()) {
  const error = {kind: ERROR_KINDS.includes(raw?.kind) ? raw.kind : 'error', message: cut(raw?.message, 1024), source: cut(raw?.source, 512), line: count(raw?.line), column: count(raw?.column), stack: cut(raw?.stack, 2048), timestamp: now};
  const errors = draft.errors ?? [];
  if (errors.some((known) => errorKey(known) === errorKey(error))) return draft;
  return {...draft, errors: [...errors, error].slice(-50)};
}
export const clearErrors = (draft) => ({...draft, errors: []});
// The session that started Design Mode wins once per Start; a manual choice then holds until the next Start.
export function recipient(draft, agents, preferredSessionId) {
  const alive = (id) => agents.some((agent) => agent.sessionId === id);
  if (preferredSessionId && preferredSessionId !== draft.armedFor && alive(preferredSessionId)) {
    return {selectedSessionId: preferredSessionId, selectionInitialized: true, armedFor: preferredSessionId, agentNotice: ''};
  }
  const wanted = draft.selectionInitialized ? draft.selectedSessionId : preferredSessionId;
  if (wanted && alive(wanted)) return {selectedSessionId: wanted, selectionInitialized: true, agentNotice: ''};
  if (wanted) return {selectedSessionId: '', selectionInitialized: true, agentNotice: 'The selected agent exited. Choose another agent.'};
  if (draft.selectionInitialized) return {selectedSessionId: '', selectionInitialized: true, agentNotice: draft.agentNotice ?? ''};
  return {selectedSessionId: agents[0]?.sessionId ?? '', selectionInitialized: agents.length > 0, agentNotice: ''};
}

// Dev servers belong to the agent that Send will reach, never to the launching session.
export function serverSession(draft, agents, preferredSessionId) {
  return recipient(draft, agents, preferredSessionId).selectedSessionId;
}

// Persist this batch before requesting delivery; retry the exact batch after a lost reply.
export function prepareSend(draft, key, errorsOnly = false) {
  if (draft.pendingSend?.sessionId === draft.selectedSessionId) return draft;
  if (!draft.selectedSessionId) throw new Error('Choose an agent first.');
  const picks = errorsOnly ? [] : draft.picks.filter((pick) => pick.comment.trim());
  const errors = errorsOnly || draft.attachErrors ? draft.errors ?? [] : [];
  if (!picks.length && !errors.length) throw new Error(errorsOnly ? 'No page errors to send.' : 'Add a comment before sending.');
  return {...draft,pendingSend:{idempotencyKey:key,sessionId:draft.selectedSessionId,picks,errors}};
}
export function completeSend(draft) {
  const sent = new Map(draft.pendingSend.picks.map((pick) => [pick.id,pick.comment]));
  const sentErrors = new Set((draft.pendingSend.errors ?? []).map(errorKey));
  return {...draft,pendingSend:undefined,picks:draft.picks.filter((pick) => !sent.has(pick.id) || sent.get(pick.id) !== pick.comment),errors:(draft.errors ?? []).filter((error) => !sentErrors.has(errorKey(error)))};
}
export async function deliverDraft(draft, request, save, key, errorsOnly = false) {
  let pending=prepareSend(draft,key,errorsOnly);
  await save(pending);
  const result=await request(pending.pendingSend);
  if (!result.accepted) throw new Error('TUICommander did not accept feedback. Your picks are retained.');
  pending=completeSend(pending);await save(pending);
  return result;
}
