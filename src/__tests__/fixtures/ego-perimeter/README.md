# Recorded ego perimeter output

These JSON files were recorded on macOS on 2026-10-06 from the existing mbx
`ego` debug executable under target `0ef5875f`, with `EGO_HOME` set to
`~/Gits/.tmp/tuic-1401/ego-home` and cwd `~/Gits/.tmp/tuic-1401/workspace`.

Commands: `ego config ls --json`, `ego config ls --effective --json`.

The default pair precedes all writes. The empty pair follows
`ego config set -- 'roots=[]'`. The restricted pair follows:

```sh
ego config set -- 'roots=[{path="~/Gits/.tmp/tuic-1401/primary",access="read"},{path="~/Gits/.tmp/tuic-1401/reference",access="read"},{path="~/Gits/.tmp/tuic-1401/writable",access="read-write"}]'
ego config set -- 'network="off"'
```

All directories existed under Gits. No credentials or provider calls were used.
Paths are recorded output, not portable scratch fixtures. Tests parse them and
do not require these directories to exist. Capability evidence is `not_checked`;
these files do not prove OS enforcement.

## Measured capability contract

`measured-contract.json` is **contract-derived, not captured**. The coordinator
explicitly authorized this fixture on 2026-10-06 because TUIC's headless path
never receives measured session views today. It follows ego commit
`c8bbb8231f5c163db7772ead4def8efdef4d6bf6`, `CLI.md` lines 1585–1594:
capabilities is a measured string array, an empty array is a completed empty
measurement, and `probe_evidence` is `<sha256>:<bytes>`. The zero hash and
contract paths are placeholders for schema testing, not genuine OS evidence.
Tests change this domain input to cover partial sets and off+online; they do
not claim that those cases were observed on the host OS.

`effective-with-reason.json` is captured output from a fresh native mbx build
of ego commit `c8bbb8231f5c163db7772ead4def8efdef4d6bf6` in worktree
`feat-perimeter-measured-capabilities`. Command:
`ego config ls --effective --json`, with `EGO_PROFILE` removed,
`EGO_HOME=~/Gits/.tmp/tuic-1401/ego-297-home`, cwd as above. This capture retains
the headless `not_checked` state and its reason; it contains no probe evidence.
Build/artifact/capture logs are in `~/Gits/.tmp/tuic-1401/ego297-capture.log` and
`ego297-artifacts.jsonl`. No extra probes were executed.

## Critic inherited-profile capture

`stored-inherited-profile.json` and `effective-inherited-profile.json` were captured
on 2026-10-06 from the same ego297 executable above, with isolated
`EGO_HOME=~/Gits/.tmp/critic-1401/ego-home` and cwd
`~/Gits/.tmp/critic-1401/workspace`. The root directory existed. Commands:

```sh
ego config set -- 'roots=[{path="/Users/stefano.straus/Gits/.tmp/critic-1401/root",access="read"}]'
ego config set --profile=review -- 'network="off"'
ego config ls --profile=review --json
ego config ls --profile=review --effective --json
```

The profile listing omits roots while its effective view inherits the user root.
No provider calls, probes, or credentials were used.
