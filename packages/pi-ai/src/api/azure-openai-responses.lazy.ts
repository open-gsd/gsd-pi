import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const azureOpenAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./azure-openai-responses.js"));
