/**
 * Bash Command Extraction Module
 *
 * Uses tree-sitter to parse a raw bash command string and extract every
 * command unit that must be checked by the policy engine. Supports simple
 * commands, chained commands (&&, ||, ;), pipelines (|, |&), subshells,
 * command substitutions, and redirected statements.
 *
 * Tree-sitter dependencies are installed via the Pi agent npm package at
 * `llm-tooling/pi/agent/npm/`.
 */

import type { SyntaxNode } from "tree-sitter";
import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";

// Lazily initialised parser (first-call only)
let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    // tree-sitter-bash exports a Language-compatible object
    parser.setLanguage(Bash as unknown as Parser.Language);
  }
  return parser;
}

/**
 * Node types that represent a simple command unit (name + args), without
 * redirects or pipelines.
 */
const SIMPLE_COMMAND_TYPES = new Set(["command", "declaration_command"]);

/**
 * Structural boundaries that cut the command context so their contents
 * are extracted as independent command units.
 */
const STRUCTURAL_BOUNDARY_TYPES = new Set(["subshell", "command_substitution"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  /** Extracted command-unit strings, each policy-matchable. */
  commands: string[];
  /**
   * Error message when extraction or parsing fails.
   * Non-null means fail-closed — the caller should block.
   */
  error: string | null;
}

/**
 * Parse a raw bash command string and extract every command unit.
 *
 * @param input - The raw bash command string.
 * @returns An ExtractionResult with extracted commands or an error.
 */
export function extractCommands(input: string): ExtractionResult {
  if (input.length === 0) {
    return { commands: [], error: null };
  }

  try {
    const parser = getParser();
    const tree = parser.parse(input);
    const root = tree.rootNode;

    // Fail-closed: ERROR or MISSING nodes indicate syntax tree-sitter
    // couldn't fully parse.  `hasError` is true when any descendant
    // node is an ERROR or MISSING synthetic node.
    if (root.hasError) {
      return { commands: [], error: "Parse failure: malformed syntax" };
    }

    const commands: string[] = [];
    walk(root, commands);
    return { commands, error: null };
  } catch (err) {
    return {
      commands: [],
      error: `Extraction error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk the tree and collect command-unit text.
 *
 * - Simple command nodes (command, declaration_command) are extracted as
 *   units, then their subtree is searched for nested structural boundaries
 *   (subshell, command_substitution) whose inner commands are also extracted.
 * - `redirected_statement` nodes are a special case: when they wrap a
 *   `pipeline`, the pipeline elements are extracted separately with
 *   redirect text appended to the last element.  Otherwise they are
 *   extracted as a single unit.
 * - Structural boundaries are entered to extract their inner commands
 *   but their own text is not extracted.
 */
function walk(node: SyntaxNode, results: string[]): void {
  const type = node.type;

  if (type === "subshell" || type === "command_substitution") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, results);
    }
    return;
  }

  if (type === "redirected_statement") {
    handleRedirectedStatement(node, results);
    return;
  }

  if (SIMPLE_COMMAND_TYPES.has(type)) {
    results.push(node.text);
    walkStructuralBoundaries(node, results);
    return;
  }

  // Recurse into children for all other node types
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, results);
  }
}

/**
 * Handle a `redirected_statement` node.
 *
 * A redirected_statement bundles a "core" (command or pipeline) with
 * zero or more redirects.  The policy engine needs the command string
 * with the redirect included, but for pipelines the elements must be
 * extracted individually.
 *
 * - If the core is a pipeline, extract each pipeline element, appending
 *   the redirect suffix to the last element.
 * - Otherwise extract the full redirected_statement text as one unit.
 */
function handleRedirectedStatement(node: SyntaxNode, results: string[]): void {
  const core = findCoreChild(node);

  if (!core) {
    // No core child found — unusual, extract full text as safety net
    results.push(node.text);
    walkStructuralBoundaries(node, results);
    return;
  }

  if (core.type === "pipeline") {
    // Pipeline inside a redirected statement: extract elements individually
    // and append the redirect suffix to the last extracted inner command.
    const redirectSuffix = node.text.slice(core.text.length);
    const elements = getPipelineElements(core);

    for (let i = 0; i < elements.length; i++) {
      const elem = elements[i];
      const isLast = i === elements.length - 1;

      addPipelineElement(elem, isLast ? redirectSuffix : "", results);
    }
  } else {
    // Simple redirect — extract the full text and search for nested boundaries
    results.push(node.text);
    walkStructuralBoundaries(node, results);
  }
}

/**
 * Add a pipeline element's extracted commands to `results`.
 *
 * The `suffix` is the redirect text that follows the pipeline inside
 * a `redirected_statement`.  It is attached to the last inner command
 * extracted from this element, regardless of element type.
 *
 * - Command-like elements: extract text + suffix.
 * - Redirected statements: handle recursively, then append suffix
 *   to the last inner result.
 * - Structural elements (subshell, etc.): walk to extract inner
 *   commands, then append suffix to the last inner result.
 */
function addPipelineElement(pipelineElement: SyntaxNode, suffix: string, results: string[]): void {
  if (SIMPLE_COMMAND_TYPES.has(pipelineElement.type)) {
    results.push(pipelineElement.text + suffix);
    walkStructuralBoundaries(pipelineElement, results);
  } else if (pipelineElement.type === "redirected_statement") {
    // Element already has its own redirects — handle recursively
    const inner: string[] = [];
    handleRedirectedStatement(pipelineElement, inner);
    if (suffix && inner.length > 0) {
      inner[inner.length - 1] += suffix;
    }
    results.push(...inner);
  } else {
    // Structural element (subshell, compound statement, etc.) —
    // walk to extract inner commands, then append suffix to the
    // last inner result
    const inner: string[] = [];
    walk(pipelineElement, inner);
    if (suffix && inner.length > 0) {
      inner[inner.length - 1] += suffix;
    }
    results.push(...inner);
  }
}

/**
 * Find the "core" child of a redirected_statement — the first child that
 * is not a redirect node (file_redirect, etc.) and not a bare operator.
 * Typically this is a `command`, `pipeline`, or sometimes `subshell` node.
 */
function findCoreChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const childType = child.type;
      if (
        childType.startsWith("file_") ||
        childType.startsWith("here") ||
        childType === "<" ||
        childType === ">"
      ) {
        continue; // skip redirect-like nodes
      }
      if (childType === ";" || childType === "|" || childType === "&&" || childType === "||") {
        continue; // skip bare operators (shouldn't appear here but safe net)
      }
      return child;
    }
  }
  return null;
}

/**
 * Collect ALL children of a `pipeline` node in order, skipping pipe
 * operators (`|`, `|&`).  Unlike `getPipelineCommands`, this also
 * returns `subshell`, `if_statement`, `for_statement`, etc. so that
 * structural pipeline elements are not silently dropped.
 */
function getPipelineElements(node: SyntaxNode): SyntaxNode[] {
  const elements: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type !== "|" && child.type !== "|&") {
      elements.push(child);
    }
  }
  return elements;
}

/**
 * Find and walk into every structural boundary (subshell, command_substitution)
 * nested within `node`.  This ensures that commands inside nested constructs
 * are extracted even when the outer command has already been added.
 */
function walkStructuralBoundaries(node: SyntaxNode, results: string[]): void {
  function findBoundaries(currentNode: SyntaxNode): void {
    for (let i = 0; i < currentNode.childCount; i++) {
      const child = currentNode.child(i);
      if (child) {
        if (STRUCTURAL_BOUNDARY_TYPES.has(child.type)) {
          walk(child, results);
        } else {
          findBoundaries(child);
        }
      }
    }
  }
  findBoundaries(node);
}
