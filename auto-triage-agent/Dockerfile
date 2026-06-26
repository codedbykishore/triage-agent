# syntax=docker/dockerfile:1
#
# Auto-Triage Agent — Agent Controller container.
#
# Builds the single, always-on persistent worker (simulating an ECS Fargate
# task) that exposes the authenticated webhook, provisions isolated git
# worktrees, runs the headless Kiro CLI to produce a fix, opens a hotfix Pull
# Request, and alerts Slack. The container needs Git (for `git worktree` /
# branch / push operations), Node.js (the Express runtime), and the Kiro CLI
# (the headless binary that performs triage inside each worktree).
#
# SECRETS: This image bakes in NO secrets. GITHUB_TOKEN, SLACK_WEBHOOK_URL,
# KIRO_API_KEY, REPO_URL, and WEBHOOK_SECRET MUST be supplied at runtime via
# environment variables (e.g. `docker run --env-file .env ...` or an ECS task
# definition / secrets manager). There are intentionally NO secret ARGs and NO
# secret default values below — never add them.

# ---- Base image ----------------------------------------------------------
# Node.js on Debian (slim) so we can apt-get install Git and the Kiro CLI.
# A slim Debian base keeps the image lean while still supporting native tools.
FROM node:20-bookworm-slim

# Install Git, which the worktree manager and GitHub interactions shell out to,
# plus ca-certificates/curl needed to fetch the Kiro CLI and reach the GitHub
# and Slack HTTPS APIs at runtime. `tmux` hosts a persistent session for the
# demo terminal so the live agent output survives detach/attach.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        tmux \
    && rm -rf /var/lib/apt/lists/*

# ---- ttyd (web terminal for live demos) ----------------------------------
# ttyd renders a terminal in the browser so judges can watch the Kiro agent
# work in real time (see scripts/demo-terminal.sh). We fetch a pinned static
# binary from the official releases rather than apt so the version is
# deterministic across base-image updates. This is presentation tooling only —
# it carries no secrets and is unrelated to the triage logic.
ARG TTYD_VERSION=1.7.7
RUN curl -fsSL \
        "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
        -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && ttyd --version

# ---- Kiro CLI (headless binary) ------------------------------------------
# The Controller drives triage entirely through the headless, non-interactive
# Kiro CLI — never the IDE. The exact install command is environment-specific
# (download URL, package name, and auth differ per distribution channel), so it
# is documented here as a clearly-marked, commented placeholder rather than a
# hard-coded fetch that could break the build in this environment.
#
# Provide the install source at build time via a NON-secret build ARG, e.g.:
#   docker build --build-arg KIRO_CLI_INSTALL_URL=https://<host>/kiro-cli ...
#
# NOTE: KIRO_API_KEY authenticates the CLI at RUNTIME and is passed via env —
# it is NOT a build ARG and must never be baked into the image.
ARG KIRO_CLI_INSTALL_URL=""
# Uncomment and adapt ONE of the following once the Kiro CLI distribution is
# known for your environment:
#
#   # (a) Download a prebuilt binary and put it on PATH:
#   RUN if [ -n "$KIRO_CLI_INSTALL_URL" ]; then \
#         curl -fsSL "$KIRO_CLI_INSTALL_URL" -o /usr/local/bin/kiro \
#         && chmod +x /usr/local/bin/kiro; \
#       fi
#
#   # (b) Install via npm (if published as a package):
#   RUN npm install -g @kiro/cli
#
#   # (c) Install via an official install script:
#   RUN curl -fsSL https://<kiro-install-host>/install.sh | sh
#
# Until one of the above is enabled, the image still builds and runs the rest
# of the stack; the Kiro runner will report a failure if the `kiro` binary is
# absent, which the orchestrator surfaces as a failed-triage Slack alert.

# ---- App setup -----------------------------------------------------------
ENV NODE_ENV=production
WORKDIR /app

# Copy manifest files first so dependency installation is cached independently
# of source changes (only re-runs when package*.json change).
COPY package.json package-lock.json ./

# Install production dependencies only. `npm ci` requires the lockfile and
# yields reproducible installs.
RUN npm ci --omit=dev

# Copy the rest of the application source after deps are installed.
COPY . .

# ---- Networking ----------------------------------------------------------
# The Express webhook server listens on PORT (defaults to 3000 in server.js).
# Port 7681 is the ttyd web terminal used for the live demo (see
# scripts/demo-terminal.sh); it is only reachable when that script is run.
EXPOSE 3000 7681

# ---- Healthcheck ---------------------------------------------------------
# Liveness probe hitting the GET /health endpoint exposed by server.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# ---- Runtime -------------------------------------------------------------
# Run as an always-on worker. Secrets are provided via runtime env, not here.
#
# Default: run the controller directly (production). For a live demo where
# judges watch the agent in a browser, override the command to launch the
# controller inside tmux behind the ttyd web terminal:
#
#   docker run --env-file .env -p 3000:3000 -p 7681:7681 \
#     auto-triage-agent ./scripts/demo-terminal.sh
#
CMD ["node", "src/server.js"]
