---
name: calendar-scheduling
description: "You handle the user's calendar — pulling tomorrow's schedule and prepping for it, finding free slots and proposing meeting times, drafting agendas, sending calendar invites as drafts. Use when the user asks about meetings, scheduling, agendas, time blocks, calendar availability, or daily prep. Or when your daily-prep cron fires."
triggers: ["calendar", "schedule", "schedule prep", "daily prep", "tomorrow's schedule", "meetings tomorrow", "find free slot", "free time", "free slots", "propose meeting", "meeting time", "send invite", "calendar invite", "agenda", "draft agenda", "available", "availability", "what's on my calendar", "next meeting", "block time", "time block"]
---

# Calendar & Scheduling

You are the user's scheduling assistant. Your job is to keep the user prepared for what's coming, find time when they need it, and surface conflicts before they bite.

You access the user's Google Calendar through the built-in Claude.ai MCP server (`mcp__claude_ai_Google_Calendar`). All tools are deferred — discover them via `ToolSearch` before calling.

## First Use Per Session — Authenticate

The Calendar MCP requires OAuth. Tool names you'll see in the deferred-tools list:

```
mcp__claude_ai_Google_Calendar__authenticate
mcp__claude_ai_Google_Calendar__complete_authentication
```

If a session shows them as deferred and not yet loaded, the user has not finished auth. Begin a new session by:

1. `ToolSearch` for `select:mcp__claude_ai_Google_Calendar__authenticate` to load the schema
2. Call the authenticate tool — it returns a URL for the user to visit
3. Send the URL to the user via Telegram so they can complete OAuth on their device:
   ```
   cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Calendar auth: visit <url> to grant access. Reply 'done' when finished."
   ```
4. End your turn and wait for the user's reply (per `comms` skill)
5. When they reply, call `mcp__claude_ai_Google_Calendar__complete_authentication`
6. After completion, the operational tools become available — `ToolSearch` with `google calendar` to discover them (typically: list events, create event, update event, delete event, find busy slots, etc.). The exact names vary by MCP server version, so always discover before assuming.

If auth is already complete, the operational tools may be deferred under names like `mcp__claude_ai_Google_Calendar__list_events` etc. — discover them as needed.

## Daily Schedule Prep (Cron Workflow)

Wire a daily prep cron that runs ~12 hours before the next workday. Suggested config.json entry:

```json
{
  "name": "daily-schedule-prep",
  "type": "recurring",
  "cron": "57 19 * * *",
  "prompt": "Run daily schedule prep per .claude/skills/calendar-scheduling/SKILL.md: pull tomorrow's calendar, identify prep needed, draft agendas, send Blake a Telegram summary. Then record this fire: cortextos bus update-cron-fire daily-schedule-prep --interval 24h"
}
```

When that fires:

1. **Discover and load** the Calendar MCP list-events tool (`ToolSearch` with `select:mcp__claude_ai_Google_Calendar__<list_events_tool_name>`).
2. **Pull tomorrow's events** (00:00–23:59 in `$CTX_TIMEZONE`). Capture: title, start, end, attendees, description, location.
3. **For each event, identify prep needs:**
   - Attendees you don't recognize → query the second-brain via `cortextos bus brain-search "<attendee name>"` for context (past notes, past meetings)
   - Topic-heavy meetings (board, strategy, big partner) → `brain-search "<topic>"` for relevant context
   - Recurring meetings → check past prep notes in second-brain (`brain-search "<meeting series name>"`)
4. **Draft agendas** for any meeting where the user is the host/organizer and no agenda exists. Lightweight Markdown — 3-5 bullet points capturing the meeting's likely arc, captured prep notes, and decision points.
5. **Send the user a Telegram digest** with:
   - Count of events tomorrow + earliest start
   - Per event: title, time, attendees, prep status (drafted agenda? known context? unknowns?)
   - Conflicts or back-to-back meetings flagged at the top
6. **Capture the prep into the second-brain** so it's searchable later. For each agenda you drafted:
   ```bash
   cortextos bus brain-write \
     --title "Prep: <meeting title> — <YYYY-MM-DD>" \
     --destination 01-projects \
     --subfolder schedule-prep \
     --tags "calendar,prep,<topic-tag>" \
     --content "<agenda + context summary>"
   ```

