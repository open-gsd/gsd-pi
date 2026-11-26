import type { ProviderStreams } from "../types.js";
import { lazyApi } from "./lazy.js";

export const googleVertexApi = (): ProviderStreams => lazyApi(() => import("./google-vertex.js"));
