export type SoftwareReferenceStrength = "strong" | "contextual";

/*
 * The deterministic compiler uses this vocabulary as a safety net around the
 * prompt expert. Keep names grouped by how safely they can be recognized in
 * ordinary prose: strong terms are overwhelmingly software-specific, while
 * contextual terms also have common non-software meanings.
 */
export const SOFTWARE_TERMS = {
  languages: [
    "c#",
    "c++",
    "clojure",
    "cobol",
    "erlang",
    "f#",
    "fortran",
    "gdscript",
    "golang",
    "haskell",
    "html",
    "javascript",
    "json",
    "jsx",
    "julia lang",
    "kotlin",
    "micropython",
    "matlab",
    "nim lang",
    "ocaml",
    "objective-c",
    "odin lang",
    "php",
    "powershell",
    "prolog",
    "typescript",
    "xml",
    "visual basic",
    "visual basic .net",
    "vba",
    "vb.net",
    "wasm",
    "webassembly",
  ],
  webAndApplication: [
    "asp.net",
    "aws lambda",
    "css",
    "cuda",
    "deno",
    "django",
    "express.js",
    "expressjs",
    "fastapi",
    "htmx",
    "jquery",
    "keras",
    "laravel",
    "matplotlib",
    "nestjs",
    "next.js",
    "nextjs",
    "node.js",
    "nodejs",
    "nuxt.js",
    "nuxt",
    "nuxtjs",
    "react native",
    "rxjs",
    "ruby on rails",
    "scikit-learn",
    "scipy",
    "scss",
    "solidjs",
    "spring boot",
    "spring framework",
    "symfony",
    "tailwind css",
    "tensorflow",
    "pytorch",
    "vue.js",
    "vuejs",
    "wordpress",
  ],
  data: [
    "bigquery",
    "couchbase",
    "couchdb",
    "clickhouse",
    "cosmos db",
    "db2",
    "duckdb",
    "dynamodb",
    "elasticsearch",
    "firebase",
    "mariadb",
    "mongodb",
    "ms sql",
    "mssql",
    "mysql",
    "neo4j",
    "nosql",
    "opensearch",
    "pl/sql",
    "postgres",
    "postgresql",
    "redis",
    "snowflake db",
    "sql",
    "sqlite",
    "sql server",
    "supabase",
    "t-sql",
    "timescaledb",
  ],
  tooling: [
    "ansible",
    "circleci",
    "ci/cd",
    "cmake",
    "dockerfile",
    "eslint",
    "github",
    "github actions",
    "gitlab",
    "gitlab ci",
    "graphql",
    "gradle",
    "junit",
    "k8s",
    "kubernetes",
    "makefile",
    "meson build",
    "nuget",
    "npm",
    "pnpm",
    "pytest",
    "regular expression",
    "regex",
    "rollup.js",
    "intellij idea",
    "visual studio code",
    "vscode",
    "vitest",
    "webpack",
    "yaml",
  ],
  artifacts: [
    "cargo.toml",
    "composer.json",
    "package.json",
    "pom.xml",
    "pyproject.toml",
    "requirements.txt",
    "tsconfig.json",
  ],
} as const;

export const CONTEXTUAL_SOFTWARE_TERMS = [
  ".net",
  "angular",
  "android",
  "assembly",
  "astro",
  "babel",
  "bash",
  "bootstrap",
  "bun",
  "c",
  "cargo",
  "cassandra",
  "cypress",
  "dart",
  "delphi",
  "docker",
  "electron",
  "elixir",
  "express",
  "flask",
  "flutter",
  "git",
  "go",
  "gleam",
  "groovy",
  "helm",
  "hcl",
  "java",
  "jax",
  "jenkins",
  "jest",
  "js",
  "julia",
  "lua",
  "maven",
  "mocha",
  "nix",
  "node",
  "numpy",
  "oracle",
  "pandas",
  "perl",
  "phoenix",
  "pip",
  "playwright",
  "poetry",
  "prettier",
  "python",
  "qt",
  "r",
  "rails",
  "react",
  "redux",
  "remix",
  "ruby",
  "rust",
  "sass",
  "scala",
  "selenium",
  "shell",
  "solidity",
  "spring",
  "svelte",
  "swift",
  "terraform",
  "ts",
  "tsx",
  "unity",
  "unreal",
  "vite",
  "vue",
  "yarn",
  "zig",
] as const;

