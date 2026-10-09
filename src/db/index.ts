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
  /** 是否因超过 maxRows 而被截断。 */
  truncated: boolean;
  /** 截断前的总行数（用于告知调用方「还有多少没拿到」）。 */
  totalRows: number;
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
  /** query() 单次返回的最大行数，默认 200。 */
  maxRows?: number;
}

/** query() 默认行数上限。200 行足够业务查询，又不至于撑爆上下文。 */
export const DEFAULT_MAX_ROWS = 200;

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

/**
 * 只读 SQL 校验（白名单 token 扫描，非正则匹配）。
 *
 * ## 为什么不用正则
 * 改造前用 `/^(with|select)/i` 开头匹配 + 少量禁用前缀，结果被证明**可绕过**：
 *   `WITH x AS (DELETE FROM notes RETURNING *) SELECT * FROM x`
 * 因为语句以 `WITH` 开头就直接放行，CTE 内部的写操作完全没被检查。
 * （实测当前 node:sqlite 会自行报错拒绝该语法，因此未造成实际数据损坏，
 *   但这是「依赖 SQLite 兜底」而非「自己拦住」，一旦换驱动/换引擎即刻失守。）
 *
 * ## 本实现的做法
 * 1. 先剥离注释与字符串字面量（避免注释/引号里藏关键字绕过）；
 *    剥离失败（未闭合注释/引号）→ 判定非法，而不是放行。
 * 2. 对剥离后的 SQL 做**分词**，得到关键字序列。
 * 3. 全文扫描：出现任何写/危险关键字即拒绝（不看位置），
 *    因此 CTE 内的 DELETE/UPDATE/INSERT/PRAGMA 同样会被拦下。
 *
 * 只读语句允许的关键字：WITH / SELECT / VALUES 及常见只读修饰。
 */

/** 出现在 SQL 任何位置都判定为「非只读」的关键字。 */
const FORBIDDEN_KEYWORDS = new Set([
  // 写入
  "insert", "update", "delete", "replace", "upsert", "merge",
  // DDL
  "create", "alter", "drop", "truncate", "rename",
  // 事务与连接级副作用
  "begin", "commit", "rollback", "savepoint", "release",
  "attach", "detach", "vacuum", "reindex", "analyze",
  "pragma",
  // 触发器 / 视图等可写入对象
  "trigger", "view",
]);

/** 单条 SQL 允许的最大长度（字符）。超长既无意义也是攻击面。 */
export const MAX_SQL_LENGTH = 20_000;

export interface SqlScanResult {
  ok: boolean;
  /** 失败原因（ok=true 时为 null），直接可用于报错文案。 */
  reason: string | null;
  /** 命中的禁用关键字（便于审计定位）。 */
  keyword?: string;
}

/**
 * 剥离注释与字符串字面量，替换为空格。
 * 返回 null 表示**语法不完整**（未闭合注释 / 引号）——必须拒绝。
 */
function stripCommentsAndLiterals(sql: string): string | null {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释 -- …（到行尾）
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    // 块注释 /* … */（必须闭合，否则判非法）
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      out += " ";
      continue;
    }
    // 字符串字面量 '…' （含 '' 转义）
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; } // '' 转义
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return null;
      out += " ";
      i = j + 1;
      continue;
    }
    // 反引号标识符 `x` 与方括号 [x]
    if (ch === "`") {
      const end = sql.indexOf("`", i + 1);
      if (end === -1) return null;
      out += " ";
      i = end + 1;
      continue;
    }
    if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      if (end === -1) return null;
      out += " ";
      i = end + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 提取标识符/关键字序列（连续字母、数字、下划线）。 */
function tokenize(sql: string): string[] {
  const tokens: string[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    tokens.push(match[0].toLowerCase());
  }
  return tokens;
}

/**
 * 扫描 SQL 是否严格只读。
 * 导出以便测试断言具体原因，而不是只拿布尔值。
 */
