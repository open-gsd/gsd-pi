import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.js"));
