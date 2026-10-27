import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';

function loadDatabase(): typeof SQLiteDatabase {
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = (warning: string | Error, ...options: unknown[]) => {
      if (warning === 'SQLite is an experimental feature and might change at any time' && options[0] === 'ExperimentalWarning') return;
      Reflect.apply(emitWarning, process, [warning, ...options]);
    };
    return (process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
}

export const DatabaseSync = loadDatabase();
export type DatabaseSync = SQLiteDatabase;
