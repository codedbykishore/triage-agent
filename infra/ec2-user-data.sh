#!/bin/bash
# EC2 bootstrap script for Auto-Triage Agent demo
# Installs Node.js, Git, clones mock-app, starts both services

set -e

# Log everything
exec > /var/log/user-data.log 2>&1
echo "=== Starting bootstrap at $(date) ==="

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs git

# Install PM2 for process management
npm install -g pm2

# Install CloudWatch agent
dnf install -y amazon-cloudwatch-agent

# Configure CloudWatch agent to ship stderr logs from the mock-app
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWEOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/mock-app-error.log",
            "log_group_name": "/auto-triage/mock-app",
            "log_stream_name": "{instance_id}",
            "multi_line_start_pattern": "^\\[ERROR\\]",
            "timestamp_format": "%Y-%m-%dT%H:%M:%S"
          }
        ]
      }
    }
  }
}
CWEOF

# Start CloudWatch agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Create app directory
mkdir -p /opt/mock-app
cd /opt/mock-app

# Clone the mock-production-app (will be pushed to a GitHub repo)
# For now, create it inline since we haven't pushed to GitHub yet
cat > package.json << 'EOF'
{
  "name": "mock-production-app",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.21.0" }
}
EOF

cat > server.js << 'SERVEREOF'
"use strict";

const express = require("express");
const fs = require("fs");

const ERROR_LOG = "/var/log/mock-app-error.log";

function logError(err) {
  const stackBody = (err.stack || "").split("\n").slice(1).join("\n");
  const msg = `[ERROR] ${err.message}\n${stackBody}\n`;
  process.stderr.write(msg);
  // Also write to file for CloudWatch agent to pick up
  fs.appendFileSync(ERROR_LOG, msg);
}

function readUserId() {
  const user = null;
  return user.profile.id;
}

function parseConfig(body) {
  return JSON.parse(body);
}

function createApp() {
  const app = express();
  app.use(express.text({ type: "*/*" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/null-pointer", (_req, res) => {
    const id = readUserId();
    res.status(200).json({ id });
  });

  app.post("/bad-json", (req, res) => {
    const config = parseConfig(req.body);
    res.status(200).json({ config });
  });

  app.use((err, _req, res, _next) => {
    logError(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}

const port = Number(process.env.PORT) || 4000;
createApp().listen(port, () => {
  console.log(`[mock-app] listening on http://localhost:${port}`);
});
SERVEREOF

npm install

# Start mock-app with PM2
pm2 start server.js --name mock-app
pm2 save
pm2 startup systemd -u root --hp /root

# Touch the error log file so CloudWatch agent can watch it
touch /var/log/mock-app-error.log

echo "=== Bootstrap complete at $(date) ==="
