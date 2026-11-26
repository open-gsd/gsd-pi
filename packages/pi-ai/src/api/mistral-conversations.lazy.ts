import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const mistralConversationsApi = (): ProviderStreams => lazyApi(() => import("./mistral-conversations.js"));
