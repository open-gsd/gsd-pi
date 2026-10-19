# Message Types and LLM Visibility

Every message in pi has an `AgentMessage` type. These messages go through `convertToLlm` before the LLM sees them. This document specifies exactly what the LLM receives for each message type and what it never sees.

---

## The AgentMessage Type Hierarchy

Pi uses `AgentMessage` as its internal message type, which is a union of standard LLM messages and custom application messages:

```typescript
// Standard LLM messages
type Message = UserMessage | AssistantMessage | ToolResultMessage;

// Custom messages added by pi's coding agent
interface CustomAgentMessages {
  bashExecution: BashExecutionMessage;
  custom: CustomMessage;
  branchSummary: BranchSummaryMessage;
  compactionSummary: CompactionSummaryMessage;
}

// The union
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

---

## Message Type → LLM Conversion Table

| AgentMessage type | `role` seen by LLM | Content transformation | When excluded |
|---|---|---|---|
| `user` | `user` | Pass through unchanged | Never |
| `assistant` | `assistant` | Pass through unchanged | Never |
| `toolResult` | `toolResult` | Pass through unchanged | Never |
| `custom` | `user` | `content` preserved as-is (string → `[{type:"text",text}]`) | Never — ALL custom messages reach the LLM |
| `bashExecution` | `user` | Formatted: `` Ran `cmd`\n```\noutput\n``` `` | When `excludeFromContext: true` (`!!` prefix) |
| `compactionSummary` | `user` | Wrapped: `The conversation history before this point was compacted into the following summary:\n<summary>\n...\n</summary>` | Never |
| `branchSummary` | `user` | Wrapped: `The following is a summary of a branch that this conversation came back from:\n<summary>\n...\n</summary>` | Never |

---

## Custom Messages In Detail

Custom messages are created by:

1. `pi.sendMessage()` — extension-injected messages
2. `before_agent_start` returning a `message` — per-prompt context injection

### The `display` Field Misconception

```typescript
pi.sendMessage({
  customType: "my-context",
  content: "This text goes to the LLM",
  display: false,  // ← ONLY controls UI rendering
});
```

**What `display` controls:**

- `true`: Message appears in the TUI chat log (rendered via `registerMessageRenderer` if one exists, or default rendering)
- `false`: Message is hidden from the TUI chat log

**What `display` does NOT control:**

- LLM visibility — the LLM ALWAYS receives the content as a `user` role message
- Session persistence — the message is ALWAYS persisted to the session file

### How Custom Messages Become User Messages

In `convertToLlm` (messages.ts):

```typescript
case "custom": {
  const content = typeof m.content === "string" 
    ? [{ type: "text", text: m.content }] 
    : m.content;
  return {
    role: "user",
    content,
    timestamp: m.timestamp,
  };
}
```

The `customType`, `display`, and `details` fields are all stripped. The LLM sees a plain user message with the content.

---

## Bash Execution Messages

Created when the user runs commands via `!` or `!!` prefix.

### `!` (included in context)

```typescript
// User types: !ls -la
// LLM sees:
{
  role: "user",
  content: [{ type: "text", text: "Ran `ls -la`\n```\n<output>\n```" }]
}
```

With exit code, cancellation, and truncation info appended as needed:

- Non-zero exit: `\n\nCommand exited with code N`
- Cancelled: `\n\n(command cancelled)`
- Truncated: `\n\n[Output truncated. Full output: /path/to/file]`

### `!!` (excluded from context)

```typescript
// User types: !!echo secret
// LLM sees: NOTHING — filtered out by convertToLlm
```

The `excludeFromContext` flag on `BashExecutionMessage` causes `convertToLlm` to return `undefined` for this message, effectively removing it.

---

## Compaction and Branch Summary Messages

These are synthetic messages created by pi's session management.

### Compaction Summary

When the context is compacted, older messages are replaced with a summary:

```typescript
// LLM sees:
{
  role: "user",
  content: [{
    type: "text",
    text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\n[LLM-generated summary of the compacted conversation]\n</summary>"
  }]
}
```

### Branch Summary

When navigating away from a branch and back, the abandoned branch gets summarized:

```typescript
// LLM sees:
{
  role: "user",
  content: [{
    type: "text",
    text: "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n[summary of the branch]\n</summary>"
  }]
}
```

---

## What the LLM Never Sees

1. **`appendEntry` data** — Extension-private entries (`pi.appendEntry("my-state", data)`) are stored in the session file but NEVER included in the message array. They're not `AgentMessage` types at all — they're `CustomEntry` session entries.

2. **`details` on custom messages** — The `details` field is for rendering and state reconstruction. `convertToLlm` strips it.

3. **`details` on tool results** — Tool result `details` are stripped by the LLM message conversion. Only `content` reaches the LLM.

4. **`!!` bash execution output** — Explicitly excluded from context.

5. **Tool definitions not in the active set** — If a tool is registered but not in `getActiveTools()`, the LLM doesn't know it exists.

6. **`promptSnippet` and `promptGuidelines` from inactive tools** — Only active tools contribute to the system prompt.

---

## The Message Array Order

For a typical conversation, the message array the LLM sees (after `context` event and `convertToLlm`) looks like:

```
1. [compactionSummary → user]  (if compaction happened)
2. [branchSummary → user]      (if navigated back from a branch)
3. [user]                       (first user message after compaction)
4. [assistant]                  (LLM response)
5. [toolResult]                 (tool results)
6. [user]                       (next user message)
7. [custom → user]              (extension-injected message)
8. ...continues...
9. [user]                       (current prompt)
10. [custom → user]             (before_agent_start injected messages)
11. [custom → user]             (nextTurn queued messages)
```

---

## Implications for Extension Authors

### If you want the LLM to see something:

- Use `before_agent_start` → `message` for per-prompt context
- Use `context` event to inject into the message array per-turn
- Use `pi.sendMessage` for standalone messages
- Use `before_agent_start` → `systemPrompt` for system-level instructions

### If you want to hide something from the LLM:

- Use `pi.appendEntry` — never reaches the message array
- Use tool result `details` — stored in session but stripped before LLM
- Use the `context` event to filter messages OUT of the array
- There is NO way to inject UI-only messages that participate in the conversation flow — `display: false` only hides from the TUI, not from the LLM

### If you want something to survive compaction:

- Store it in tool result `details` (survives in the kept entries)
- Store it in `appendEntry` (survives as session data, not messages)
- Re-inject it via `before_agent_start` every time (survives because you regenerate it)
- Messages in the compacted range are replaced by the compaction summary — they're gone from the LLM's perspective
