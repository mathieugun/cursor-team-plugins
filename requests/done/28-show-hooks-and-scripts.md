# 28. Show hooks and scripts in the tree

List the hooks Cursor would load under each plugin, with their event names and a way to open the configuration.
Give the hook group one checkbox so a teammate can use a plugin's skills and rules with its hooks disabled.
Keep that choice across syncs and apply it to both full and partial selections.

Show bundled scripts under their skill or plugin as click-to-open rows without checkboxes. Scripts are files a
skill or hook can call, so they follow the selection of the skill or plugin that ships them.

Design approved in chat on 2026-11-28. Hooks are a regular selectable item. Scripts are discovered in the
`scripts/` directories of the plugin and its skills.

Verified on Windows, Linux and isolated Cursor 3.32.10.
