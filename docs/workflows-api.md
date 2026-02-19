# Workflows API — App Evaluation Template: Client Integration Guide

## Overview

The App Evaluation Workflow is a global template that navigates to a target URL and answers an open-ended question or task using a real browser agent. It does not assert pass/fail — it evaluates, observes, and responds.

**Base URL:** `https://api.debugg.ai/api/v1/`
**Auth:** `Authorization: Token <your-token>`

---

## The 4-Step Integration Pattern

1. Find the template  →  `GET  /workflows/?is_template=true`
2. Clone it           →  `POST /workflows/{uuid}/clone/`
3. Execute it         →  `POST /workflows/{uuid}/execute/`
4. Poll for result    →  `GET  /workflows/executions/{uuid}/`

---

## Step 1 — Find the Template

```
GET /api/v1/workflows/?is_template=true
Authorization: Token <your-token>
```

Response (list item):
```json
{
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "name": "App Evaluation Workflow Template",
  "description": "Global template for open-ended app evaluation...",
  "is_template": true,
  "is_active": true,
  "version": 1,
  "node_count": 4
}
```

Store the `uuid` — this is the template UUID.

---

## Step 2 — Clone the Template (per-use or per-project)

Clone creates a non-template copy you own and can execute.

```
POST /api/v1/workflows/{template_uuid}/clone/
Authorization: Token <your-token>
```

Response 201:
```json
{
  "uuid": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
  "name": "Copy of App Evaluation Workflow Template",
  "is_template": false,
  "is_active": false,
  "nodes": [...],
  "connections": {...}
}
```

> You can skip cloning and execute the template directly if you don't need per-company customisation — the execute endpoint works on any workflow you have access to.

---

## Step 3 — Execute

```
POST /api/v1/workflows/{workflow_uuid}/execute/
Authorization: Token <your-token>
Content-Type: application/json

{
  "context_data": {
    "target_url":   "https://your-app.example.com",
    "question":     "Does the checkout flow accept a discount code?",
    "project_id":   123
  }
}
```

### Required `context_data` fields

| Field        | Type    | Description                                                 |
|--------------|---------|-------------------------------------------------------------|
| `target_url` | string  | URL the browser agent will navigate to                      |
| `question`   | string  | The evaluation task injected as the surfer goal             |
| `project_id` | integer | DB PK of the project — required for browser session scoping |

Response 202:
```json
{
  "task_id": "celery-task-uuid",
  "message": "Workflow execution queued.",
  "resource_uuid": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"
}
```

Save `resource_uuid` — this is the WorkflowExecution UUID you'll poll.

---

## Step 4 — Poll for Result

```
GET /api/v1/workflows/executions/{execution_uuid}/
Authorization: Token <your-token>
```

**Terminal statuses:** `completed`, `failed`, `cancelled`
**In-flight statuses:** `pending`, `running`, `waiting`

Response (completed):
```json
{
  "uuid": "zzzz...",
  "status": "completed",
  "mode": "manual",
  "started_at": "2026-02-18T10:00:00Z",
  "completed_at": "2026-02-18T10:01:45Z",
  "duration_ms": 105000,
  "state": {
    "outcome": "pass",
    "success": true,
    "steps_taken": 7,
    "error": ""
  },
  "error_message": "",
  "error_info": null,
  "node_executions": [
    {
      "node_id": "eval_start",
      "node_type": "trigger.event",
      "status": "success",
      "execution_order": 0
    },
    {
      "node_id": "eval_browser_setup",
      "node_type": "browser.setup",
      "status": "success",
      "output_data": {
        "browser_session_id": "...",
        "surfer_id": "...",
        "target_url": "https://your-app.example.com"
      },
      "execution_order": 1
    },
    {
      "node_id": "eval_surfer_execute",
      "node_type": "surfer.execute_task",
      "status": "success",
      "output_data": {
        "success": true,
        "steps_taken": 7,
        "final_url": "https://your-app.example.com/checkout",
        "actions_count": 7,
        "states_captured": 4,
        "artifacts": {},
        "error": ""
      },
      "execution_order": 2
    },
    {
      "node_id": "eval_browser_teardown",
      "node_type": "browser.teardown",
      "status": "success",
      "execution_order": 3
    }
  ]
}
```

---

## Reading the Result

The evaluation answer lives in `state.outcome` and the surfer's `output_data` from the `surfer.execute_task` node:

| `state.outcome` | Meaning                                         |
|-----------------|-------------------------------------------------|
| `"pass"`        | Agent completed the task / found the answer     |
| `"fail"`        | Agent could not complete the task               |
| `"error"`       | System error (browser crash, CDP failure, etc.) |
| `"timeout"`     | Exceeded the 120s task timeout                  |

