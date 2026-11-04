export interface ReviewAgentCandidate {
  sessionId?: string | null;
  agentType?: string | null;
  repoPath?: string | null;
  name?: string;
  label?: string;
}
export function reviewAgents(terminals: (ReviewAgentCandidate | undefined)[], repoPath: string): {sessionId: string; label: string}[];
