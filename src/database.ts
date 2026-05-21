export type DatabaseChangeEvent = {
  type: "db.change";
  op: "create" | "upsert" | "delete";
  collection: string;
  id: string;
  data?: Record<string, unknown>;
  revision?: number;
  updated_at?: string;
};

/** Minimal realtime surface used for `db.*` channel subscriptions. */
export type DatabaseRealtimeClient = {
  readonly apiKey: string;
  subscribe(channel: string, handler: (payload: unknown) => void): () => void;
};

export type ApexStreamDatabaseOptions = {
  /** Control plane HTTP base (e.g. `http://localhost:8080`). */
  controlPlaneUrl: string;
  /** App API key (`pk_live_` read, `sk_live_` write). */
  apiKey: string;
  /** Optional WebSocket client for live `db.*` channel updates. */
  realtimeClient?: DatabaseRealtimeClient;
};

export type AppDocument = {
  id: string;
  app_id: string;
  project_id: string;
  collection: string;
  document_id: string;
  data: Record<string, unknown>;
  size_bytes: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

function dbChannel(collection: string): string {
  return `db.${collection}`;
}

function dbDocChannel(collection: string, documentId: string): string {
  return `db.${collection}.${documentId}`;
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

async function dbFetch<T>(
  base: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${apiKey.trim()}`);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${normalizeBase(base)}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const msg = typeof (body as { error?: string }).error === "string" ? (body as { error: string }).error : res.statusText;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return body;
}

export class DocumentRef {
  constructor(
    private readonly db: ApexStreamDatabase,
    readonly collection: string,
    readonly id: string,
  ) {}

  async get(): Promise<AppDocument> {
    return this.db.getDocument(this.collection, this.id);
  }

  async set(data: Record<string, unknown>): Promise<AppDocument> {
    return this.db.setDocument(this.collection, this.id, data);
  }

  async patch(data: Record<string, unknown>): Promise<AppDocument> {
    return this.db.patchDocument(this.collection, this.id, data);
  }

  async delete(): Promise<void> {
    await this.db.deleteDocument(this.collection, this.id);
  }

  onChange(handler: (ev: DatabaseChangeEvent) => void): () => void {
    return this.db.onDocumentChange(this.collection, this.id, handler);
  }
}

export class CollectionRef {
  constructor(
    private readonly db: ApexStreamDatabase,
    readonly name: string,
  ) {}

  doc(id: string): DocumentRef {
    return new DocumentRef(this.db, this.name, id);
  }

  async list(limit = 50): Promise<AppDocument[]> {
    const res = await dbFetch<{ documents: AppDocument[] }>(
      this.db.controlPlaneUrl,
      this.db.apiKey,
      `/external/v1/db/collections/${encodeURIComponent(this.name)}/documents?limit=${limit}`,
    );
    return res.documents ?? [];
  }

  onChange(handler: (ev: DatabaseChangeEvent) => void): () => void {
    return this.db.onCollectionChange(this.name, handler);
  }
}

export class ApexStreamDatabase {
  readonly controlPlaneUrl: string;
  readonly apiKey: string;
  private readonly realtime?: DatabaseRealtimeClient;

  constructor(options: ApexStreamDatabaseOptions) {
    this.controlPlaneUrl = options.controlPlaneUrl.trim();
    this.apiKey = options.apiKey.trim();
    this.realtime = options.realtimeClient;
    if (!this.controlPlaneUrl) {
      throw new Error("controlPlaneUrl is required");
    }
    if (!this.apiKey) {
      throw new Error("apiKey is required");
    }
  }

  collection(name: string): CollectionRef {
    return new CollectionRef(this, name);
  }

  async listCollections(): Promise<{ name: string; document_count: number }[]> {
    const res = await dbFetch<{ collections: { name: string; document_count: number }[] }>(
      this.controlPlaneUrl,
      this.apiKey,
      "/external/v1/db/collections",
    );
    return res.collections ?? [];
  }

  async getDocument(collection: string, id: string): Promise<AppDocument> {
    return dbFetch<AppDocument>(
      this.controlPlaneUrl,
      this.apiKey,
      `/external/v1/db/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
    );
  }

  async setDocument(collection: string, id: string, data: Record<string, unknown>): Promise<AppDocument> {
    return dbFetch<AppDocument>(
      this.controlPlaneUrl,
      this.apiKey,
      `/external/v1/db/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ data }) },
    );
  }

  async patchDocument(collection: string, id: string, data: Record<string, unknown>): Promise<AppDocument> {
    return dbFetch<AppDocument>(
      this.controlPlaneUrl,
      this.apiKey,
      `/external/v1/db/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ data }) },
    );
  }

  async deleteDocument(collection: string, id: string): Promise<void> {
    await dbFetch(
      this.controlPlaneUrl,
      this.apiKey,
      `/external/v1/db/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  onCollectionChange(collection: string, handler: (ev: DatabaseChangeEvent) => void): () => void {
    if (!this.realtime) {
      throw new Error("realtimeClient is required for onChange subscriptions");
    }
    return this.realtime.subscribe(dbChannel(collection), (payload) => {
      if (payload && typeof payload === "object") {
        handler(payload as DatabaseChangeEvent);
      }
    });
  }

  onDocumentChange(collection: string, id: string, handler: (ev: DatabaseChangeEvent) => void): () => void {
    if (!this.realtime) {
      throw new Error("realtimeClient is required for onChange subscriptions");
    }
    return this.realtime.subscribe(dbDocChannel(collection, id), (payload) => {
      if (payload && typeof payload === "object") {
        handler(payload as DatabaseChangeEvent);
      }
    });
  }
}
