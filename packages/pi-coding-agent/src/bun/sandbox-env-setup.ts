import { restoreSandboxEnv } from "./restore-sandbox-env.js";

// Restore the environment before evaluating modules that read it at startup.
restoreSandboxEnv();
