# Git Analytics MCP

An MCP server providing Git repository analytics, commit search, code churn analysis, and repository health metrics.

## Installation

```bash
npm install
npm run build
```

## Configuration

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "git-analytics": {
      "command": "node",
      "args": ["/path/to/git-analytics-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### search_commits

Semantic search through commit history using keywords, date ranges, and authors.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | Yes | Search term to match against commit messages |
| path | string | No | Filter by file path |
| author | string | No | Filter by author name or email |
| since | string | No | Start date (ISO 8601 or relative like "2 weeks ago") |
| until | string | No | End date |
| limit | number | No | Maximum results (default: 50) |
| repoPath | string | No | Repository path (default: current directory) |

**Example:**
```json
{
  "query": "fix authentication",
  "author": "john",
  "since": "2024-01-01",
  "limit": 10
}
```

---

### analyze_code_churn

Identify files with high change frequency (hotspots) that may need refactoring.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | No | Directory to analyze |
| days | number | No | Lookback period in days (default: 90) |
| minChanges | number | No | Minimum changes threshold (default: 3) |
| repoPath | string | No | Repository path |

**Output:**
- List of files sorted by churn rate
- Change count, additions, deletions per file
- Summary with recommendations

**Example:**
```json
{
  "days": 30,
  "minChanges": 5
}
```

---

### get_contributor_stats

Team contribution analytics and activity patterns.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| since | string | No | Start date |
| until | string | No | End date |
| groupBy | string | No | Group by: "author", "week", or "month" |
| path | string | No | Filter by file path |
| repoPath | string | No | Repository path |

**Output:**
- Contributor rankings by commits
- Lines added/deleted per contributor
- Activity timeline
- Commit streaks

**Example:**
```json
{
  "groupBy": "month",
  "since": "2024-01-01"
}
```

---

### find_bug_introduction

Git bisect-style analysis to find when bugs or patterns were introduced.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | Yes | File or pattern to search |
| pattern | string | No | Code pattern to search for |
| since | string | No | Start date for search |
| repoPath | string | No | Repository path |

**Output:**
- Suspected commits with suspicion scores
- Timeline of changes
- Pattern match locations

**Example:**
```json
{
  "path": "src/auth/login.ts",
  "pattern": "TODO|FIXME|HACK"
}
```

---

### get_repo_health

Overall repository health metrics and recommendations.

**Input:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | No | Repository path to analyze |

**Output:**
- Health score (0-100) with letter grade (A-F)
- Metrics:
  - Commit frequency
  - Average commit size
  - Documentation ratio
  - Code churn rate
  - Contributor activity
  - Branch health
- Prioritized recommendations

**Example:**
```json
{
  "path": "/path/to/repo"
}
```

**Sample Output:**
```json
{
  "healthScore": 78,
  "grade": "B",
  "metrics": {
    "commitFrequency": { "score": 85, "value": 12.5, "unit": "commits/week" },
    "avgCommitSize": { "score": 70, "value": 45, "unit": "lines" },
    "documentationRatio": { "score": 65, "value": 0.08, "unit": "ratio" },
    "codeChurnRate": { "score": 80, "value": 0.15, "unit": "ratio" },
    "contributorActivity": { "score": 90, "value": 5, "unit": "active contributors" },
    "branchHealth": { "score": 75, "value": 8, "unit": "active branches" }
  },
  "recommendations": [
    "Consider adding more documentation...",
    "Some files have high churn rates..."
  ]
}
```

## Features

- **Caching**: Expensive Git operations are cached with TTL
- **Large Repo Support**: Efficient pagination and incremental parsing
- **Flexible Date Parsing**: Supports ISO 8601 and relative dates
- **Semantic Search**: Relevance scoring for commit search results

## Dependencies

- `simple-git` - Git operations
- `date-fns` - Date manipulation
- `@modelcontextprotocol/sdk` - MCP protocol
- `zod` - Input validation

## License

MIT
