# Notifications

GSD sends desktop notifications during auto mode to keep you informed without watching the terminal.

## Configuration

```yaml
notifications:
  enabled: true
  local_bell: false      # play terminal bell on questions and auto-mode stops
  on_complete: true      # notify on unit completion
  on_error: true         # notify on errors
  on_budget: true        # notify on budget thresholds
  on_milestone: true     # notify when milestone finishes
  on_attention: true     # notify when manual attention needed
```

Set `local_bell: true` to make GSD write a local terminal bell when
`ask_user_questions` needs an answer or auto-mode stops. The bell is
controlled by `enabled` and `on_attention`.

## macOS Setup

GSD uses `terminal-notifier` when available, falling back to `osascript`.

**Recommended:** Install `terminal-notifier` for reliable delivery:

```bash
brew install terminal-notifier
```

**Why?** The `osascript` fallback attributes notifications to your terminal app (Ghostty, iTerm2, etc.), which may not have notification permissions. `terminal-notifier` registers as its own app and prompts for permission on first use.

### Notifications Not Appearing?

1. Check **System Settings → Notifications** for your terminal app
2. Install `terminal-notifier` (recommended)
3. Test with:
   ```bash
   terminal-notifier -title "GSD" -message "working!" -sound Glass
   ```

If your terminal app doesn't appear in Notification settings, it may need to send at least one notification first to register. See [Troubleshooting](../reference/troubleshooting.md) for more details.
