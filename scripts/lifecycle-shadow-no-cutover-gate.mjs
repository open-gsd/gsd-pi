#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_FILE);
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");

export const LIFECYCLE_SHADOW_SOURCE_FILES = Object.freeze({
  status: "src/resources/extensions/gsd/tools/workflow-tool-executors.ts",
  eligibility: "src/resources/extensions/gsd/parallel-eligibility.ts",
  dispatch: "src/resources/extensions/gsd/dispatch-guard.ts",
  resolver: "src/resources/extensions/gsd/auto-dispatch.ts",
  state: "src/resources/extensions/gsd/state/derive/from-db.ts",
  validation: "src/resources/extensions/gsd/milestone-validation-verdict.ts",
  gate: "scripts/lifecycle-shadow-no-cutover-gate.mjs",
});
const SOURCE_FILES = LIFECYCLE_SHADOW_SOURCE_FILES;

const DECISION_IMPORT_POLICY = Object.freeze({
  eligibility: {
    required: new Set(["./state.js#deriveState"]),
    approved: new Set([
      "./state.js#deriveState",
      "./guided-flow.js#findMilestoneIds",
      "./gsd-db.js#isDbAvailable",
      "./gsd-db.js#getMilestoneSlices",
      "./gsd-db.js#getTasksBySliceIds",
      "./db-workspace.js#openExistingWorkflowDatabase",
    ]),
  },
  dispatch: {
    required: new Set([
      "./gsd-db.js#getAllMilestones",
      "./gsd-db.js#getMilestone",
      "./gsd-db.js#getMilestoneSliceSummaries",
    ]),
    approved: new Set([
      "./unit-id.js#parseUnitId",
      "./gsd-db.js#isDbAvailable",
      "./gsd-db.js#getAllMilestones",
      "./gsd-db.js#getMilestoneSliceSummaries",
      "./gsd-db.js#getMilestone",
      "./status-guards.js#isSkippedForDispatch",
    ]),
  },
  resolver: {
    required: new Set([
      "./gsd-db.js#isDbAvailable",
      "./gsd-db.js#getMilestone",
      "./status-guards.js#isClosedStatus",
    ]),
    approved: new Set([
      "./gsd-db.js#isDbAvailable",
      "./gsd-db.js#getMilestone",
      "./status-guards.js#isClosedStatus",
      "./worktree.js#detectWorktreeName",
    ]),
  },
  state: {
    required: new Set([
      "../../milestone-validation-verdict.js#resolveMilestoneValidationVerdict",
    ]),
    approved: new Set([
      "../../guidance.js#needsAttentionBlockerGuidance",
      "../../guidance.js#needsRemediationBlockerGuidance",
      "../../milestone-validation-verdict.js#resolveMilestoneValidationVerdict",
      // handleAllSlicesDone → buildDerivedState → loadRecentDecisionsFromDb
      // (#1720): recentDecisions come from DB/memories, not markdown.
      "../../context-store.js#queryDecisionsFromMemories",
      "../../context-store.js#queryDecisions",
    ]),
  },
  validation: {
    required: new Set(["./gsd-db.js#getLatestAssessmentByScope"]),
    approved: new Set([
      "./gsd-db.js#getLatestAssessmentByScope",
      "./gsd-db.js#isDbAvailable",
      "./verdict-parser.js#isValidMilestoneVerdict",
    ]),
  },
});

const TEST_ROOT = "src/resources/extensions/gsd/tests";

function witness(id, file, title) {
  return { id, file: `${TEST_ROOT}/${file}`, title };
}

