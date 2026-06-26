/**
 * deployNotifier.js — Deployment Notifier
 *
 * Sends deployment notifications to the #deployments Slack channel.
 * Triage/error alerts continue to go to #qa via slackNotifier.js.
 *
 * This module is intentionally simple: it posts a Block Kit message with
 * deployment metadata (app name, branch, commit, environment) to the
 * deployments webhook. Like slackNotifier, it never throws — delivery
 * failures are logged and surfaced as `{ delivered: false }`.
 */

"use strict";

const axios = require("axios");

/**
 * Build a Slack Block Kit payload for a deployment notification.
 *
 * @param {{
 *   app: string,
 *   branch: string,
 *   commit: string,
 *   environment?: string
 * }} details
 * @returns {{ text: string, blocks: object[] }}
 */
function buildDeployBlocks(details) {
    const d = details && typeof details === "object" ? details : {};
    const app = d.app || "unknown-app";
    const branch = d.branch || "unknown";
    const commit = d.commit || "unknown";
    const environment = d.environment || "production";

    const headerText = `:rocket: ${app} deployed to ${environment}`;
    const fallbackText = `${app} deployed to ${environment} (${branch}@${commit.slice(0, 7)})`;

    const blocks = [
        {
            type: "header",
            text: { type: "plain_text", text: headerText, emoji: true },
        },
        {
            type: "section",
            fields: [
                { type: "mrkdwn", text: `*App:*\n${app}` },
                { type: "mrkdwn", text: `*Environment:*\n${environment}` },
            ],
        },
        {
            type: "section",
            fields: [
                { type: "mrkdwn", text: `*Branch:*\n\`${branch}\`` },
                { type: "mrkdwn", text: `*Commit:*\n\`${commit}\`` },
            ],
        },
    ];

    return { text: fallbackText, blocks };
}

/**
 * Send a deployment notification to the #deployments Slack channel.
 *
 * @param {{
 *   app: string,
 *   branch: string,
 *   commit: string,
 *   environment?: string
 * }} details - Deployment metadata.
 * @param {{ webhookUrl?: string, httpClient?: import("axios").AxiosInstance }} [options]
 * @returns {Promise<{ delivered: boolean }>}
 */
async function notifyDeploy(details, options = {}) {
    const webhookUrl =
        options.webhookUrl || process.env.SLACK_DEPLOYMENTS_WEBHOOK_URL;
    const httpClient = options.httpClient || axios;

    if (!webhookUrl) {
        console.error(
            "Deploy notification skipped: SLACK_DEPLOYMENTS_WEBHOOK_URL is not configured"
        );
        return { delivered: false };
    }

    const payload = buildDeployBlocks(details);

    try {
        const response = await httpClient.post(webhookUrl, payload, {
            headers: { "Content-Type": "application/json" },
            validateStatus: () => true,
        });

        const status =
            response && typeof response.status === "number" ? response.status : 0;
        if (status >= 200 && status < 300) {
            return { delivered: true };
        }

        console.error(
            `Deploy notification failed: webhook returned non-2xx status ${status}`
        );
        return { delivered: false };
    } catch (error) {
        console.error(
            `Deploy notification failed: ${error && error.message ? error.message : error}`
        );
        return { delivered: false };
    }
}

module.exports = {
    buildDeployBlocks,
    notifyDeploy,
};