export function scanReadOnlySql(sql: string): SqlScanResult {
  if (typeof sql !== "string") return { ok: false, reason: "sql 必须是字符串" };
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, reason: "sql 为空" };
  if (trimmed.length > MAX_SQL_LENGTH) {
    return { ok: false, reason: `sql 超过 ${MAX_SQL_LENGTH} 字符上限` };
  }

  const stripped = stripCommentsAndLiterals(trimmed);
  if (stripped === null) {
    // 注释/引号未闭合：可能是构造绕过，也可能是单纯写错，一律拒绝。
    return { ok: false, reason: "sql 含有未闭合的注释或字符串字面量" };
  }

  // 分号分割后必须**恰好一条**语句（尾随空段允许）。
  const statements = stripped
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (statements.length === 0) return { ok: false, reason: "sql 为空" };
  if (statements.length > 1) {
    return { ok: false, reason: "只允许单条语句（检测到多条，以分号分隔）" };
  }

  const statement = statements[0] ?? "";

  // 必须以 SELECT 或 WITH 开头（WITH 的内部仍会经过下面的全文关键字扫描）。
  if (!/^\s*(with|select)\b/i.test(statement)) {
    return { ok: false, reason: "只允许以 SELECT 或 WITH 开头的只读语句" };
  }

  // 全文扫描禁用关键字 —— 这是拦住 CTE 内写入的关键一步。
  for (const token of tokenize(statement)) {
    if (FORBIDDEN_KEYWORDS.has(token)) {
      return { ok: false, reason: `检测到非只读关键字：${token.toUpperCase()}`, keyword: token };
    }
  }

  // 首关键字之后必须出现 SELECT（WITH ... SELECT / WITH ... VALUES 都满足）。
  if (!/\bselect\b/i.test(statement) && !/\bvalues\b/i.test(statement)) {
    return { ok: false, reason: "WITH 子句必须以 SELECT 或 VALUES 收尾" };
  }

  return { ok: true, reason: null };
}

/**
 * 判断是否为只读 SQL。
 * 保持原有导出签名（布尔），内部委托给 scanReadOnlySql。
 */
export function isReadOnlySql(sql: string): boolean {
  return scanReadOnlySql(sql).ok;
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
  const maxRows =
    typeof options.maxRows === "number" && Number.isInteger(options.maxRows) && options.maxRows > 0
      ? options.maxRows
      : DEFAULT_MAX_ROWS;
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
      const scan = scanReadOnlySql(sql);
      if (!scan.ok) {
        // Surface the specific reason so the model can correct itself instead of guessing.
        throw new Error(scan.reason ?? "只允许单条 SELECT / WITH…SELECT");
      }
      // Hard cap on returned rows. `SELECT * FROM huge_table` would otherwise pull the whole
      // table into memory and then into the LLM context in one tool result.
      //
      // 用 `iterate()` 边取边判，只物化前 `maxRows` 行；其余行只计数（`totalRows` 仍要报
      // 真实总数，这是对调用方的既有承诺）。原实现 `stmt.all()` 会把整张表**全部物化**，
      // 行数上限只限制了「返回多少行」，没限制「载入多少行」——大表直接打爆内存。
      const stmt = db.prepare(sql);
      const rows: Record<string, SQLOutputValue>[] = [];
      let totalRows = 0;
      let truncated = false;
      for (const row of stmt.iterate(...params) as Iterable<Record<string, SQLOutputValue>>) {
        totalRows += 1;
        if (rows.length < maxRows) {
          rows.push({ ...row });
        } else {
          // 超出上限：不再保留，但继续数完，保证 totalRows 是真实总数。
          truncated = true;
        }
      }
      const columns =
        rows[0] !== undefined
          ? Object.keys(rows[0])
          : typeof stmt.columns === "function"
            ? stmt.columns().map((col) => col.name)
            : [];
      return { columns, rows, truncated, totalRows };
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