export const LIFECYCLE_SHADOW_BEHAVIORAL_WITNESSES = Object.freeze([
  witness("runtime-disagreement", "semantic-shadow-no-cutover.test.ts",
    "legacy milestone status remains public when canonical lifecycle disagrees"),
  witness("same-status-repair", "adopted-lifecycle-bypass-closure.test.ts",
    "same-status completion timestamp repair remains available when adopted state is aligned"),
  witness("park-unpark", "park-db-sync.test.ts", "unparkMilestone updates DB status to 'active' (#2694)"),
  witness("discard", "park-milestone.test.ts",
    "discardMilestone removes DB rows, worktree, and milestone branch"),
  witness("skipped-dispatch", "dispatch-guard-closed-status.test.ts",
    "skipped prior DB slices do not block later slice dispatch"),
  witness("db-unavailable-dispatch", "dispatch-guard-closed-status.test.ts",
    "DB-unavailable dispatch fails closed without trusting milestone SUMMARY"),
  witness("db-unavailable-resolver", "dispatch-guard-closed-status.test.ts",
    "resolveDispatch fails closed for a concrete milestone when the DB is unavailable"),
  witness("db-unavailable-resolver-no-active", "dispatch-guard-closed-status.test.ts",
    "resolveDispatch fails closed for a concrete milestone without active state"),
  witness("resolve-dispatch-authority", "semantic-shadow-no-cutover.test.ts",
    "resolveDispatch keeps legacy milestone status authoritative when canonical lifecycle disagrees"),
  witness("db-unavailable-status", "milestone-status-tool.test.ts",
    "gsd_milestone_status handles missing DB gracefully"),
  witness("state-derivation-authority", "semantic-shadow-no-cutover.test.ts",
    "legacy validation assessment steers state when canonical lifecycle disagrees"),
]);

export function parseArgs(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    if (arg !== "--" && arg !== "--json") throw new Error(`Unknown argument: ${arg}`);
  }
  return { json: argv.includes("--json") };
}

function parseSource(file, source) {
  const kind = file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n");
    throw new Error(`${file} could not be parsed: ${message}`);
  }
  return sourceFile;
}

function nodeName(node) {
  if (!node?.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

function functionMap(sourceFile) {
  const functions = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return functions;
}

function importMap(sourceFile) {
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) imports.set(clause.name.text, { imported: "default", module });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        imports.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          module,
        });
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imports.set(clause.namedBindings.name.text, { imported: "*", module });
    }
  }
  return imports;
}

function bindingMap(sourceFile) {
  const bindings = importMap(sourceFile);
  const declarations = [];
  function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name)) {
        let binding = null;
        if (ts.isIdentifier(declaration.initializer)) {
          binding = bindings.get(declaration.initializer.text) ?? null;
        } else if (
          ts.isPropertyAccessExpression(declaration.initializer)
          && ts.isIdentifier(declaration.initializer.expression)
        ) {
          const namespace = bindings.get(declaration.initializer.expression.text);
          if (namespace) binding = { ...namespace, imported: declaration.initializer.name.text };
        }
        if (binding && !bindings.has(declaration.name.text)) {
          bindings.set(declaration.name.text, binding);
          changed = true;
        }
      } else if (ts.isObjectBindingPattern(declaration.name) && ts.isIdentifier(declaration.initializer)) {
        const namespace = bindings.get(declaration.initializer.text);
        if (!namespace) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
            ? element.propertyName.text
            : element.name.text;
          if (!bindings.has(element.name.text)) {
            bindings.set(element.name.text, { ...namespace, imported });
            changed = true;
          }
        }
      }
    }
  }
  return bindings;
}

function variableInitializers(root) {
  const initializers = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return initializers;
}

function dependencyFacts(roots, initializers) {
  const calls = new Set();
  const memberCalls = [];
  const identifiers = new Set();
  const sql = [];
  const expanded = new Set();

  function visit(node) {
    if (ts.isIdentifier(node)) {
      identifiers.add(node.text);
      const initializer = initializers.get(node.text);
      if (initializer && !expanded.has(node.text)) {
        expanded.add(node.text);
        visit(initializer);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text);
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
    ) {
      memberCalls.push({ receiver: node.expression.expression.text, member: node.expression.name.text });
    }
    if (ts.isStringLiteralLike(node) && /workflow_item_lifecycles/i.test(node.text)) sql.push(node.text);
    ts.forEachChild(node, visit);
  }

  for (const root of roots) visit(root);
  return { calls, memberCalls, identifiers, sql };
}

function namedProperties(root, propertyName) {
  const matches = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && nodeName(node) === propertyName) matches.push(node.initializer);
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === propertyName) {
      matches.push(node.name);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function responseMutationValues(root, responseIdentifiers) {
  const values = [];
  function responseRoot(node) {
    let current = node;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    }
    return ts.isIdentifier(current) ? current.text : null;
  }
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "Object"
      && node.expression.name.text === "assign"
      && node.arguments[0]
      && responseIdentifiers.has(responseRoot(node.arguments[0]))
    ) {
      values.push(...node.arguments.slice(1));
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && responseIdentifiers.has(responseRoot(node.left))
    ) {
      values.push(node.right);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return values;
}

