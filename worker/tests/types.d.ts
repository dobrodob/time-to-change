/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}

// Vite raw imports for SQL files в тестах.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "*.sql" {
  const content: string;
  export default content;
}
