/**
 * GitHub API client wrapper with rate limiting and retry logic
 */

import { Octokit } from '@octokit/rest';
import type { GitHubApiError } from '../types.js';

/**
 * Rate limit state tracking
 */
interface RateLimitState {
  remaining: number;
  reset: number;
  limit: number;
}

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * GitHub client wrapper class
 */
export class GitHubClient {
  private octokit: Octokit;
  private rateLimitState: RateLimitState = {
    remaining: 5000,
    reset: Date.now() + 3600000,
    limit: 5000,
  };
  private retryConfig: RetryConfig;

  constructor(token?: string, retryConfig?: Partial<RetryConfig>) {
    const authToken = token || process.env.GITHUB_TOKEN;

    if (!authToken) {
      throw new GitHubClientError(
        'GitHub token is required. Set GITHUB_TOKEN environment variable or pass token to constructor.',
        401
      );
    }

    this.octokit = new Octokit({
      auth: authToken,
      userAgent: 'code-review-mcp/1.0.0',
      timeZone: 'UTC',
    });

    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Get the underlying Octokit instance
   */
  get client(): Octokit {
    return this.octokit;
  }

  /**
   * Update rate limit state from response headers
   */
  private updateRateLimitFromHeaders(headers: Record<string, unknown>): void {
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    const limit = headers['x-ratelimit-limit'];

    if (remaining !== undefined) {
      this.rateLimitState.remaining = Number(remaining);
    }
    if (reset !== undefined) {
      this.rateLimitState.reset = Number(reset) * 1000;
    }
    if (limit !== undefined) {
      this.rateLimitState.limit = Number(limit);
    }
  }

  /**
   * Check if we should wait for rate limit reset
   */
  private async waitForRateLimitIfNeeded(): Promise<void> {
    if (this.rateLimitState.remaining <= 10) {
      const now = Date.now();
      const resetTime = this.rateLimitState.reset;

      if (resetTime > now) {
        const waitTime = Math.min(resetTime - now + 1000, 60000);
        console.error(`Rate limit low (${this.rateLimitState.remaining} remaining). Waiting ${waitTime}ms...`);
        await this.delay(waitTime);
      }
    }
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoffDelay(attempt: number): number {
    const delay = this.retryConfig.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 1000;
    return Math.min(delay + jitter, this.retryConfig.maxDelayMs);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const status = (error as { status?: number }).status;
      // Retry on rate limit, server errors, and network issues
      if (status === 429 || status === 502 || status === 503 || status === 504) {
        return true;
      }
      // Retry on network errors
      if (error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('ENOTFOUND')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Execute a GitHub API request with rate limiting and retry logic
   */
  async execute<T>(
    operation: () => Promise<{ data: T; headers: Record<string, unknown> }>
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        await this.waitForRateLimitIfNeeded();

        const response = await operation();
        this.updateRateLimitFromHeaders(response.headers);

        return response.data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Update rate limit from error response if available
        const errorWithHeaders = error as { response?: { headers?: Record<string, unknown> } };
        if (errorWithHeaders.response?.headers) {
          this.updateRateLimitFromHeaders(errorWithHeaders.response.headers);
        }

        // Check if we should retry
        if (attempt < this.retryConfig.maxRetries && this.isRetryableError(error)) {
          const delay = this.calculateBackoffDelay(attempt);
          console.error(`Request failed (attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}). Retrying in ${delay}ms...`);
          await this.delay(delay);
          continue;
        }

        // Transform error for better messaging
        throw this.transformError(error);
      }
    }

    throw lastError || new Error('Unknown error occurred');
  }

  /**
   * Transform GitHub API errors into more meaningful errors
   */
  private transformError(error: unknown): GitHubClientError {
    if (error instanceof GitHubClientError) {
      return error;
    }

    const octokitError = error as {
      status?: number;
      message?: string;
      response?: {
        data?: GitHubApiError;
      };
    };

    const status = octokitError.status || 500;
    let message = octokitError.message || 'Unknown GitHub API error';

    if (octokitError.response?.data?.message) {
      message = octokitError.response.data.message;
    }

    // Provide helpful error messages
    switch (status) {
      case 401:
        message = 'Authentication failed. Please check your GITHUB_TOKEN.';
        break;
      case 403:
        if (message.includes('rate limit')) {
          message = 'GitHub API rate limit exceeded. Please wait before making more requests.';
        } else {
          message = `Access denied: ${message}`;
        }
        break;
      case 404:
        message = 'Resource not found. Please check the owner, repo, and PR number.';
        break;
      case 422:
        message = `Invalid request: ${message}`;
        break;
    }

    return new GitHubClientError(message, status);
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): RateLimitState {
    return { ...this.rateLimitState };
  }

  /**
   * Fetch fresh rate limit status from GitHub
   */
  async fetchRateLimitStatus(): Promise<RateLimitState> {
    const data = await this.execute(() => this.octokit.rateLimit.get());

    this.rateLimitState = {
      remaining: data.resources.core.remaining,
      reset: data.resources.core.reset * 1000,
      limit: data.resources.core.limit,
    };

    return this.getRateLimitStatus();
  }
}

/**
 * Custom error class for GitHub API errors
 */
export class GitHubClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly documentationUrl?: string
  ) {
    super(message);
    this.name = 'GitHubClientError';
  }
}

/**
 * Singleton instance for the GitHub client
 */
let clientInstance: GitHubClient | null = null;

/**
 * Get or create the GitHub client instance
 */
export function getGitHubClient(token?: string): GitHubClient {
  if (!clientInstance) {
    clientInstance = new GitHubClient(token);
  }
  return clientInstance;
}

/**
 * Reset the client instance (useful for testing)
 */
export function resetGitHubClient(): void {
  clientInstance = null;
}
