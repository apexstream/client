export type ApexStreamAuthOptions = {
  /** Control plane HTTP base (e.g. `http://192.168.1.10:8080`). */
  controlPlaneUrl: string;
  /** App id from the dashboard. */
  appId: string;
  /** Publishable key (`pk_live_…`) — safe for browser signup/login. */
  publishableKey: string;
};

export type AppAuthUser = {
  id: string;
  app_id: string;
  email: string;
  email_verified: boolean;
  metadata?: Record<string, unknown>;
  created_at: string;
};

export type AppAuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  user: AppAuthUser;
};

export type AuthStateChangeCallback = (session: AppAuthSession | null) => void;

const STORAGE_PREFIX = "apexstream_auth:";

function storageKey(appId: string): string {
  return STORAGE_PREFIX + appId;
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export class ApexStreamAuth {
  readonly controlPlaneUrl: string;
  readonly appId: string;
  readonly publishableKey: string;

  private session: AppAuthSession | null = null;
  private listeners = new Set<AuthStateChangeCallback>();

  constructor(options: ApexStreamAuthOptions) {
    this.controlPlaneUrl = normalizeBase(options.controlPlaneUrl);
    this.appId = options.appId.trim();
    this.publishableKey = options.publishableKey.trim();
    if (!this.appId || !this.publishableKey) {
      throw new Error("ApexStreamAuth requires appId and publishableKey");
    }
    this.restoreSession();
  }

  getSession(): AppAuthSession | null {
    return this.session;
  }

  onAuthStateChange(cb: AuthStateChangeCallback): () => void {
    this.listeners.add(cb);
    cb(this.session);
    return () => this.listeners.delete(cb);
  }

  async signUp(email: string, password: string, metadata?: Record<string, unknown>): Promise<AppAuthSession | null> {
    const res = await this.authFetch("POST", `/v1/auth/apps/${encodeURIComponent(this.appId)}/signup`, {
      email,
      password,
      metadata,
    });
    if (res.status === 201 && res.data && typeof res.data === "object") {
      const body = res.data as Record<string, unknown>;
      if (body.access_token && body.refresh_token) {
        return this.applyTokenResponse(body);
      }
      return null;
    }
    if (!res.ok) {
      throw new Error(authErrorMessage(res));
    }
    return null;
  }

  async signInWithPassword(email: string, password: string): Promise<AppAuthSession> {
    const res = await this.authFetch("POST", `/v1/auth/apps/${encodeURIComponent(this.appId)}/token`, {
      grant_type: "password",
      email,
      password,
    });
    if (!res.ok) {
      throw new Error(authErrorMessage(res));
    }
    return this.applyTokenResponse(res.data as Record<string, unknown>);
  }

  async refreshSession(): Promise<AppAuthSession | null> {
    if (!this.session?.refreshToken) {
      return null;
    }
    const res = await this.authFetch("POST", `/v1/auth/apps/${encodeURIComponent(this.appId)}/token`, {
      grant_type: "refresh_token",
      refresh_token: this.session.refreshToken,
    });
    if (!res.ok) {
      this.clearSession();
      return null;
    }
    return this.applyTokenResponse(res.data as Record<string, unknown>);
  }

  async getUser(): Promise<AppAuthUser> {
    const res = await this.accessFetch("GET", `/v1/auth/apps/${encodeURIComponent(this.appId)}/user`);
    if (!res.ok) {
      throw new Error(authErrorMessage(res));
    }
    const body = res.data as { user: AppAuthUser };
    return body.user;
  }

  /**
   * Update the signed-in user's own metadata. Pass an empty object to clear
   * existing metadata. Returns the refreshed user profile.
   *
   * Requires the user to be signed in. Admin-only fields (email, status) can
   * only be changed from the dashboard `/dashboard/auth/users` page.
   */
  async updateMetadata(metadata: Record<string, unknown>): Promise<AppAuthUser> {
    const res = await this.accessFetch(
      "PATCH",
      `/v1/auth/apps/${encodeURIComponent(this.appId)}/user`,
      { metadata },
    );
    if (!res.ok) {
      throw new Error(authErrorMessage(res));
    }
    const body = res.data as { user: AppAuthUser };
    return body.user;
  }

  async signOut(): Promise<void> {
    if (this.session?.accessToken) {
      await this.accessFetch("POST", `/v1/auth/apps/${encodeURIComponent(this.appId)}/logout`, {});
    }
    this.clearSession();
  }

  async issueRealtimeToken(opts?: { ttlSeconds?: number; scopes?: string[] }): Promise<string> {
    const res = await this.accessFetch(
      "POST",
      `/v1/auth/apps/${encodeURIComponent(this.appId)}/realtime/token`,
      {
        ttl_seconds: opts?.ttlSeconds,
        scopes: opts?.scopes,
      },
    );
    if (!res.ok) {
      throw new Error(authErrorMessage(res));
    }
    const body = res.data as { token: string };
    return body.token;
  }

  async resendVerification(email: string): Promise<void> {
    const res = await this.authFetch(
      "POST",
      `/v1/auth/apps/${encodeURIComponent(this.appId)}/resend-verification`,
      { email },
    );
    if (!res.ok) {
      throw new Error(authErrorMessage(res));
    }
  }

  private applyTokenResponse(body: Record<string, unknown>): AppAuthSession {
    const session: AppAuthSession = {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token ?? ""),
      expiresAt: String(body.expires_at ?? ""),
      user: body.user as AppAuthUser,
    };
    this.session = session;
    this.persistSession();
    this.emit();
    return session;
  }

  private clearSession(): void {
    this.session = null;
    try {
      localStorage.removeItem(storageKey(this.appId));
    } catch {
      /* ignore */
    }
    this.emit();
  }

  private persistSession(): void {
    if (!this.session) return;
    try {
      localStorage.setItem(storageKey(this.appId), JSON.stringify(this.session));
    } catch {
      /* ignore */
    }
  }

  private restoreSession(): void {
    try {
      const raw = localStorage.getItem(storageKey(this.appId));
      if (!raw) return;
      this.session = JSON.parse(raw) as AppAuthSession;
    } catch {
      this.session = null;
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.session);
  }

  private async authFetch(method: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
    const res = await fetch(`${this.controlPlaneUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.publishableKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await safeJson(res);
    return { ok: res.ok, status: res.status, data };
  }

  private async accessFetch(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
    if (!this.session?.accessToken) {
      return { ok: false, status: 401, data: { error: "not signed in" } };
    }
    const res = await fetch(`${this.controlPlaneUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.session.accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await safeJson(res);
    return { ok: res.ok, status: res.status, data };
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function authErrorMessage(res: { status: number; data: unknown }): string {
  if (res.data && typeof res.data === "object" && res.data !== null) {
    const err = (res.data as Record<string, unknown>).error;
    if (typeof err === "string") return err;
    if (typeof err === "object" && err !== null && "code" in (err as object)) {
      return String((err as Record<string, unknown>).code);
    }
  }
  return `auth error (${res.status})`;
}
