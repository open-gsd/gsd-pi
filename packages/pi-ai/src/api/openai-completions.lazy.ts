import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const openAICompletionsApi = (): ProviderStreams => lazyApi(() => import("./openai-completions.js"));
