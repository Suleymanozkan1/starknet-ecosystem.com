export interface Evidence {
  /** Path relative to the nebula-frontier root. */
  file: string;
  /** Regex (multiline) that must match the file content. */
  pattern?: string;
}

export interface Requirement {
  id: string;
  category: string;
  requirement: string;
  expected: string;
  impl: Evidence[];
  integration?: Evidence[];
  test?: Evidence[];
  /** Key into docs/audit/runtime-results.json. */
  runtime?: string;
  /** Docs/config-only requirements that don't need automated tests. */
  testExempt?: boolean;
  /** External constraint that prevents verification. */
  blocked?: string;
  /** Known gap forcing PARTIAL even if evidence exists. */
  partial?: string;
  notes?: string;
}

export const ev = (file: string, pattern?: string): Evidence => (pattern ? { file, pattern } : { file });
