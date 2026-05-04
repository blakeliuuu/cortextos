---
name: status
description: "On-demand system status check — fleet health, task counts, pending approvals, human tasks, and token usage. Run when anyone asks 'what's the status?' or '/status'. Produces a compact report suitable for Telegram or inline reply."
triggers: ["/status", "status check", "system status", "how are things", "what's the status", "quota check", "usage check"]
---

# /status — System Status Report

Run all commands below and compile a single compact report.

## 1. Fleet Health

```bash
cortextos bus read-all-heartbeats
```

Flag any agent with heartbeat older than 5 hours as STALE.

## 2. System Metrics

```bash
cortextos bus collect-metrics
```

Extract: total tasks completed, per-agent task counts, agents healthy vs total, approvals pending.

## 3. Stale Tasks

```bash
cortextos bus check-stale-tasks
```

## 4. Human Tasks

```bash
cortextos bus list-tasks --status pending --format json
```

Filter for tasks with `[HUMAN]` in title. Report count and how long each has been pending.

## 5. Token Usage (if available)

```bash
cortextos bus check-usage-api 2>/dev/null
```

If this errors (no OAuth token), report "Token API not wired — proxy metrics only" and skip.

## 6. Compile Report

Format as:

```
STATUS REPORT — <timestamp>

FLEET: <N>/<total> healthy
<agent>: <status> — <last heartbeat summary>
...

TASKS: <completed> done, <pending> pending, <in_progress> active
Stale: <list or "none">
Human: <list or "none">

USAGE: <data or "not wired">

APPROVALS: <count> pending
```

Keep it under 1000 chars for Telegram readability. If the caller asks for Telegram delivery, send via:
```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<report>"
```