function isCanonicalImport(binding) {
  if (!binding) return false;
  return /lifecycle-shadow|lifecycle-commands|workflow-item-lifecycle/i.test(binding.module)
    || /LifecycleShadow|WorkflowItemLifecycle|get.*Lifecycle/i.test(binding.imported);
}

function importBindingKey(binding) {
  return binding ? `${binding.module}#${binding.imported}` : null;
}

function analyzeStatusBoundary(source) {
  const file = SOURCE_FILES.status;
  const sourceFile = parseSource(file, source);
  const fn = functionMap(sourceFile).get("executeMilestoneStatus");
  if (!fn?.body) throw new Error("executeMilestoneStatus is missing");

  const responseRoots = namedProperties(fn.body, "response");
  if (responseRoots.length === 0) throw new Error("executeMilestoneStatus has no response boundary");
  const initializers = variableInitializers(fn.body);
  const initialFacts = dependencyFacts(responseRoots, initializers);
  const mutationValues = responseMutationValues(fn.body, initialFacts.identifiers);
  const facts = dependencyFacts([...responseRoots, ...mutationValues], initializers);
  const imports = bindingMap(sourceFile);
  for (const required of ["getMilestone", "getSliceStatusSummary", "getSliceTaskCounts"]) {
    if (!facts.calls.has(required)) throw new Error(`status response lost legacy witness ${required}`);
  }
  for (const call of facts.calls) {
    if (isCanonicalImport(imports.get(call))) {
      throw new Error(`canonical lifecycle call ${call} reaches the public status response`);
    }
  }
  for (const call of facts.memberCalls) {
    const binding = imports.get(call.receiver);
    if (binding && isCanonicalImport({ ...binding, imported: call.member })) {
      throw new Error(`canonical lifecycle call ${call.receiver}.${call.member} reaches the public status response`);
    }
  }
  if (facts.identifiers.has("shadowSnapshot") || facts.sql.length > 0) {
    throw new Error("canonical lifecycle evidence reaches the public status response");
  }
}

function functionClosureFactsFromRoots(sourceFile, initialRoots) {
  const functions = functionMap(sourceFile);
  const roots = [...initialRoots];
  const visited = new Set();

  function addFunction(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const fn = functions.get(name);
    if (!fn?.body) return;
    roots.push(fn.body);
    const direct = dependencyFacts([fn.body], new Map());
    for (const call of direct.calls) {
      if (functions.has(call)) addFunction(call);
    }
  }

  for (const root of initialRoots) {
    const direct = dependencyFacts([root], new Map());
    for (const call of direct.calls) {
      if (functions.has(call)) addFunction(call);
    }
  }
  return dependencyFacts(roots, new Map());
}

function assertDecisionBoundary(entryName, imports, facts, importPolicy) {
  const reachedImports = new Set();
  for (const call of facts.calls) {
    const bindingKey = importBindingKey(imports.get(call));
    if (bindingKey) reachedImports.add(bindingKey);
  }
  for (const call of facts.memberCalls) {
    const binding = imports.get(call.receiver);
    const bindingKey = importBindingKey(
      binding?.imported === "*" ? { ...binding, imported: call.member } : null,
    );
    if (bindingKey) reachedImports.add(bindingKey);
  }
  for (const required of importPolicy.required) {
    if (!reachedImports.has(required)) throw new Error(`${entryName} lost decision witness ${required}`);
  }
  for (const call of facts.calls) {
    const binding = imports.get(call);
    if (isCanonicalImport(binding)) {
      throw new Error(`${entryName} calls canonical lifecycle binding ${call}`);
    }
    const bindingKey = importBindingKey(binding);
    if (bindingKey && !importPolicy.approved.has(bindingKey)) {
      throw new Error(`${entryName} calls unapproved imported decision binding ${bindingKey}`);
    }
  }
  for (const call of facts.memberCalls) {
    const binding = imports.get(call.receiver);
    const memberBinding = binding?.imported === "*"
      ? { ...binding, imported: call.member }
      : null;
    if (memberBinding && isCanonicalImport(memberBinding)) {
      throw new Error(`${entryName} calls canonical lifecycle binding ${call.receiver}.${call.member}`);
    }
    const bindingKey = importBindingKey(memberBinding);
    if (bindingKey && !importPolicy.approved.has(bindingKey)) {
      throw new Error(`${entryName} calls unapproved imported decision binding ${bindingKey}`);
    }
  }
  if (facts.sql.length > 0) throw new Error(`${entryName} queries canonical lifecycle rows`);
}

