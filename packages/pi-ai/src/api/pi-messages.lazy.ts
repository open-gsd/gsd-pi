import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const piMessagesApi = (): ProviderStreams => lazyApi(() => import("./pi-messages.js"));
