import { EventEmitter } from 'events';
import { DB } from '../db/index.js';

// GitHub OAuth configuration
// These should be set via environment variables in production
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || 'http://localhost:4747/api/v1/github/callback';

// GitHub API base URL
const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Required scopes for FastOwl
const GITHUB_SCOPES = ['repo', 'read:user', 'read:org'];

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
  };
}

interface GitHubCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  html_url: string;
}

interface GitHubReview {
  id: number;
  user: {
    login: string;
    avatar_url: string;
  };
  body: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string;
  html_url: string;
}

interface GitHubReviewComment {
  id: number;
  user: {
    login: string;
    avatar_url: string;
  };
  body: string;
  path: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request_review_id: number;
}

interface GitHubIssueComment {
  id: number;
  user: {
    login: string;
    avatar_url: string;
  };
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubNotification {
  type: 'review' | 'review_comment' | 'comment' | 'ci_failure' | 'mergeable';
  pr: GitHubPullRequest;
  repo: { owner: string; name: string };
  data: GitHubReview | GitHubReviewComment | GitHubIssueComment | GitHubCheckRun | { mergeable: boolean };
}

interface StoredToken {
  workspaceId: string;
  accessToken: string;
  tokenType: string;
  scope: string;
  createdAt: string;
}

class GitHubService extends EventEmitter {
  private db: DB | null = null;
  private tokens: Map<string, StoredToken> = new Map();

  /**
   * Initialize the GitHub service
   */
  init(db: DB): void {
    this.db = db;
    this.loadStoredTokens();
  }

  /**
   * Load tokens from database
   */
  private loadStoredTokens(): void {
    if (!this.db) return;

    try {
      const rows = this.db.prepare(`
        SELECT workspace_id, config FROM integrations
        WHERE type = 'github' AND config IS NOT NULL
      `).all() as Array<{ workspace_id: string; config: string }>;

      for (const row of rows) {
        try {
          const config = JSON.parse(row.config);
          if (config.accessToken) {
            this.tokens.set(row.workspace_id, {
              workspaceId: row.workspace_id,
              accessToken: config.accessToken,
              tokenType: config.tokenType || 'bearer',
              scope: config.scope || '',
              createdAt: config.createdAt || new Date().toISOString(),
            });
          }
        } catch (_e) {
          // Invalid config, skip
        }
      }

      console.log(`Loaded ${this.tokens.size} GitHub tokens`);
    } catch (_err) {
      console.error('Failed to load GitHub tokens');
    }
  }

  /**
   * Check if GitHub OAuth is configured
   */
  isConfigured(): boolean {
    return Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
  }

  /**
   * Get the OAuth authorization URL
   */
  getAuthorizationUrl(workspaceId: string, state: string): string {
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_REDIRECT_URI,
      scope: GITHUB_SCOPES.join(' '),
      state: `${workspaceId}:${state}`,
      allow_signup: 'false',
    });

    return `${GITHUB_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<{
    access_token: string;
    token_type: string;
    scope: string;
  }> {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub token exchange failed: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
    }

    return data;
  }

  /**
   * Store access token for a workspace
   */
  storeToken(workspaceId: string, accessToken: string, tokenType: string, scope: string): void {
    if (!this.db) return;

    const token: StoredToken = {
      workspaceId,
      accessToken,
      tokenType,
      scope,
      createdAt: new Date().toISOString(),
    };

    // Check if integration already exists
    const existing = this.db.prepare(`
      SELECT id FROM integrations WHERE workspace_id = ? AND type = 'github'
    `).get(workspaceId);

    const config = JSON.stringify({
      accessToken,
      tokenType,
      scope,
      createdAt: token.createdAt,
    });

    if (existing) {
      this.db.prepare(`
        UPDATE integrations SET config = ?, updated_at = ? WHERE workspace_id = ? AND type = 'github'
      `).run(config, new Date().toISOString(), workspaceId);
    } else {
      const { v4: uuid } = require('uuid');
      this.db.prepare(`
        INSERT INTO integrations (id, workspace_id, type, config, created_at, updated_at)
        VALUES (?, ?, 'github', ?, ?, ?)
      `).run(uuid(), workspaceId, config, new Date().toISOString(), new Date().toISOString());
    }

    this.tokens.set(workspaceId, token);
    this.emit('connected', workspaceId);
  }

  /**
   * Remove token for a workspace (disconnect)
   */
  removeToken(workspaceId: string): void {
    if (!this.db) return;

    this.db.prepare(`
      DELETE FROM integrations WHERE workspace_id = ? AND type = 'github'
    `).run(workspaceId);

    this.tokens.delete(workspaceId);
    this.emit('disconnected', workspaceId);
  }

  /**
   * Check if a workspace has GitHub connected
   */
  isConnected(workspaceId: string): boolean {
    return this.tokens.has(workspaceId);
  }

  /**
   * Get connection status for a workspace
   */
  getConnectionStatus(workspaceId: string): {
    connected: boolean;
    user?: GitHubUser;
    scopes?: string[];
  } {
    const token = this.tokens.get(workspaceId);
    if (!token) {
      return { connected: false };
    }

    return {
      connected: true,
      scopes: token.scope.split(' ').filter(Boolean),
    };
  }

  /**
   * Make an authenticated GitHub API request
   */
  private async apiRequest<T>(
    workspaceId: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.tokens.get(workspaceId);
    if (!token) {
      throw new Error('GitHub not connected for this workspace');
    }

    const response = await fetch(`${GITHUB_API_URL}${endpoint}`, {
      ...options,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `${token.tokenType} ${token.accessToken}`,
        'User-Agent': 'FastOwl',
        ...options.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Token is invalid, remove it
        this.removeToken(workspaceId);
        throw new Error('GitHub token expired or revoked');
      }
      throw new Error(`GitHub API error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get the authenticated user
   */
  async getUser(workspaceId: string): Promise<GitHubUser> {
    return this.apiRequest<GitHubUser>(workspaceId, '/user');
  }

