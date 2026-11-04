# Tiny fake backend for the iPad repro: logs every request, answers {} / [] .
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def _r(self):
        n = int(self.headers.get('content-length') or 0)
        if n: self.rfile.read(n)
        open("mock.log","a").write(f"{self.command} {self.path}\n")
        body = json.dumps(ROUTES.get(self.path.split('?')[0], {})).encode()
        self.send_response(200); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(body))); self.end_headers(); self.wfile.write(body)
    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _r
    def log_message(self, *a): pass
def ws(p, i):
    main = i == 0
    wid = f"{p}#{i}"
    return wid, dict(workspaceId=wid, branchName="main" if main else f"feat/branch-{i}", kind="main" if main else "worktree",
        parentRepoPath=None if main else p, isMain=main, worktreePath=None if main else f"{p}__wt/b{i}", terminals=[], hadTerminals=False,
        lastActiveTerminal=None, additions=0, deletions=0, isMerged=False, lastCommitTs=None)
repos = {}
for r in range(6):
    p = f"/fake/repo{r}"
    w = dict(ws(p, i) for i in range(8))
    repos[p] = dict(path=p, displayName=f"repo{r}", initials=f"R{r}", expanded=True, collapsed=False, parked=False, workspaces=w, activeWorkspaceId=f"{p}#0")
files = [dict(name=f"file{i:03}.txt", path=f"file{i:03}.txt", is_dir=(i%7==0), size=100, modified_at=1790000000, git_status="", is_ignored=False) for i in range(120)]
ROUTES = {'/config/repositories': dict(repos=repos, repoOrder=list(repos), activeRepoPath='/fake/repo0', groups={}, groupOrder=[]), '/fs/list': files}
ThreadingHTTPServer(('127.0.0.1', int(__import__('os').environ.get('MOCK_PORT', 9891))), H).serve_forever()
