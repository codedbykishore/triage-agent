# Mock Production App

A deliberately minimal API that serves as the triage **test target** for the
Auto-Triage Agent. It intentionally throws the two codebase-related runtime
errors the agent is scoped to fix, and logs them in the exact `[ERROR]` format
the webhook parser expects.

## Endpoints

| Method | Path            | Behavior                                                        |
|--------|-----------------|-----------------------------------------------------------------|
| GET    | `/health`       | Returns `200 {"status":"ok"}`.                                  |
| GET    | `/null-pointer` | Dereferences `null` → `TypeError: Cannot read properties of null`. |
| POST   | `/bad-json`     | `JSON.parse` on an unguarded body → `SyntaxError` for bad JSON. |

Both bug endpoints fall through to a central error handler that logs the
exception and returns `500`.

## Run it

```bash
# from auto-triage-agent/
node mock-app/server.js          # listens on http://localhost:4000 (MOCK_APP_PORT to override)

# trigger the null-pointer bug
curl http://localhost:4000/null-pointer

# trigger the bad-JSON bug
curl -X POST http://localhost:4000/bad-json --data 'not valid json'
```

## Error log format

When an endpoint throws, the app writes to **stderr** in this exact shape:

```
[ERROR] <message>
    at <frame> (<file>:<line>:<col>)
    at <frame> (<file>:<line>:<col>)
    ...
```

- The **first line** begins with the `[ERROR]` marker and the error message.
- Every **following line** is a stack frame.

This is precisely what `src/incident.js#parsePayload` consumes: it takes the
first `[ERROR]` line as `errorMessage` and the remaining lines as `stackTrace`,
and it is the same format `tests/simulate_webhook.sh` sends to `/webhook`.

## CloudWatch multiline grouping

Because one error spans multiple lines, CloudWatch must group the message and
its stack frames into a **single log event** — otherwise each line would arrive
as a separate event and the stack trace would be split across payloads.

Configure the `awslogs` driver with a multiline pattern that starts a new event
only on the `[ERROR]` marker:

```
awslogs-multiline-pattern: "^\[ERROR\]"
```

Example ECS task `logConfiguration`:

```json
"logConfiguration": {
  "logDriver": "awslogs",
  "options": {
    "awslogs-group": "/auto-triage/mock-app",
    "awslogs-region": "us-east-1",
    "awslogs-stream-prefix": "mock-app",
    "awslogs-multiline-pattern": "^\\[ERROR\\]"
  }
}
```

Any line that does **not** match `^\[ERROR\]` (the indented `    at ...` frames)
is appended to the current event, so the full error — message plus stack trace —
is delivered together to the Auto-Triage Agent webhook.

## Scope

This app only emits **codebase-related** errors (null pointer, bad JSON parse).
Infrastructure-level failures (OOM, disk-full, network outages) are out of scope
for the agent and are intentionally not simulated here.
