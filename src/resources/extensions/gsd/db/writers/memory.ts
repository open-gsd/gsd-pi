// Project/App: gsd-pi
// File Purpose: Memory-store writers for the single-writer layer.
// All memory writes go through the single-writer layer so the invariant
// holds. Direct pass-throughs to the SQL previously in memory-store.ts —
// same bindings, same behavior. Reads the shared engine handle via
// getDb(); contains only write SQL.
import { getDb, transaction } from "../engine.js";

export function insertMemoryRow(args: {
  id: string;
  category: string;
  content: string;
  confidence: number;
  sourceUnitType: string | null;
  sourceUnitId: string | null;
  createdAt: string;
  updatedAt: string;
  scope?: string;
  tags?: string[];
  /**
   * ADR-013 Step 2: optional structured payload preserved alongside the flat
   * `content` field. Used to retain gsd_save_decision-style fields (scope,
   * decision, choice, rationale, made_by, revisable) on architecture-category
   * memories so the cutover in Step 6 is lossless. Schema is intentionally
   * open inside the JSON; documented per category in ADR-013.
   */
  structuredFields?: Record<string, unknown> | null;
}): void {
  transaction(() => getDb().prepare(
    `INSERT INTO memories (id, category, content, confidence, source_unit_type, source_unit_id, created_at, updated_at, scope, tags, structured_fields)
     VALUES (:id, :category, :content, :confidence, :source_unit_type, :source_unit_id, :created_at, :updated_at, :scope, :tags, :structured_fields)`,
  ).run({
    ":id": args.id,
    ":category": args.category,
    ":content": args.content,
    ":confidence": args.confidence,
    ":source_unit_type": args.sourceUnitType,
    ":source_unit_id": args.sourceUnitId,
    ":created_at": args.createdAt,
    ":updated_at": args.updatedAt,
    ":scope": args.scope ?? "project",
    ":tags": JSON.stringify(args.tags ?? []),
    ":structured_fields": args.structuredFields == null ? null : JSON.stringify(args.structuredFields),
  }));
}

export function insertMemorySourceRow(args: {
  id: string;
  kind: string;
  uri: string | null;
  title: string | null;
  content: string;
  contentHash: string;
  importedAt: string;
  scope?: string;
  tags?: string[];
}): void {
  transaction(() => getDb().prepare(
    `INSERT OR IGNORE INTO memory_sources (id, kind, uri, title, content, content_hash, imported_at, scope, tags)
     VALUES (:id, :kind, :uri, :title, :content, :content_hash, :imported_at, :scope, :tags)`,
  ).run({
    ":id": args.id,
    ":kind": args.kind,
    ":uri": args.uri,
    ":title": args.title,
    ":content": args.content,
    ":content_hash": args.contentHash,
    ":imported_at": args.importedAt,
    ":scope": args.scope ?? "project",
    ":tags": JSON.stringify(args.tags ?? []),
  }));
}

export function deleteMemorySourceRow(id: string): boolean {
  return transaction(() => {
    const result = getDb()
      .prepare("DELETE FROM memory_sources WHERE id = :id")
      .run({ ":id": id }) as { changes?: number };
    return (result?.changes ?? 0) > 0;
  });
}

export function upsertMemoryEmbedding(args: {
  memoryId: string;
  model: string;
  dim: number;
  vector: Uint8Array;
  updatedAt: string;
}): void {
  transaction(() => getDb().prepare(
    `INSERT INTO memory_embeddings (memory_id, model, dim, vector, updated_at)
     VALUES (:memory_id, :model, :dim, :vector, :updated_at)
     ON CONFLICT(memory_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       vector = excluded.vector,
       updated_at = excluded.updated_at`,
  ).run({
    ":memory_id": args.memoryId,
    ":model": args.model,
    ":dim": args.dim,
    ":vector": args.vector,
    ":updated_at": args.updatedAt,
  }));
}

export function deleteMemoryEmbedding(memoryId: string): boolean {
  return transaction(() => {
    const result = getDb()
      .prepare("DELETE FROM memory_embeddings WHERE memory_id = :id")
      .run({ ":id": memoryId }) as { changes?: number };
    return (result?.changes ?? 0) > 0;
  });
}

