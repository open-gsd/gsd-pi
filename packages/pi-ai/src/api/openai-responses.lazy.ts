import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const openAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-responses.js"));
