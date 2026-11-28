"""Claude Code Stop and SubagentStop hook: an agent can't finish while the lint fails.

It runs the pre-commit hook, so the lint command stays in one place. Exit 2 hands stderr back to the agent.
A second stop in a row (stop_hook_active) is let through, so an error it can't fix never loops.
"""
import json
import os
import subprocess
import sys

if json.load(sys.stdin).get("stop_hook_active"):
    sys.exit(0)

root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
lint = subprocess.run(
    [sys.executable, os.path.join(root, ".githooks", "pre-commit")],
    cwd=root,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
if lint.returncode == 0:
    sys.exit(0)

sys.stderr.buffer.write(
    b"The lint fails. Fix what your own changes caused; report anything else instead of fixing it.\n\n" + lint.stdout
)
sys.exit(2)