export function insertMemoryRelationRow(args: {
  fromId: string;
  toId: string;
  rel: string;
  confidence: number;
  createdAt: string;
}): void {
  transaction(() => getDb().prepare(
    `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, confidence, created_at)
     VALUES (:from_id, :to_id, :rel, :confidence, :created_at)`,
  ).run({
    ":from_id": args.fromId,
    ":to_id": args.toId,
    ":rel": args.rel,
    ":confidence": args.confidence,
    ":created_at": args.createdAt,
  }));
}

export function deleteMemoryRelationsFor(memoryId: string): void {
  transaction(() => getDb()
    .prepare("DELETE FROM memory_relations WHERE from_id = :id OR to_id = :id")
    .run({ ":id": memoryId }));
}

export function rewriteMemoryId(placeholderId: string, realId: string): void {
  transaction(() => getDb().prepare("UPDATE memories SET id = :real_id WHERE id = :placeholder").run({
    ":real_id": realId,
    ":placeholder": placeholderId,
  }));
}

export function updateMemoryContentRow(
  id: string,
  content: string,
  confidence: number | undefined,
  updatedAt: string,
): void {
  transaction(() => {
    if (confidence != null) {
      getDb().prepare(
        "UPDATE memories SET content = :content, confidence = :confidence, updated_at = :updated_at WHERE id = :id",
      ).run({ ":content": content, ":confidence": confidence, ":updated_at": updatedAt, ":id": id });
    } else {
      getDb().prepare(
        "UPDATE memories SET content = :content, updated_at = :updated_at WHERE id = :id",
      ).run({ ":content": content, ":updated_at": updatedAt, ":id": id });
    }
  });
}

export function incrementMemoryHitCount(id: string, updatedAt: string): void {
  transaction(() => getDb().prepare(
    "UPDATE memories SET hit_count = hit_count + 1, updated_at = :updated_at, last_hit_at = :last_hit_at WHERE id = :id",
  ).run({ ":updated_at": updatedAt, ":last_hit_at": updatedAt, ":id": id }));
}

export function supersedeMemoryRow(oldId: string, newId: string, updatedAt: string): void {
  transaction(() => getDb().prepare(
    "UPDATE memories SET superseded_by = :new_id, updated_at = :updated_at WHERE id = :old_id",
  ).run({ ":new_id": newId, ":updated_at": updatedAt, ":old_id": oldId }));
}

export function markMemoryUnitProcessed(
  unitKey: string,
  activityFile: string,
  processedAt: string,
): void {
  transaction(() => getDb().prepare(
    `INSERT OR IGNORE INTO memory_processed_units (unit_key, activity_file, processed_at)
     VALUES (:key, :file, :at)`,
  ).run({ ":key": unitKey, ":file": activityFile, ":at": processedAt }));
}

export function decayMemoriesBefore(cutoffTs: string, now: string): void {
  transaction(() => getDb().prepare(
    `UPDATE memories
     SET confidence = MAX(0.1, confidence - 0.1), updated_at = :now
     WHERE superseded_by IS NULL
       AND updated_at < :cutoff
       AND confidence > 0.1
       AND (structured_fields IS NULL OR structured_fields NOT LIKE '%"sourceDecisionId"%')`,
  ).run({ ":now": now, ":cutoff": cutoffTs }));
}

export function supersedeLowestRankedMemories(limit: number, now: string): void {
  transaction(() => getDb().prepare(
    `UPDATE memories SET superseded_by = 'CAP_EXCEEDED', updated_at = :now
     WHERE id IN (
       SELECT id FROM memories
       WHERE superseded_by IS NULL
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) ASC
       LIMIT :limit
     )`,
  ).run({ ":now": now, ":limit": limit }));
}

export function updateMemoryStructuredFieldsRow(
  id: string,
  structuredFields: Record<string, unknown>,
  updatedAt: string,
): void {
  transaction(() => getDb()
    .prepare("UPDATE memories SET structured_fields = :sf, updated_at = :ts WHERE id = :id")
    .run({
      ":id": id,
      ":sf": JSON.stringify(structuredFields),
      ":ts": updatedAt,
    }));
}
