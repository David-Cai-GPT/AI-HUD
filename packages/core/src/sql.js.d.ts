declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer) => SqlJsDatabase;
  }

  export interface SqlJsDatabase {
    run(sql: string, params?: Record<string, unknown>): void;
    exec(sql: string, params?: Record<string, unknown>): SqlJsExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsExecResult {
    columns: string[];
    values: unknown[][];
  }

  export default function initSqlJs(
    config?: { wasmBinary?: ArrayBuffer }
  ): Promise<SqlJsStatic>;
}
