# MCP Tools

A collection of production-level Model Context Protocol (MCP) servers for software development workflows.

## Packages

| Package | Description |
|---------|-------------|
| [git-analytics-mcp](./packages/git-analytics-mcp) | Repository insights, commit analysis, and code health metrics |
| [code-review-mcp](./packages/code-review-mcp) | GitHub PR review integration and code analysis |
| [architecture-visualizer-mcp](./packages/architecture-visualizer-mcp) | Dependency graphs, static analysis, and architecture visualization |

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/mcp-tools.git
cd mcp-tools

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Using with Claude Desktop

Add the MCP servers to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "git-analytics": {
      "command": "node",
      "args": ["/path/to/mcp-tools/packages/git-analytics-mcp/dist/index.js"]
    },
    "code-review": {
      "command": "node",
      "args": ["/path/to/mcp-tools/packages/code-review-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "your-github-token"
      }
    },
    "architecture-visualizer": {
      "command": "node",
      "args": ["/path/to/mcp-tools/packages/architecture-visualizer-mcp/dist/index.js"]
    }
  }
}
```

## Available Tools

### Git Analytics (5 tools)

- **search_commits** - Semantic search through commit history
- **analyze_code_churn** - Identify high-change files (hotspots)
- **get_contributor_stats** - Team contribution analytics
- **find_bug_introduction** - Git bisect-style bug tracking
- **get_repo_health** - Repository health score and recommendations

### Code Review (5 tools)

- **get_pr_details** - Fetch comprehensive PR information
- **analyze_pr_diff** - Analyze changes for security, performance, style issues
- **add_review_comment** - Add inline or general comments
- **submit_review** - Submit complete PR reviews
- **get_review_suggestions** - Generate review suggestions with quality score

### Architecture Visualizer (5 tools)

- **generate_dependency_graph** - Create dependency graphs (Mermaid/DOT/JSON)
- **detect_circular_dependencies** - Find circular imports
- **map_module_relationships** - Analyze coupling and cohesion
- **analyze_complexity** - Cyclomatic complexity metrics
- **get_architecture_overview** - High-level architecture summary

## Development

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @mcp-tools/git-analytics-mcp build

# Watch mode (in package directory)
cd packages/git-analytics-mcp
pnpm dev

# Type check
pnpm typecheck
```

## Project Structure

```
mcp-tools/
├── packages/
│   ├── git-analytics-mcp/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── tools/
│   │   │   └── utils/
│   │   └── package.json
│   │
│   ├── code-review-mcp/
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── tools/
│   │   │   └── utils/
│   │   └── package.json
│   │
│   └── architecture-visualizer-mcp/
│       ├── src/
│       │   ├── index.ts
│       │   ├── types.ts
│       │   ├── tools/
│       │   ├── parsers/
│       │   └── utils/
│       └── package.json
│
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## License

MIT