function functionClosureFacts(sourceFile, entryNames) {
  const functions = functionMap(sourceFile);
  const roots = entryNames.map((name) => {
    const fn = functions.get(name);
    if (!fn?.body) throw new Error(`decision function ${name} is missing`);
    return fn.body;
  });
  return functionClosureFactsFromRoots(sourceFile, roots);
}

function analyzeDecisionBoundary(file, source, entryNames, importPolicy) {
  const sourceFile = parseSource(file, source);
  assertDecisionBoundary(
    entryNames[0],
    bindingMap(sourceFile),
    functionClosureFacts(sourceFile, entryNames),
    importPolicy,
  );
}

function analyzeResolveDispatchBoundary(source) {
  const sourceFile = parseSource(SOURCE_FILES.resolver, source);
  const fn = functionMap(sourceFile).get("resolveDispatch");
  if (!fn?.body) throw new Error("resolveDispatch is missing");
  const guardStatements = [];
  for (const statement of fn.body.statements) {
    if (ts.isTryStatement(statement)) break;
    guardStatements.push(statement);
  }
  assertDecisionBoundary(
    "resolveDispatch",
    bindingMap(sourceFile),
    functionClosureFactsFromRoots(sourceFile, guardStatements),
    DECISION_IMPORT_POLICY.resolver,
  );
}

function propertyChain(node) {
  const parts = [];
  let current = node;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text);
  return parts;
}

