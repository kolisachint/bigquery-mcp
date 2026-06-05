/**
 * SQL query safety validation.
 *
 * Direct port of the Python `query_safety.py` so the Node control plane and the
 * Python worker enforce identical rules. Only read-only SELECT / WITH queries
 * are permitted; comments are stripped to prevent bypassing the checks.
 */

const DANGEROUS_KEYWORDS = [
  // Data modification
  "DELETE",
  "UPDATE",
  "INSERT",
  "MERGE",
  "TRUNCATE",
  // Schema modification
  "DROP",
  "CREATE",
  "ALTER",
  // Permission and security
  "GRANT",
  "REVOKE",
  // System operations
  "EXEC",
  "EXECUTE",
  "CALL",
  // Export operations (could be used for data exfiltration)
  "EXPORT",
];

/**
 * Detect multiple statements by counting semicolons outside quotes/backticks.
 * Allows a single trailing semicolon but rejects content after a semicolon or
 * more than one semicolon outside of quotes.
 */
function hasMultipleStatementsOutsideQuotes(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let i = 0;
  let semicolonCount = 0;
  const length = sql.length;

  while (i < length) {
    const ch = sql[i];
    if (ch === "'" && !inDouble && !inBacktick) {
      // Handle doubled single quotes ('') inside string literals.
      if (i + 1 < length && sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
    } else if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
    } else if (ch === ";" && !inSingle && !inDouble && !inBacktick) {
      semicolonCount += 1;
    }
    i += 1;
  }

  if (semicolonCount === 0) return false;
  if (semicolonCount >= 2) return true;

  // Exactly one semicolon: allow only if it is trailing (ignoring whitespace).
  const lastIndex = sql.lastIndexOf(";");
  return sql.slice(lastIndex + 1).trim().length > 0;
}

export interface SafetyResult {
  safe: boolean;
  error: string;
}

export function isQuerySafe(query: string): SafetyResult {
  if (!query || query.trim() === "") {
    return { safe: false, error: "Empty query is not allowed." };
  }

  let queryUpper = query.toUpperCase().trim();
  // Remove line comments (-- comment).
  queryUpper = queryUpper.replace(/--.*/g, "");
  // Remove block comments (/* comment */), spanning newlines.
  queryUpper = queryUpper.replace(/\/\*[\s\S]*?\*\//g, "");
  queryUpper = queryUpper.trim();

  if (queryUpper === "") {
    return { safe: false, error: "Query contains only comments, no actual SQL statement." };
  }

  const allowedStart = /^\s*SELECT\b/.test(queryUpper) || /^\s*WITH\b/.test(queryUpper);
  if (!allowedStart) {
    const first = queryUpper.split(/\s+/)[0] || "unknown";
    return {
      safe: false,
      error: `Only SELECT and WITH queries are allowed for safety. Query starts with: ${first}`,
    };
  }

  if (hasMultipleStatementsOutsideQuotes(queryUpper)) {
    return {
      safe: false,
      error:
        "Multiple SQL statements are not allowed. Please execute one SELECT or WITH query at a time.",
    };
  }

  for (const keyword of DANGEROUS_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`);
    if (re.test(queryUpper)) {
      return {
        safe: false,
        error: `Query contains dangerous keyword '${keyword}'. Only read-only SELECT and WITH queries are allowed.`,
      };
    }
  }

  return { safe: true, error: "" };
}
