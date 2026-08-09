# Repository Context

This repository is edited by **two different accounts**. To avoid the two
accounts' Claude Code sessions colliding — sharing auth, settings, MCP
config, or conversation history — each account runs Claude Code against its
own isolated configuration directory via the `CLAUDE_CONFIG_DIR`
environment variable.

## How it's set up

Two dedicated config directories:

- `~/.claude-account1`
- `~/.claude-account2`

And two shell aliases (added to `~/.bashrc` and `~/.zshrc`) that point
`CLAUDE_CONFIG_DIR` at the right one before launching `claude`:

```bash
export CLAUDE_ACCOUNT1_CONFIG_DIR="$HOME/.claude-account1"
export CLAUDE_ACCOUNT2_CONFIG_DIR="$HOME/.claude-account2"
alias claude-account1='CLAUDE_CONFIG_DIR="$CLAUDE_ACCOUNT1_CONFIG_DIR" claude'
alias claude-account2='CLAUDE_CONFIG_DIR="$CLAUDE_ACCOUNT2_CONFIG_DIR" claude'
```

## Usage

- Reload your shell (`source ~/.bashrc` or `source ~/.zshrc`, or open a new
  terminal) after this setup runs.
- Whichever person is working, launch Claude Code with their own alias
  instead of the bare `claude` command:

  ```bash
  claude-account1   # first account's isolated session
  claude-account2   # second account's isolated session
  ```

- Each alias keeps that account's login, settings, and history under its
  own directory (`~/.claude-account1` or `~/.claude-account2`), so logging
  in as one account never overwrites the other's credentials.
- Rename the directories/aliases (e.g. to each person's actual name or
  GitHub handle) if you'd prefer something more identifiable than
  `account1`/`account2` — just update the exports/aliases in the shell
  profile to match.

## Project reference

For what this application actually does, see [README.md](README.md) (technical
reference) or [SETUP.md](SETUP.md) (non-technical walkthrough).
