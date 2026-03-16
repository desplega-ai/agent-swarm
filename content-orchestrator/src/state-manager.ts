import { Database } from "bun:sqlite";
import { CONFIG } from "./config.js";
import type {
  ContentRecord,
  ImagePromptRecord,
  RefreshRecord,
  WorkflowExecution,
} from "./types.js";

export class StateManager {
  private db: Database;

  constructor(dbPath: string = CONFIG.STATE_DB_PATH) {
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA foreign_keys = ON");
    this.ensureTables();
  }

  /** Create tables if they don't exist (safety guard for fresh DBs) */
  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_name TEXT NOT NULL,
        started_at TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        status TEXT NOT NULL,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_workflow_name ON workflow_executions(workflow_name)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_created_at ON workflow_executions(created_at DESC)",
    );

    this.db.run(`
      CREATE TABLE IF NOT EXISTS content_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content_id TEXT NOT NULL,
        file_path TEXT,
        pr_url TEXT,
        status TEXT NOT NULL,
        topic TEXT,
        main_topic TEXT,
        subjects TEXT,
        keywords TEXT,
        series_name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workflow_name, content_id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS image_prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        series TEXT NOT NULL,
        style_category TEXT NOT NULL,
        generation_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(prompt, series, generation_date)
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_image_series_date ON image_prompt_history(series, generation_date)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_image_style ON image_prompt_history(style_category)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_image_date ON image_prompt_history(generation_date)",
    );

    this.db.run(`
      CREATE TABLE IF NOT EXISTS repo_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_name TEXT NOT NULL UNIQUE,
        repo_path TEXT NOT NULL,
        patterns_json TEXT NOT NULL,
        extracted_at TIMESTAMP NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_repo_patterns_name ON repo_patterns(repo_name)",
    );

    this.db.run(`
      CREATE TABLE IF NOT EXISTS refresh_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        refreshed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        refresh_type TEXT NOT NULL,
        changes_made TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(content_id, refreshed_at)
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_refresh_content_id ON refresh_history(content_id)",
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_refresh_date ON refresh_history(refreshed_at DESC)",
    );
  }

  /** Get last successful workflow execution timestamp */
  getLastWorkflowExecution(workflowName: string): Date | null {
    const row = this.db
      .prepare(
        `SELECT completed_at FROM workflow_executions
       WHERE workflow_name = ? AND status = 'success'
       ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(workflowName) as { completed_at: string } | null;
    return row ? new Date(row.completed_at) : null;
  }

  /** Record a workflow execution */
  recordWorkflowExecution(exec: WorkflowExecution): number {
    const result = this.db
      .prepare(
        `INSERT INTO workflow_executions (workflow_name, started_at, completed_at, status, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        exec.workflowName,
        exec.startedAt,
        exec.completedAt ?? null,
        exec.status,
        exec.metadata ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Get recent content for a series within a given day window */
  getContentHistory(
    workflowName: string,
    seriesName: string | null,
    days: number,
  ): ContentRecord[] {
    let query = `
      SELECT content_id, topic, main_topic, subjects, keywords, series_name, created_at
      FROM content_history
      WHERE created_at >= datetime('now', '-' || ? || ' days')
        AND workflow_name = ?
    `;
    const params: (string | number)[] = [days, workflowName];

    if (seriesName) {
      query += " AND series_name = ?";
      params.push(seriesName);
    }

    query += " ORDER BY created_at DESC";

    const rows = this.db.prepare(query).all(...params) as Array<{
      content_id: string;
      topic: string | null;
      main_topic: string | null;
      subjects: string | null;
      keywords: string | null;
      series_name: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      workflowName,
      contentType: "blog",
      contentId: r.content_id,
      status: "created",
      topic: r.topic ?? undefined,
      mainTopic: r.main_topic ?? undefined,
      subjects: r.subjects ?? undefined,
      keywords: r.keywords ?? undefined,
      seriesName: r.series_name ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** Check if content already exists */
  contentExists(workflowName: string, contentId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM content_history WHERE workflow_name = ? AND content_id = ?",
      )
      .get(workflowName, contentId);
    return !!row;
  }

  /** Record generated content (INSERT OR REPLACE for UNIQUE constraint) */
  recordContent(record: ContentRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO content_history
       (workflow_name, content_type, content_id, file_path, pr_url, status,
        topic, main_topic, subjects, keywords, series_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.workflowName,
        record.contentType,
        record.contentId,
        record.filePath ?? null,
        record.prUrl ?? null,
        record.status,
        record.topic ?? null,
        record.mainTopic ?? null,
        record.subjects ?? null,
        record.keywords ?? null,
        record.seriesName ?? null,
      );
  }

  /** Record an image prompt generation */
  recordImagePrompt(record: ImagePromptRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO image_prompt_history (prompt, series, style_category, generation_date)
         VALUES (?, ?, ?, ?)`,
        )
        .run(
          record.prompt,
          record.series,
          record.styleCategory,
          record.generationDate,
        );
    } catch (e) {
      // Suppress duplicate key violations (UNIQUE constraint)
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("UNIQUE constraint")) throw e;
    }
  }

  /** Get recent image prompts for a series */
  getRecentImagePrompts(
    series: string,
    days: number,
  ): ImagePromptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT prompt, series, style_category, generation_date
       FROM image_prompt_history
       WHERE series = ? AND generation_date >= date('now', '-' || ? || ' days')
       ORDER BY generation_date DESC`,
      )
      .all(series, days) as Array<{
      prompt: string;
      series: string;
      style_category: string;
      generation_date: string;
    }>;

    return rows.map((r) => ({
      prompt: r.prompt,
      series: r.series,
      styleCategory: r.style_category,
      generationDate: r.generation_date,
    }));
  }

  /** Get style usage counts within a window */
  getStyleUsageCounts(
    days: number = 30,
    series?: string,
  ): Record<string, number> {
    let query = `
      SELECT style_category, COUNT(*) as count
      FROM image_prompt_history
      WHERE generation_date >= date('now', '-' || ? || ' days')
    `;
    const params: (string | number)[] = [days];

    if (series) {
      query += " AND series = ?";
      params.push(series);
    }
    query += " GROUP BY style_category";

    const rows = this.db.prepare(query).all(...params) as Array<{
      style_category: string;
      count: number;
    }>;

    const result: Record<string, number> = {};
    for (const r of rows) {
      result[r.style_category] = r.count;
    }
    return result;
  }

  /** Get posts needing refresh (>30 days since last refresh or creation) */
  getRefreshCandidates(
    maxAgeDays: number = 30,
    maxCount: number = 5,
  ): ContentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
        ch.content_id, ch.topic, ch.series_name, ch.created_at,
        MAX(rh.refreshed_at) as last_refreshed
      FROM content_history ch
      LEFT JOIN refresh_history rh ON ch.content_id = rh.content_id
      WHERE ch.workflow_name = 'daily_blog'
      GROUP BY ch.content_id
      HAVING last_refreshed IS NULL
        OR last_refreshed < datetime('now', '-' || ? || ' days')
      ORDER BY COALESCE(last_refreshed, ch.created_at) ASC
      LIMIT ?`,
      )
      .all(maxAgeDays, maxCount) as Array<{
      content_id: string;
      topic: string | null;
      series_name: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      workflowName: "daily_blog",
      contentType: "blog",
      contentId: r.content_id,
      status: "created",
      topic: r.topic ?? undefined,
      seriesName: r.series_name ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** Record a content refresh event */
  recordRefresh(record: RefreshRecord): void {
    this.db
      .prepare(
        `INSERT INTO refresh_history (content_id, workflow_name, refresh_type, changes_made)
       VALUES (?, ?, ?, ?)`,
      )
      .run(
        record.contentId,
        record.workflowName,
        record.refreshType,
        record.changesMade ?? null,
      );
  }

  close(): void {
    this.db.close();
  }
}