/*
 * These compound names deliberately encode software meaning instead of
 * combining every ambiguous name with generic verbs such as "use" or "run".
 * That keeps phrases such as "run in the spring" and "use the shell as a
 * bowl" out of the coding route.
 */
export const CONTEXTUAL_SOFTWARE_PHRASES = [
  "android activity",
  "android app",
  "angular component",
  "angular module",
  "bash script",
  "docker compose",
  "docker container",
  "docker image",
  "express app",
  "flask app",
  "flutter widget",
  "git branch",
  "git commit",
  "git merge",
  "git rebase",
  "git repository",
  "go method",
  "go module",
  "go package",
  "hcl config",
  "hcl module",
  "helm chart",
  "java package",
  "jest test",
  "js app",
  "js application",
  "js applications",
  "oracle database",
  "python module",
  "python package",
  "python script",
  "rails app",
  "react component",
  "react hook",
  "react state",
  "redux reducer",
  "ruby method",
  "sass stylesheet",
  "rust crate",
  "rust module",
  "spring controller",
  "svelte component",
  "terraform module",
  "terraform plan",
  "terraform provider",
  "terraform state",
  "ts service",
  "unreal engine",
  "vue component",
] as const;

function escapeTerm(term: string): string {
  return term
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, String.raw`\s+`);
}

function termSource(terms: readonly string[]): string {
  const alternatives = [...terms]
    .sort((left, right) => right.length - left.length)
    .map(escapeTerm)
    .join("|");
  return String.raw`(?<![\p{L}\p{N}_])(?:${alternatives})(?![\p{L}\p{N}_])`;
}

const STRONG_SOFTWARE_PATTERN = new RegExp(
  termSource(Object.values(SOFTWARE_TERMS).flat()),
  "iu",
);
const CONTEXTUAL_TERM_SOURCE = termSource(CONTEXTUAL_SOFTWARE_TERMS);
const ANY_SOFTWARE_TERM_SOURCE = termSource([
  ...Object.values(SOFTWARE_TERMS).flat(),
  ...CONTEXTUAL_SOFTWARE_TERMS,
]);
const CONTEXTUAL_SOFTWARE_PHRASE_PATTERN = new RegExp(
  termSource(CONTEXTUAL_SOFTWARE_PHRASES),
  "iu",
);
const CONTEXTUAL_CODE_PATTERN = new RegExp(
  String.raw`${CONTEXTUAL_TERM_SOURCE}(?:[-\s]+(?:based|powered))?[-\s]+(?:code|codebases?|programming|runtimes?|sdks?|source)\b`,
  "iu",
);
const NAMED_SOFTWARE_FOLLOW_UP_PATTERN = new RegExp(
  String.raw`^\s*(?:(?:what|how)\s+about\s+(?:using\s+)?(?:the\s+)?${ANY_SOFTWARE_TERM_SOURCE}(?:\s+(?:instead|for\s+(?:this|that|it)))?|(?:would|could|can|does|is|are)\s+(?:the\s+)?${ANY_SOFTWARE_TERM_SOURCE}(?:\s+(?:be(?:\s+used)?|work|behave|perform|handle))?(?:\s+(?:any\s+)?(?:better|different|equivalent|instead|here|this|that|it|the\s+same\s+way|for\s+(?:this|that|it)))*|(?:could|can|would|should)\s+(?:we|i|you)\s+(?:use|try|choose|switch\s+to)\s+(?:the\s+)?${ANY_SOFTWARE_TERM_SOURCE}(?:\s+instead)?|(?:the\s+)?${ANY_SOFTWARE_TERM_SOURCE}(?:\s+(?:instead|for\s+(?:this|that|it)))?)\s*\??\s*$`,
  "iu",
);
const MAX_NAMED_SOFTWARE_FOLLOW_UP_LENGTH = 240;

export function detectSoftwareReference(
  prompt: string,
): SoftwareReferenceStrength | undefined {
  if (STRONG_SOFTWARE_PATTERN.test(prompt)) return "strong";
  if (
    CONTEXTUAL_SOFTWARE_PHRASE_PATTERN.test(prompt) ||
    CONTEXTUAL_CODE_PATTERN.test(prompt)
  ) {
    return "contextual";
  }
  return undefined;
}

export function isNamedSoftwareFollowUp(prompt: string): boolean {
  if (prompt.length > MAX_NAMED_SOFTWARE_FOLLOW_UP_LENGTH) return false;
  return NAMED_SOFTWARE_FOLLOW_UP_PATTERN.test(
    prompt.trim().replace(/\s+/gu, " "),
  );
}
