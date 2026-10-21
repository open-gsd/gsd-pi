import { GSD_WEBSITE } from './logo.js'

function writeHelpHeader(version: string): void {
  process.stdout.write(`GSD v${version} — Git Ship Done\n`)
  process.stdout.write(`${GSD_WEBSITE}\n\n`)
}

const SUBCOMMAND_HELP: Record<string, string> = {
  config: [
    'Usage: gsd config',
    '',
    'Re-run the interactive setup wizard to configure:',
    '  - LLM provider (Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, etc.)',
    '  - Web search provider (Brave, Tavily, built-in)',
    '  - Remote questions (Discord, Slack, Telegram)',
    '  - Tool API keys (Context7, Jina, Groq)',
    '',
    'All steps are skippable and can be changed later with /login or /search-provider.',
    '',
    'For detailed provider setup instructions (OpenRouter, Ollama, LM Studio, vLLM,',
    'and other OpenAI-compatible endpoints), see docs/providers.md.',
  ].join('\n'),

  update: [
    'Usage: gsd update [browser] [--models]',
    '',
    'Update GSD to the latest version, update browser automation only,',
    'or refresh the runtime model catalog.',
    '',
    'Options:',
    '  --models   Refresh the model catalog overlay',
    '             (~/.gsd/agent/models-catalog.json) from the latest published catalog',
    '',
    'Examples:',
    '  gsd update',
    '  gsd update browser',
    '  gsd update --models',
  ].join('\n'),

  upgrade: [
    'Usage: gsd upgrade [browser] [--models]',
    '',
    'Alias for update. Upgrade GSD, upgrade browser automation only,',
    'or refresh the runtime model catalog.',
    '',
    'Examples:',
    '  gsd upgrade',
    '  gsd upgrade browser',
    '  gsd upgrade --models',
  ].join('\n'),

  sessions: [
    'Usage: gsd sessions',
    '',
    'List all saved sessions for the current directory and interactively',
    'pick one to resume. Shows date, message count, and a preview of the',
    'first message for each session.',
    '',
    'Sessions are stored per-directory, so you only see sessions that were',
    'started from the current working directory.',
    '',
    'Compare with --continue (-c) which always resumes the most recent session.',
  ].join('\n'),

  install: [
    'Usage: gsd install <source> [-l, --local]',
    '',
    'Install a package/extension source and run post-install validation (dependency checks, setup).',
    '',
    'Examples:',
    '  gsd install npm:@foo/bar',
    '  gsd install git:github.com/user/repo',
    '  gsd install https://github.com/user/repo',
    '  gsd install ./local/path',
  ].join('\n'),

  remove: [
    'Usage: gsd remove <source> [-l, --local]',
    '',
    'Remove an installed package source and its settings entry.',
  ].join('\n'),

  list: [
    'Usage: gsd list',
    '',
    'List installed package sources from user and project settings.',
  ].join('\n'),

  worktree: [
    'Usage: gsd worktree <command> [args]',
    '',
    'Manage isolated git worktrees for parallel work streams.',
    '',
    'Commands:',
    '  list                 List worktrees with status (files changed, commits, dirty)',
    '  merge [name]         Squash-merge a worktree into main and clean up',
    '  clean                Remove all worktrees that have been merged or are empty',
    '  remove <name>        Remove a worktree (--force to remove with unmerged changes)',
    '',
    'The -w flag creates/resumes worktrees for interactive sessions:',
    '  gsd -w               Auto-name a new worktree, or resume the only active one',
    '  gsd -w my-feature    Create or resume a named worktree',
    '',
    'Lifecycle:',
    '  1. gsd -w             Create worktree, start session inside it',
    '  2. (work normally)    All changes happen on the worktree branch',
    '  3. Ctrl+C             Exit — dirty work is auto-committed',
    '  4. gsd -w             Resume where you left off',
    '  5. gsd worktree merge Squash-merge into main when done',
    '',
    'Examples:',
    '  gsd -w                              Start in a new auto-named worktree',
    '  gsd -w auth-refactor                Create/resume "auth-refactor" worktree',
    '  gsd worktree list                   See all worktrees and their status',
    '  gsd worktree merge auth-refactor    Merge and clean up',
    '  gsd worktree clean                  Remove all merged/empty worktrees',
    '  gsd worktree remove old-branch      Remove a specific worktree',
    '  gsd worktree remove old-branch --force  Remove even with unmerged changes',
  ].join('\n'),

  graph: [
    'Usage: gsd graph <subcommand> [options]',
    '',
    'Manage the GSD project knowledge graph. Reads .gsd/ artifacts and builds',
    'a queryable graph of milestones, slices, tasks, rules, patterns, and lessons.',
    '',
    'Subcommands:',
    '  build   Parse .gsd/ artifacts (STATE.md, milestone ROADMAPs, slice PLANs,',
    '          KNOWLEDGE.md) and write .gsd/graphs/graph.json atomically.',
    '  query   Search graph nodes by term (BFS from seed matches, budget-trimmed).',
    '          Returns matching nodes and reachable edges within the token budget.',
    '  status  Show whether graph.json exists, its age, node/edge counts, and',
    '          whether it is stale (built more than 24 hours ago).',
    '  diff    Compare current graph.json with .last-build-snapshot.json.',
    '          Returns added, removed, and changed nodes and edges.',
    '',
    'Examples:',
    '  gsd graph build                        Build the graph from .gsd/ artifacts',
    '  gsd graph status                       Check graph age and node/edge counts',
    '  gsd graph query auth                   Find nodes related to "auth"',
    '  gsd graph diff                         Show changes since last snapshot',
  ].join('\n'),

  hermes: [
    'Usage: gsd hermes install [options]',
    '',
    'Install the bundled open-gsd-hermes plugin into Hermes Agent.',
    '',
    'Options:',
    '  --hermes-home <path>    Hermes home (default: $HERMES_HOME or ~/.hermes)',
    '  --project <path>        Default GSD project to write into gsd.yaml',
    '  --plugin-source <path>  Override bundled integrations/hermes source',
    '  --skip-pip             Copy plugin only; do not pip install editable package',
    '  --skip-enable          Do not run hermes plugins enable',
    '  --dry-run              Print intended actions without writing',
    '',
    'Examples:',
    '  gsd hermes install --project ~/code/myapp',
    '  HERMES_HOME=~/.hermes gsd hermes install --skip-enable',
  ].join('\n'),

  read: [
    'Usage: gsd read <progress|roadmap|memory> --json --project <path>',
    '',
    'JSON read seam for external integrations (e.g. open-gsd-hermes).',
    'Emits envelope: { integration_version, kind, projectDir, data }.',
    '',
    'Examples:',
    '  gsd read progress --json --project ~/code/myapp',
    '  gsd read roadmap --json --project ~/code/myapp --milestone M001',
    '  gsd read memory --json --project ~/code/myapp --query auth',
  ].join('\n'),

  quick: [
    'Usage: gsd quick [headless flags] <task description>',
    '',
    'Execute a quick task without the TUI. This is an alias for:',
    '  gsd headless quick <task description>',
    '',
    'Use --output-format json for a structured result containing the task',
    'number, slug, branch, summary artifact, resulting commit SHAs, and exit code.',
    '',
    'Examples:',
    '  gsd quick "fix the login button on mobile"',
    '  gsd quick --output-format json "update the setup instructions"',
  ].join('\n'),

  headless: [
    'Usage: gsd headless [flags] [command] [args...]',
    '',
    'Run /gsd commands without the TUI. Default command: auto',
    '',
    'Flags:',
    '  --timeout N            Overall timeout in ms (default: 300000)',
    '  --json                 JSONL event stream to stdout (alias for --output-format stream-json)',
    '  --output-format <fmt>  Output format: text (default), json (structured result), stream-json (JSONL events)',
    '  --bare                 Minimal context: skip CLAUDE.md, AGENTS.md, user settings, user skills',
    '  --resume <id>          Resume a prior headless session by ID',
    '  --model ID             Override model',
    '  --thinking <level>     Override thinking level: off, minimal, low, medium, high, xhigh, max',
    '  --supervised           Forward interactive UI requests to orchestrator via stdout/stdin',
    '  --response-timeout N   Timeout (ms) for orchestrator response (default: 30000)',
    '  --answers <path>       Pre-supply answers and secrets (JSON file)',
    '  --events <types>       Filter JSONL output to specific event types (comma-separated)',
    '',
    'Commands:',
    '  auto                 Run all queued units continuously (default)',
    '  next                 Run one unit',
    '  quick <task>         Execute a quick task with atomic commits and a summary artifact',
    '  status               Show progress dashboard',
    '  new-milestone        Create a milestone from a specification document',
    '  query                JSON snapshot: state + next dispatch + costs (no LLM)',
    '',
    'new-milestone flags:',
    '  --context <path>     Path to spec/PRD file (use \'-\' for stdin)',
    '  --context-text <txt> Inline specification text',
    '  --auto               Start auto-mode after milestone creation',
    '  --verbose            Show tool calls in progress output',
    '',
    'Output formats:',
    '  text         Human-readable progress on stderr (default)',
    '  json         Collect events silently, emit structured HeadlessJsonResult on stdout at exit',
    '  stream-json  Stream JSONL events, ending with a headless_result event (same as --json)',
    '',
    'Examples:',
    '  gsd headless                                    Run /gsd auto',
    '  gsd headless next                               Run one unit',
    '  gsd headless --output-format json quick "fix typo"  Run a quick task with a structured result',
    '  gsd headless --output-format json auto           Structured JSON result on stdout',
    '  gsd headless --json status                      Machine-readable JSONL stream',
    '  gsd headless --timeout 60000                    With 1-minute timeout',
    '  gsd headless --bare auto                        Minimal context (CI/ecosystem use)',
    '  gsd headless --resume abc123 auto               Resume a prior session',
    '  gsd headless new-milestone --context spec.md    Create milestone from file',
    '  cat spec.md | gsd headless new-milestone --context -   From stdin',
    '  gsd headless new-milestone --context spec.md --auto    Create + auto-execute',
    '  gsd headless --supervised auto                     Supervised orchestrator mode',
    '  gsd headless --answers answers.json auto              With pre-supplied answers',
    '  gsd headless --events agent_end,extension_ui_request auto   Filtered event stream',
    '  gsd headless query                              Instant JSON state snapshot',
    '  gsd headless recover                            Apply verified legacy import, then assess recovery action',
    '',
    'Exit codes: 0 = success, 1 = error/timeout, 10 = blocked, 11 = cancelled',
  ].join('\n'),
}

