import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider, type Provider } from "../models.js";
import { TYPESAFE_CLASSIFIER_MODELS } from "./typesafe.models.js";

export function typesafeProvider(): Provider {
	return createProvider({
		id: "typesafe",
		name: "TypeSafe",
		auth: {
			apiKey: envApiKeyAuth("TypeSafe API key", ["TYPESAFE_API_KEY"]),
		},
		models: Object.values(TYPESAFE_CLASSIFIER_MODELS),
		classifiers: {
			"typesafe-system-one": typesafeSystemOneApi(),
		},
	});
}