  /**
   * List repositories accessible to the user
   */
  async listRepositories(
    workspaceId: string,
    options: { per_page?: number; page?: number; sort?: 'pushed' | 'full_name' } = {}
  ): Promise<GitHubRepo[]> {
    const params = new URLSearchParams({
      per_page: String(options.per_page || 30),
      page: String(options.page || 1),
      sort: options.sort || 'pushed',
    });

    return this.apiRequest<GitHubRepo[]>(workspaceId, `/user/repos?${params}`);
  }

  /**
   * Get a specific repository
   */
  async getRepository(workspaceId: string, owner: string, repo: string): Promise<GitHubRepo> {
    return this.apiRequest<GitHubRepo>(workspaceId, `/repos/${owner}/${repo}`);
  }

  /**
   * List pull requests for a repository
   */
  async listPullRequests(
    workspaceId: string,
    owner: string,
    repo: string,
    options: { state?: 'open' | 'closed' | 'all'; per_page?: number } = {}
  ): Promise<GitHubPullRequest[]> {
    const params = new URLSearchParams({
      state: options.state || 'open',
      per_page: String(options.per_page || 30),
    });

    return this.apiRequest<GitHubPullRequest[]>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls?${params}`
    );
  }

  /**
   * Get a specific pull request
   */
  async getPullRequest(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubPullRequest> {
    return this.apiRequest<GitHubPullRequest>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}`
    );
  }

  /**
   * Get check runs for a commit
   */
  async getCheckRuns(
    workspaceId: string,
    owner: string,
    repo: string,
    ref: string
  ): Promise<{ total_count: number; check_runs: GitHubCheckRun[] }> {
    return this.apiRequest(
      workspaceId,
      `/repos/${owner}/${repo}/commits/${ref}/check-runs`
    );
  }

  /**
   * Create a comment on a pull request
   */
  async createPRComment(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    body: string
  ): Promise<{ id: number; html_url: string }> {
    return this.apiRequest(
      workspaceId,
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }
    );
  }

  /**
   * Get reviews for a pull request
   */
  async getPRReviews(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubReview[]> {
    return this.apiRequest<GitHubReview[]>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}/reviews`
    );
  }

  /**
   * Get review comments for a pull request
   */
  async getPRReviewComments(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    options: { since?: string } = {}
  ): Promise<GitHubReviewComment[]> {
    const params = new URLSearchParams();
    if (options.since) params.set('since', options.since);
    const query = params.toString();

    return this.apiRequest<GitHubReviewComment[]>(
      workspaceId,
      `/repos/${owner}/${repo}/pulls/${number}/comments${query ? `?${query}` : ''}`
    );
  }

  /**
   * Get issue comments for a pull request (general comments, not review comments)
   */
  async getPRComments(
    workspaceId: string,
    owner: string,
    repo: string,
    number: number,
    options: { since?: string } = {}
  ): Promise<GitHubIssueComment[]> {
    const params = new URLSearchParams();
    if (options.since) params.set('since', options.since);
    const query = params.toString();

    return this.apiRequest<GitHubIssueComment[]>(
      workspaceId,
      `/repos/${owner}/${repo}/issues/${number}/comments${query ? `?${query}` : ''}`
    );
  }

  /**
   * Get all connected workspace IDs
   */
  getConnectedWorkspaces(): string[] {
    return Array.from(this.tokens.keys());
  }
}

// Singleton instance
export const githubService = new GitHubService();