// Alias: `gsd wt --help` → same as `gsd worktree --help`
SUBCOMMAND_HELP['wt'] = SUBCOMMAND_HELP['worktree']

export function printHelp(version: string): void {
  writeHelpHeader(version)
  process.stdout.write('Usage: gsd [options] [message...]\n\n')
  process.stdout.write('Options:\n')
  process.stdout.write('  --mode <text|json|rpc|mcp> Output mode (default: interactive)\n')
  process.stdout.write('  --print, -p              Single-shot print mode\n')
  process.stdout.write('  --continue, -c           Resume the most recent session\n')
  process.stdout.write('  --session <path|id>      Resume a specific session file or ID\n')
  process.stdout.write('  --session-dir <dir>      Store and look up sessions in a custom directory\n')
  process.stdout.write('  --worktree, -w [name]    Start in an isolated worktree (auto-named if omitted)\n')
  process.stdout.write('  --model <id>             Override model (e.g. provider/model-id)\n')
  process.stdout.write('  --thinking <level>       Override thinking level: off, minimal, low, medium, high, xhigh, max\n')
  process.stdout.write('  --no-session             Disable session persistence\n')
  process.stdout.write('  --web [path]             Start browser-only web mode\n')
  process.stdout.write('  --host <host>            Web mode bind address\n')
  process.stdout.write('  --port <port>            Web mode port\n')
  process.stdout.write('  --allowed-origins <csv>  Additional allowed web origins\n')
  process.stdout.write('  --no-auth                Disable web token auth; requires external access control\n')
  process.stdout.write('  --extension <path>       Load additional extension\n')
  process.stdout.write('  --tools <a,b,c>          Restrict available tools\n')
  process.stdout.write('  --list-models [search]   List available models and exit\n')
  process.stdout.write('  --version, -v            Print version and exit\n')
  process.stdout.write('  --help, -h               Print this help and exit\n')
  process.stdout.write('\nSubcommands:\n')
  process.stdout.write('  config                   Re-run the setup wizard\n')
  process.stdout.write('  install <source>         Install a package/extension source\n')
  process.stdout.write('  remove <source>          Remove an installed package source\n')
  process.stdout.write('  list                     List installed package sources\n')
  process.stdout.write('  update                   Update GSD to the latest version\n')
  process.stdout.write('  upgrade                  Alias for update\n')
  process.stdout.write('  sessions                 List and resume a past session\n')
  process.stdout.write('  worktree <cmd>           Manage worktrees (list, merge, clean, remove)\n')
  process.stdout.write('  auto [args]              Run auto-mode without TUI (pipeable)\n')
  process.stdout.write('  quick <task>             Execute a quick task without TUI\n')
  process.stdout.write('  headless [cmd] [args]    Run /gsd commands without TUI (default: auto)\n')
  process.stdout.write('  graph <subcommand>       Manage knowledge graph (build, query, status, diff)\n')
  process.stdout.write('  hermes install           Install the Hermes Agent plugin\n')
  process.stdout.write('\nRun gsd <subcommand> --help for subcommand-specific help.\n')
}

export function printSubcommandHelp(subcommand: string, version: string): boolean {
  const help = SUBCOMMAND_HELP[subcommand]
  if (!help) return false
  writeHelpHeader(version)
  process.stdout.write(help + '\n')
  return true
}
