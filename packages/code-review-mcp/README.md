# Code Review MCP

An MCP server for GitHub pull request review integration, providing PR analysis, diff review, and automated suggestions.

## Installation

```bash
npm install
npm run build
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| GITHUB_TOKEN | Yes | GitHub personal access token with `repo` scope |

### Claude Desktop Config

```json
{
  "mcpServers": {
    "code-review": {
      "command": "node",
      "args": ["/path/to/code-review-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

## Tools

### get_pr_details

Fetch comprehensive pull request information including files, comments, and reviews.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| owner | string | Yes | Repository owner |
| repo | string | Yes | Repository name |
| prNumber | number | Yes | Pull request number |

**Output:**
- PR metadata (title, body, state, author, dates)
- Changed files with patch content
- All comments and review comments
- Reviews with their states

**Example:**
```json
{
  "owner": "facebook",
  "repo": "react",
  "prNumber": 12345
}
```

---

### analyze_pr_diff

Analyze code changes and identify potential issues in security, performance, style, and bugs.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| owner | string | Yes | Repository owner |
| repo | string | Yes | Repository name |
| prNumber | number | Yes | Pull request number |
| focusAreas | array | No | Areas to focus on: "security", "performance", "style", "bugs" |

**Output:**
- Diff summary (files changed, additions, deletions)
- Identified issues with severity and location
- Suggestions for improvements
- Risk assessment

**Example:**
```json
{
  "owner": "myorg",
  "repo": "myapp",
  "prNumber": 42,
  "focusAreas": ["security", "bugs"]
}
```

**Issue Detection:**
- **Security**: Hardcoded secrets, SQL injection, XSS vulnerabilities, unsafe eval
- **Performance**: Nested loops, missing indexes, N+1 queries, large bundles
- **Style**: Long functions, deep nesting, magic numbers, inconsistent naming
- **Bugs**: Null references, race conditions, resource leaks, error handling

---

### add_review_comment

Add inline or general review comments to a pull request.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| owner | string | Yes | Repository owner |
| repo | string | Yes | Repository name |
| prNumber | number | Yes | Pull request number |
| body | string | Yes | Comment content (Markdown supported) |
| path | string | No | File path for inline comment |
| line | number | No | Line number for inline comment |
| side | string | No | "LEFT" or "RIGHT" for diff side |
| inReplyTo | number | No | Comment ID to reply to |

**Example - General Comment:**
```json
{
  "owner": "myorg",
  "repo": "myapp",
  "prNumber": 42,
  "body": "Great work on this feature! A few suggestions below."
}
```

**Example - Inline Comment:**
```json
{
  "owner": "myorg",
  "repo": "myapp",
  "prNumber": 42,
  "body": "Consider using `const` here instead of `let`",
  "path": "src/utils/helper.ts",
  "line": 25,
  "side": "RIGHT"
}
```

---

### submit_review

Submit a complete PR review with approval, changes requested, or comment.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| owner | string | Yes | Repository owner |
| repo | string | Yes | Repository name |
| prNumber | number | Yes | Pull request number |
| body | string | Yes | Review summary |
| event | string | Yes | "APPROVE", "REQUEST_CHANGES", or "COMMENT" |
| comments | array | No | Inline review comments |

**Comment Object:**
```typescript
{
  path: string;      // File path
  line: number;      // Line number
  body: string;      // Comment text
  side?: string;     // "LEFT" or "RIGHT"
}
```

**Example:**
```json
{
  "owner": "myorg",
  "repo": "myapp",
  "prNumber": 42,
  "body": "LGTM! Just one minor suggestion.",
  "event": "APPROVE",
  "comments": [
    {
      "path": "src/index.ts",
      "line": 10,
      "body": "Nit: Add a comment explaining this logic"
    }
  ]
}
```

---

### get_review_suggestions

Generate AI-powered review suggestions based on diff analysis.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| owner | string | Yes | Repository owner |
| repo | string | Yes | Repository name |
| prNumber | number | Yes | Pull request number |

**Output:**
- Review suggestions with priority levels
- Quality score (0-100)
- Recommended action (approve, request changes, comment)
- Categorized feedback

**Example:**
```json
{
  "owner": "myorg",
  "repo": "myapp",
  "prNumber": 42
}
```

**Sample Output:**
```json
{
  "suggestions": [
    {
      "type": "security",
      "priority": "high",
      "file": "src/api/auth.ts",
      "line": 45,
      "message": "Potential SQL injection vulnerability",
      "suggestion": "Use parameterized queries instead of string concatenation"
    }
  ],
  "qualityScore": 72,
  "recommendedAction": "REQUEST_CHANGES"
}
```

## Features

- **Rate Limiting**: Automatic handling of GitHub API rate limits
- **Retry Logic**: Exponential backoff for transient failures
- **Pattern Detection**: Comprehensive security and quality patterns
- **Risk Assessment**: Automatic PR risk scoring

## Required GitHub Token Scopes

- `repo` - Full control of private repositories
- `read:org` - Read org membership (for org repos)

## Dependencies

- `@octokit/rest` - GitHub API client
- `parse-diff` - Unified diff parsing
- `@modelcontextprotocol/sdk` - MCP protocol
- `zod` - Input validation

## License

MIT
