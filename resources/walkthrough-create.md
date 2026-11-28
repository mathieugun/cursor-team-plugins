# Create a team repository

No team repository yet? **Create team repository** builds one from what you already have.

1. **Create an empty Git repository** on your Git host (GitHub, GitLab, Bitbucket, your own server) and copy its URL.
   It must have no commits: no README, no license.
2. **Run the command.** It looks in the `.cursor` folder of each open project, in `~/.cursor` (skills, commands, agents
   and MCP servers; Cursor does not read rules there) and in folders you pick by hand.
3. **Read the preview.** It lists what goes in once (identical copies are imported once), the variants that need a
   decision, the values that look like secrets, and the files an item points to that stay where they are.
4. **Pick what goes in.** For an item that exists in several versions, compare them, use one, merge them by hand, keep
   each under its own name, or leave it out.
5. **Enter the URL** (no user name or password in it: git gets them from your credential manager) and the name of the
   plugin. Confirm: the repository is written, pushed and added to the ones you follow.

A secret value in an MCP server's `env` or headers is replaced by `${env:NAME}`: set the environment variable `NAME`
on each machine and restart Cursor, and a server reads it in its `env` (for headers, test the server once). Values
that only look like a secret are left unticked for you to check.

At the end, **Replace the originals** moves the originals you tick to the trash and removes the ticked MCP servers
from their `mcp.json` (backed up first), once the new plugin is cloned and in use, so the agent does not read each item
twice. **Keep them** leaves
everything in place; tick the plugin later in the Team Plugins view.

Already have a team repository? Go to the next step.
