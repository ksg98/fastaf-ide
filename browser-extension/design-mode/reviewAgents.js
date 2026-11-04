// Shared with Markdown review notes: only live agents in the exact owning repository.
export function reviewAgents(terminals, repoPath) {
  return terminals.filter((terminal) => terminal?.sessionId && terminal.agentType && terminal.repoPath === repoPath)
    .map((terminal) => ({sessionId: terminal.sessionId, label: terminal.label ?? terminal.name ?? terminal.sessionId}));
}
