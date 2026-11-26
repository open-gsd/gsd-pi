import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const googleGenerativeAIApi = (): ProviderStreams => lazyApi(() => import("./google-generative-ai.js"));
