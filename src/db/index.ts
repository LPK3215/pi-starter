/**
 * pi-starter · 数据库
 *
 * SDK 没有原生数据库。这一层用 Node 22 内置 node:sqlite，零额外依赖。
 * 默认 :memory:，启动时写入示例 notes，HTTP / Agent 工具都能打到真实连接。
 *
 * 换持久化：buildAgent({ databasePath: "./data/app.db" }) 或 PI_DATABASE_PATH。
 * 换实现：buildAgent({ database: myStore })，HTTP 和工具只依赖 DatabaseStore。
 */

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

export interface NoteRow {
  id: number;
  title: string;
  body: string;
}

export interface DbPing {
  ok: true;
  driver: string;
  path: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, SQLOutputValue>[];
}

export interface DatabaseStore {
  readonly driver: string;
  readonly path: string;
  ping(): DbPing;
  listNotes(): NoteRow[];
  getNote(id: number): NoteRow | undefined;
  searchNotes(query: string): NoteRow[];
  insertNote(input: { title: string; body: string }): NoteRow;
  query(sql: string, params?: readonly SQLInputValue[]): QueryResult;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** sqlite 路径。`:memory:` 或不传 = 内存库。 */
  path?: string;
  /** 空表时写入示例行。默认 true。测试要空库就传 false。 */
  seed?: boolean;
}

const DEFAULT_SEED: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "welcome",
    body: "pi-starter 默认内存 SQLite。GET /db 探活，GET /db/notes 读示例行。",
  },
  {
    title: "skills",
    body: "技能走 SDK DefaultResourceLoader.additionalSkillPaths，全文用内置 read 加载 SKILL.md。",
  },
];

/** 只允许单条 SELECT / WITH…SELECT。拒绝写库、多语句、附加 pragma。 */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .trim();
  if (!stripped) return false;
  const parts = stripped
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 1) return false;
  const statement = parts[0] ?? "";
  if (/^\s*(pragma|attach|detach|vacuum|reindex)\b/i.test(statement)) return false;
  return /^(with\b[\s\S]+select\b|select\b)/i.test(statement);
}

function asNote(row: Record<string, SQLOutputValue> | undefined): NoteRow | undefined {
  if (!row) return undefined;
  const id = row.id;
  const title = row.title;
  const body = row.body;
  if (typeof id !== "number" || typeof title !== "string" || typeof body !== "string") {
    return undefined;
  }
  return { id, title, body };
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseStore {
  const path = options.path?.trim() || ":memory:";
  const seed = options.seed !== false;
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    ) STRICT
  `);

  const count = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number } | undefined;
  if (seed && (count?.n ?? 0) === 0) {
    const insert = db.prepare("INSERT INTO notes (title, body) VALUES (?, ?)");
    for (const row of DEFAULT_SEED) insert.run(row.title, row.body);
  }

  const store: DatabaseStore = {
    driver: "sqlite",
    path,
    ping() {
      db.prepare("SELECT 1 AS ok").get();
      return { ok: true, driver: "sqlite", path };
    },
    listNotes() {
      const rows = db.prepare("SELECT id, title, body FROM notes ORDER BY id").all() as Record<
        string,
        SQLOutputValue
      >[];
      return rows.map((row) => asNote(row)).filter((row): row is NoteRow => Boolean(row));
    },
    getNote(id) {
      const row = db.prepare("SELECT id, title, body FROM notes WHERE id = ?").get(id) as
        | Record<string, SQLOutputValue>
        | undefined;
      return asNote(row);
    },
    searchNotes(query) {
      const q = query.trim();
      if (!q) return [];
      const rows = db
        .prepare(
          "SELECT id, title, body FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY id",
        )
        .all(`%${q}%`, `%${q}%`) as Record<string, SQLOutputValue>[];
      return rows.map((row) => asNote(row)).filter((row): row is NoteRow => Boolean(row));
    },
    insertNote(input) {
      const title = input.title.trim();
      const body = input.body.trim();
      if (!title) throw new Error("title 必填");
      const result = db.prepare("INSERT INTO notes (title, body) VALUES (?, ?)").run(title, body);
      const id = Number(result.lastInsertRowid);
      const row = store.getNote(id);
      if (!row) throw new Error("写入 notes 后读回失败");
      return row;
    },
    query(sql, params = []) {
      if (!isReadOnlySql(sql)) {
        throw new Error("只允许单条 SELECT / WITH…SELECT");
      }
      const stmt = db.prepare(sql);
      const raw = stmt.all(...params) as Record<string, SQLOutputValue>[];
      const rows = raw.map((row) => ({ ...row }));
      const columns =
        rows[0] !== undefined
          ? Object.keys(rows[0])
          : typeof stmt.columns === "function"
            ? stmt.columns().map((col) => col.name)
            : [];
      return { columns, rows };
    },
    close() {
      if (db.isOpen) db.close();
    },
  };

  return store;
}

/** 脚手架默认库：内存 + 示例行。 */
export function openScaffoldDatabase(options: OpenDatabaseOptions = {}): DatabaseStore {
  return openDatabase({ seed: true, ...options });
}
