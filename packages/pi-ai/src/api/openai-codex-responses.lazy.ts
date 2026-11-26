import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const openAICodexResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-codex-responses.js"));
