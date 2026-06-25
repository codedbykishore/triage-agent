# Directory Structure & File Blueprint

This is the directory structure for the **Agent Controller** (the persistent container). 

```text
auto-triage-agent/
├── Dockerfile                  # Builds the persistent container, installs Git, Kiro, Node/Python
├── package.json / reqs.txt     # Dependencies (Express/FastAPI, Axios/Requests)
├── .env.example                # Template for API keys
├── src/
│   ├── server.js               # Main entry point: Express API listening for CloudWatch webhooks
│   ├── worktreeManager.js      # Handles `git worktree add` and `remove` commands via child_process
│   ├── kiroRunner.js           # Spawns the Kiro agent process inside the specific worktree
│   ├── slackNotifier.js        # Formats and sends the Slack Block Kit messages
│   └── githubInteractions.js   # Fallback/Helper functions for Git operations if Kiro needs them
├── system_prompts/
│   └── incident_responder.txt  # The exact prompt instructing Kiro how to behave in the worktree
└── tests/
    └── simulate_webhook.sh     # Script to manually fire a mock CloudWatch error to localhost