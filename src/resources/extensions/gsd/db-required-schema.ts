// Project/App: gsd-pi
// File Purpose: Registry for non-versioned schema features required on every database open.

import type { DbAdapter } from "./db-adapter.js";
import {
  createLivenessBackstopSchema,
  hasLivenessBackstopSchema,
} from "./db-liveness-backstop-schema.js";

interface RequiredSchemaFeature {
  readonly id: string;
  readonly isPresent: (db: DbAdapter) => boolean;
  readonly create: (db: DbAdapter) => void;
}

const REQUIRED_SCHEMA_FEATURES = [
  {
    id: "liveness-backstop",
    isPresent: hasLivenessBackstopSchema,
    create: createLivenessBackstopSchema,
  },
] as const satisfies readonly RequiredSchemaFeature[];

export type RequiredSchemaFeatureId = (typeof REQUIRED_SCHEMA_FEATURES)[number]["id"];

export function createRequiredSchemaObjects(db: DbAdapter): void {
  for (const feature of REQUIRED_SCHEMA_FEATURES) feature.create(db);
}

export function hasRequiredSchemaObjects(db: DbAdapter): boolean {
  return REQUIRED_SCHEMA_FEATURES.every((feature) => feature.isPresent(db));
}

export function hasRequiredSchemaFeature(db: DbAdapter, featureId: RequiredSchemaFeatureId): boolean {
  const feature = REQUIRED_SCHEMA_FEATURES.find(({ id }) => id === featureId);
  return feature?.isPresent(db) ?? false;
}