export function analyzeLocalInputBoundary(source) {
  const sourceFile = parseSource(SOURCE_FILES.gate, source);
  const imports = bindingMap(sourceFile);
  const initializers = variableInitializers(sourceFile);
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && /github|octokit|hosted-review/i.test(statement.moduleSpecifier.text)
    ) {
      throw new Error(`hosted metadata client import is forbidden: ${statement.moduleSpecifier.text}`);
    }
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && /^(node:)?(http|https|net|tls)$/.test(statement.moduleSpecifier.text)
    ) {
      throw new Error(`external network import is forbidden: ${statement.moduleSpecifier.text}`);
    }
  }

  function staticStrings(node, seen = new Set()) {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return [];
      const initializer = initializers.get(node.text);
      if (!initializer) return [];
      return staticStrings(initializer, new Set([...seen, node.text]));
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element) => staticStrings(element, seen));
    }
    return [];
  }

  function isChildProcessCall(node) {
    const isChildProcessModule = (module) => module === "child_process" || module === "node:child_process";
    if (ts.isIdentifier(node.expression)) {
      return isChildProcessModule(imports.get(node.expression.text)?.module);
    }
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      return isChildProcessModule(imports.get(node.expression.expression.text)?.module);
    }
    return false;
  }

  const environmentAliases = new Set();
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    function collectEnvironmentAliases(node) {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && (
          propertyChain(node.initializer).join(".") === "process.env"
          || (ts.isIdentifier(node.initializer) && environmentAliases.has(node.initializer.text))
        )
        && !environmentAliases.has(node.name.text)
      ) {
        environmentAliases.add(node.name.text);
        aliasesChanged = true;
      }
      ts.forEachChild(node, collectEnvironmentAliases);
    }
    collectEnvironmentAliases(sourceFile);
  }

  function isEnvironmentExpression(node) {
    return propertyChain(node).join(".") === "process.env"
      || (ts.isIdentifier(node) && environmentAliases.has(node.text));
  }

  function visit(node) {
    if (ts.isPropertyAccessExpression(node)) {
      const chain = propertyChain(node);
      const isDelete = ts.isDeleteExpression(node.parent);
      if (!isDelete && chain[0] === "process" && chain[1] === "env" && /^(GITHUB_|GH_)/.test(chain[2] ?? "")) {
        throw new Error(`hosted metadata environment read is forbidden: ${chain.join(".")}`);
      }
      if (
        !isDelete
        && ts.isIdentifier(node.expression)
        && environmentAliases.has(node.expression.text)
        && /^(GITHUB_|GH_)/.test(node.name.text)
      ) {
        throw new Error(`hosted metadata environment read is forbidden: ${node.expression.text}.${node.name.text}`);
      }
    }
    if (
      ts.isElementAccessExpression(node)
      && isEnvironmentExpression(node.expression)
      && !ts.isDeleteExpression(node.parent)
    ) {
      const keys = staticStrings(node.argumentExpression);
      if (keys.length !== 1 || /^(GITHUB_|GH_)/.test(keys[0])) {
        throw new Error(`hosted metadata environment read is forbidden: process.env.${keys[0] ?? "[computed]"}`);
      }
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && isEnvironmentExpression(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const key = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
          ? element.propertyName.text
          : ts.isIdentifier(element.name) ? element.name.text : null;
        if (!key || /^(GITHUB_|GH_)/.test(key)) {
          throw new Error(`hosted metadata environment read is forbidden: process.env.${key ?? "[computed]"}`);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      throw new Error("external network call is forbidden");
    }
    if (ts.isCallExpression(node) && isChildProcessCall(node)) {
      const literals = node.arguments.flatMap((argument) => staticStrings(argument));
      if (literals.some((literal) => literal === "gh" || /(^|\s)--?(label|tag)|releases?|pull-request|pr-metadata/i.test(literal))) {
        throw new Error("hosted metadata child command is forbidden");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function analyzeValidationAssessmentBoundary(source) {
  analyzeDecisionBoundary(
    SOURCE_FILES.validation,
    source,
    ["readMilestoneValidationVerdict", "resolveMilestoneValidationVerdict"],
    DECISION_IMPORT_POLICY.validation,
  );
  const sourceFile = parseSource(SOURCE_FILES.validation, source);
  const functions = functionMap(sourceFile);
  for (const functionName of ["readMilestoneValidationVerdict", "resolveMilestoneValidationVerdict"]) {
    const body = functions.get(functionName)?.body;
    if (!body) throw new Error(`${functionName} is missing`);
    let readsOmitted = false;
    function visit(node) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "omitted") {
        readsOmitted = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(body);
    if (readsOmitted) {
      throw new Error(`${functionName} cannot promote omitted compatibility state into validation authority`);
    }
  }
}

export function analyzeLifecycleShadowSources(sources) {
  const checks = [
    ["status-response-authority", () => analyzeStatusBoundary(sources.status)],
    ["parallel-eligibility-authority", () => analyzeDecisionBoundary(
      SOURCE_FILES.eligibility,
      sources.eligibility,
      ["analyzeParallelEligibility"],
      DECISION_IMPORT_POLICY.eligibility,
    )],
    ["slice-dispatch-authority", () => analyzeDecisionBoundary(
      SOURCE_FILES.dispatch,
      sources.dispatch,
      ["getPriorSliceCompletionBlocker"],
      DECISION_IMPORT_POLICY.dispatch,
    )],
    ["dispatch-resolver-no-canonical-read", () => analyzeResolveDispatchBoundary(sources.resolver)],
    ["state-derivation-authority", () => analyzeDecisionBoundary(
      SOURCE_FILES.state,
      sources.state,
      ["handleAllSlicesDone"],
      DECISION_IMPORT_POLICY.state,
    )],
    ["validation-assessment-authority", () => analyzeValidationAssessmentBoundary(sources.validation)],
    ["closed-local-inputs", () => analyzeLocalInputBoundary(sources.gate)],
  ];

  return checks.map(([id, check]) => {
    try {
      check();
      return { id, verdict: "pass", error: null };
    } catch (error) {
      return {
        id,
        verdict: "fail",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function localChildEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.NODE_TEST_CONTEXT;
  for (const key of Object.keys(childEnvironment)) {
    if (key.startsWith("GITHUB_") || key.startsWith("GH_")) delete childEnvironment[key];
  }
  return childEnvironment;
}

function commandForTestFile(file) {
  const resolver = "src/resources/extensions/gsd/tests/resolve-ts.mjs";
  const reportedArgs = [
    "--import",
    `./${resolver}`,
    "--experimental-strip-types",
    "--test",
    "--test-reporter=tap",
    file,
  ];
  const args = reportedArgs.map((argument, index) => {
    if (index === 1) return join(REPO_ROOT, resolver);
    if (index === 5 && !isAbsolute(argument)) return join(REPO_ROOT, argument);
    return argument;
  });
  return {
    executable: process.execPath,
    args,
    text: ["node", ...reportedArgs].map((part) => JSON.stringify(part)).join(" "),
  };
}

function titlePassed(tap, title) {
  return tap.split(/\r?\n/).some((line) => {
    const marker = line.trim().match(/^ok \d+ - (.*)$/)?.[1];
    return marker?.replaceAll("\\#", "#") === title;
  });
}

function runBehaviorWitness(witness, { now, spawnSyncImpl, environment }) {
  const command = commandForTestFile(witness.file);
  const startedAt = now();
  const child = spawnSyncImpl(command.executable, command.args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: localChildEnvironment(environment),
    maxBuffer: 50 * 1024 * 1024,
    timeout: 180_000,
  });
  const passed = child.status === 0 && !child.error && titlePassed(child.stdout ?? "", witness.title);
  return {
    command: command.text,
    verdict: passed ? "pass" : "fail",
    exitCode: Number.isInteger(child.status) ? child.status : null,
    durationMs: Math.max(0, Math.round(now() - startedAt)),
    signal: child.signal ?? null,
    error: child.error?.message ?? (child.status === 0 && !passed
      ? `missing runnable witness: ${witness.title}`
      : null),
  };
}

function loadRepositorySources(sourceLoader) {
  return Object.fromEntries(Object.entries(SOURCE_FILES).map(([id, file]) => [id, sourceLoader(file)]));
}

export function runLifecycleShadowNoCutoverGate({
  sourceLoader = (file) => {
    // allow-source-grep: production text is parsed as a TypeScript AST for binding-flow checks.
    return readFileSync(join(REPO_ROOT, file), "utf8");
  },
  spawnSyncImpl = spawnSync,
  now = () => performance.now(),
  environment = process.env,
  witnesses = LIFECYCLE_SHADOW_BEHAVIORAL_WITNESSES,
} = {}) {
  let sources;
  try {
    sources = loadRepositorySources(sourceLoader);
  } catch (error) {
    return {
      schemaVersion: 1,
      verdict: "fail",
      structuralChecks: [{
        id: "closed-source-inventory",
        verdict: "fail",
        error: error instanceof Error ? error.message : String(error),
      }],
      behavioralChecks: [],
      githubMetadataUsed: false,
    };
  }

  const structuralChecks = analyzeLifecycleShadowSources(sources);
  const behavioralChecks = [];
  for (const witness of witnesses) {
    try {
      sourceLoader(witness.file);
      behavioralChecks.push({
        ...witness,
        ...runBehaviorWitness(witness, { now, spawnSyncImpl, environment }),
      });
    } catch (error) {
      behavioralChecks.push({
        id: witness.id,
        file: witness.file,
        title: witness.title,
        verdict: "fail",
        command: null,
        exitCode: null,
        durationMs: 0,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const verdict = structuralChecks.every((check) => check.verdict === "pass")
    && behavioralChecks.length === witnesses.length
    && behavioralChecks.every((check) => check.verdict === "pass")
    ? "pass"
    : "fail";
  return {
    schemaVersion: 1,
    verdict,
    structuralChecks,
    behavioralChecks,
    githubMetadataUsed: false,
  };
}

export function exitCodeForReport(report) {
  return report.verdict === "pass" ? 0 : 1;
}

export function renderSummary(report) {
  const structuralPassed = report.structuralChecks.filter((check) => check.verdict === "pass").length;
  const behavioralPassed = report.behavioralChecks.filter((check) => check.verdict === "pass").length;
  const lines = [
    "Lifecycle shadow no-cutover gate",
    `Status: ${report.verdict.toUpperCase()}`,
    `Structural: ${structuralPassed}/${report.structuralChecks.length}`,
    `Behavioral: ${behavioralPassed}/${report.behavioralChecks.length}`,
    "GitHub metadata used: no",
    "",
  ];
  for (const check of [...report.structuralChecks, ...report.behavioralChecks]) {
    lines.push(`${check.id}: ${check.verdict.toUpperCase()}`);
    if (check.error) lines.push(`  ${check.error}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  try {
    const options = parseArgs();
    const report = runLifecycleShadowNoCutoverGate();
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderSummary(report));
    process.exitCode = exitCodeForReport(report);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