The actual narrative result from the browser agent is surfaced through the Surfer's action trace and artifacts. For the evaluation use case, check the linked Surfer object (via `node_executions[2].output_data.surfer_id`) for full action history.

---

## Cancellation

```
POST /api/v1/workflows/executions/{execution_uuid}/cancel/
Authorization: Token <your-token>
```

Only valid when status is `pending`, `running`, or `waiting`. Returns 409 otherwise.

---

## Retry

Creates a new execution with identical `context_data`:

```
POST /api/v1/workflows/executions/{execution_uuid}/retry/
Authorization: Token <your-token>
```

Returns 202 with a new `resource_uuid` to poll.

---

## Inspecting Node-Level Execution

```
GET /api/v1/workflows/executions/{execution_uuid}/nodes/
```

Sorted by `execution_order`. Each record has `input_data`, `output_data`, `execution_time_ms`, and `error` if the node failed.

---

## Node Type Catalog

```
GET /api/v1/workflows/node-types/?category=browser
GET /api/v1/workflows/node-types/surfer.execute_task/
```

---

## Workflow Definition

The App Evaluation template's static graph:

```
trigger.event("app_evaluation_requested")
  → browser.setup(timeout=420)
    → surfer.execute_task(goal={{question}}, max_steps=20, timeout=120)
      → browser.teardown()
```

Settings: `timeout=300s`, `max_retries=1`

The `{{question}}` template variable is resolved from `context_data.question` at execution time. `target_url` is resolved from `context_data.target_url` by the `browser.setup` node.

---

## TypeScript Polling Example

```typescript
const BASE_URL = "https://api.debugg.ai/api/v1";
const TOKEN = process.env.DEBUGGAI_API_KEY!;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

interface ExecutionState {
  outcome: "pass" | "fail" | "error" | "timeout" | "unknown";
  success: boolean;
  steps_taken: number;
  error: string;
}

interface WorkflowExecution {
  uuid: string;
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  duration_ms: number | null;
  state: ExecutionState;
  error_message: string;
  error_info: { message?: string; failed_node_id?: string } | null;
}

async function triggerEvaluation(
  workflowUuid: string,
  targetUrl: string,
  question: string,
  projectId: number
): Promise<string> {
  const res = await fetch(`${BASE_URL}/workflows/${workflowUuid}/execute/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      context_data: { target_url: targetUrl, question, project_id: projectId },
    }),
  });

  if (!res.ok) throw new Error(`Execute failed: ${res.status} ${await res.text()}`);

  const { resource_uuid } = await res.json();
  return resource_uuid;
}

async function pollExecution(executionUuid: string): Promise<WorkflowExecution> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/workflows/executions/${executionUuid}/`, {
      headers: { Authorization: `Token ${TOKEN}` },
    });

    if (!res.ok) throw new Error(`Poll failed: ${res.status} ${await res.text()}`);

    const execution: WorkflowExecution = await res.json();

    if (TERMINAL_STATUSES.has(execution.status)) return execution;

    console.log(`  status=${execution.status}, waiting ${POLL_INTERVAL_MS}ms...`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Execution ${executionUuid} did not complete within ${POLL_TIMEOUT_MS}ms`);
}

async function evaluateApp(
  workflowUuid: string,
  targetUrl: string,
  question: string,
  projectId: number
): Promise<void> {
  const executionUuid = await triggerEvaluation(workflowUuid, targetUrl, question, projectId);
  console.log(`Execution queued: ${executionUuid}`);

  const execution = await pollExecution(executionUuid);

  console.log(`\nResult:`);
  console.log(`  status  : ${execution.status}`);
  console.log(`  outcome : ${execution.state.outcome}`);
  console.log(`  steps   : ${execution.state.steps_taken}`);
  console.log(`  duration: ${execution.duration_ms}ms`);

  if (execution.status === "failed") {
    console.error(`  error   : ${execution.error_message}`);
    if (execution.error_info?.failed_node_id) {
      console.error(`  node    : ${execution.error_info.failed_node_id}`);
    }
  }
}
```

---

## Common Errors

| Scenario                                  | What you'll see                                                               |
|-------------------------------------------|-------------------------------------------------------------------------------|
| Missing `target_url` in `context_data`    | `browser.setup` node fails: "No target_url in node_config or context variables" |
| Missing `project_id` in `context_data`    | `browser.setup` node fails: "No project_id in context variables"              |
| App unreachable / ngrok tunnel error      | `surfer.execute_task` reports it and stops; `outcome=fail`                    |
| `status=failed` + `error_info.failed_node_id` | Node-level failure — check that node's `error` field in `/nodes/`        |