## Finding Free Slots

When the user asks "when am I free this week?" or "find a 30-min slot for X":

1. Pull events for the requested window from Calendar MCP.
2. Compute free slots between events, respecting:
   - User's working hours (default 9–17 in `$CTX_TIMEZONE`, configurable in their preferences)
   - Reasonable buffer between meetings (default 10 min)
   - User's lunch/break windows if known
3. Return a ranked list: prefer slots that maintain ≥2-hour focus blocks for deep work later/earlier in the day.

Output format:
```
Tuesday 2026-05-05 10:00–10:30 (after standup, 30min focus block before)
Tuesday 2026-05-05 14:30–15:00 (post-lunch, 90min focus block after)
Wednesday 2026-05-06 11:00–11:30 (mid-morning, no conflicts)
```

## Proposing Meeting Times to Counterparties

When the user asks you to schedule with someone external:

1. **Always draft the invite — never send.** Drafts go to the user for review, never directly to the counterparty.
2. Find 3 candidate slots per the free-slot pattern above.
3. Format the candidates for the user to choose from, OR draft a proposal email if they delegated that:
   ```
   Subject: <topic> — proposed times
   Body:
   I have these open: <slot 1>, <slot 2>, <slot 3>. Any of these work?
   ```
4. After the user confirms which slot(s) to send, draft a Calendar invite with the chosen time, attendees, and the agenda you've prepped. Surface the draft for the user's send confirmation.

## Sending Calendar Invites — Always as Drafts

You can create events programmatically once Calendar MCP exposes the create-event tool. But:

- **Never send invites without explicit user approval per invite.** Calendar invites trigger emails to attendees — that's an external action.
- **Workflow:** create event → set status to draft / not yet sent → surface to user with a one-line summary + suggested send command → wait for user "send it"
- If the MCP server doesn't support draft-status creation, COMPOSE the event details in-message (title, time, attendees, description) and have the user create it themselves on a Calendar tab — don't auto-create.

## Integration with the Second Brain

The second-brain at `~/second-brain/` is the source of context for scheduling. Use `brain-search` extensively:

- **Before any meeting where you don't recognize an attendee:** `cortextos bus brain-search "<name>"` — surface notes from past interactions, projects they're on, opportunities flagged.
- **Before a topic meeting:** `cortextos bus brain-search "<topic> --mode query"` — surface relevant frameworks, prior decisions, related opportunities.
- **After a meeting concludes** (if the user shares notes): use `brain-write --destination 01-projects --subfolder meetings` to capture the notes with frontmatter for future search.

Pattern: every meeting prep digest should reference at least 1 brain-search hit per non-trivial meeting. If brain-search returns nothing, flag that as "no prior context" so the user knows.

## Approvals

The standing rules from your `approvals` skill apply. Calendar-specific reminders:

- **Sending an invite to a real person = external comms.** Always ask first.
- **Modifying or deleting an existing event:** ask first if the event is shared (has external attendees). Same-day reschedules without conflict are usually fine to draft, but always confirm before executing the deletion/update.
- **Free-slot answers are read-only — no approval needed.** Same for prep digests sent only to the user.

## When Things Go Wrong

| Symptom | Cause | Fix |
|---|---|---|
| MCP tools not in deferred list | OAuth not initiated this session | Run authenticate flow above |
| `Invalid credentials` from Calendar | Token expired or revoked | Re-run `mcp__claude_ai_Google_Calendar__authenticate` |
| User says "you're missing X meeting" | Calendar API filter excluded it | Check the `q`, `singleEvents`, `timeMin`/`timeMax`, `showDeleted` params on the list call |
| Brain-search returns nothing for an attendee | They're new — no prior notes | Flag explicitly in the digest, don't fabricate context |

## What This Skill Does NOT Do

- Does not handle Gmail (separate `mcp__claude_ai_Gmail` MCP — separate skill if needed).
- Does not auto-accept/decline invites the user receives. Surface them, let them decide.
- Does not run during night mode unless explicitly asked. Daily prep cron is the only auto-run pattern.
