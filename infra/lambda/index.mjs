/**
 * Lambda: CloudWatch Log Forwarder → Auto-Triage Agent Webhook
 *
 * Receives CloudWatch Logs subscription filter events, extracts [ERROR] log
 * entries, computes an HMAC-SHA256 signature, and POSTs them to the agent's
 * /webhook endpoint.
 */

import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";

const WEBHOOK_URL = process.env.WEBHOOK_URL; // http://<ec2-ip>:3000/webhook
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

export async function handler(event) {
    // CloudWatch Logs sends data as base64-encoded, gzipped JSON
    const compressed = Buffer.from(event.awslogs.data, "base64");
    const payload = JSON.parse(gunzipSync(compressed).toString("utf8"));

    console.log(`Log group: ${payload.logGroup}, stream: ${payload.logStream}`);
    console.log(`Events: ${payload.logEvents.length}`);

    for (const logEvent of payload.logEvents) {
        const message = logEvent.message;

        // Only forward [ERROR] entries
        if (!message.includes("[ERROR]")) {
            console.log("Skipping non-error log event");
            continue;
        }

        console.log(`Forwarding error: ${message.substring(0, 100)}...`);

        // Compute HMAC signature
        const signature = createHmac("sha256", WEBHOOK_SECRET)
            .update(message)
            .digest("hex");

        // POST to the auto-triage-agent webhook
        const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
                "x-signature": signature,
            },
            body: message,
        });

        const body = await response.text();
        console.log(`Webhook response: ${response.status} ${body}`);
    }

    return { statusCode: 200 };
}
