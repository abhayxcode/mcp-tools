/**
 * Analytics Calculation Helpers
 */

import { format, differenceInDays, startOfWeek, startOfMonth, parseISO, isValid } from 'date-fns';
import type {
  FileChurn,
  ChurnSummary,
  ActivityTimeline,
  HealthMetric,
  CacheEntry,
} from '../types.js';

/**
 * Simple in-memory cache with TTL
 */
export class AnalyticsCache {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private defaultTTL: number;

  constructor(defaultTTL: number = 5 * 60 * 1000) { // 5 minutes default
    this.defaultTTL = defaultTTL;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.defaultTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, {
      key,
      data,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }

  generateKey(...parts: (string | number | undefined)[]): string {
    return parts.filter(p => p !== undefined).join(':');
  }
}

// Global cache instance
export const analyticsCache = new AnalyticsCache();

/**
 * Calculate churn rate (changes per day)
 */
export function calculateChurnRate(changes: number, days: number): number {
  if (days <= 0) return changes;
  return Math.round((changes / days) * 100) / 100;
}

/**
 * Identify hotspots based on churn threshold
 */
export function identifyHotspots(
  files: FileChurn[],
  options: {
    minChanges?: number;
    percentileThreshold?: number;
  } = {}
): FileChurn[] {
  const { minChanges = 3, percentileThreshold = 80 } = options;

  // Calculate the percentile threshold for churn rate
  const churnRates = files.map(f => f.churnRate).sort((a, b) => a - b);
  const percentileIndex = Math.floor(churnRates.length * (percentileThreshold / 100));
  const churnThreshold = churnRates[percentileIndex] ?? 0;

  return files
    .filter(f => f.changeCount >= minChanges && f.churnRate >= churnThreshold)
    .map(f => ({ ...f, isHotspot: true }))
    .sort((a, b) => b.churnRate - a.churnRate);
}

/**
 * Generate churn summary with recommendations
 */
export function generateChurnSummary(
  files: FileChurn[],
  startDate: Date,
  endDate: Date
): ChurnSummary {
  const days = Math.max(1, differenceInDays(endDate, startDate));
  const hotspots = files.filter(f => f.isHotspot);
  const totalChanges = files.reduce((sum, f) => sum + f.changeCount, 0);
  const avgChurnRate = files.length > 0
    ? files.reduce((sum, f) => sum + f.churnRate, 0) / files.length
    : 0;

  const recommendations: string[] = [];

  // Generate recommendations based on analysis
  if (hotspots.length > files.length * 0.2) {
    recommendations.push(
      'High number of hotspots detected. Consider refactoring frequently changing modules.'
    );
  }

  const highChurnFiles = hotspots.filter(f => f.churnRate > 1);
  if (highChurnFiles.length > 0) {
    recommendations.push(
      `${highChurnFiles.length} files change more than once per day. Review for potential instability.`
    );
  }

  const multiAuthorHotspots = hotspots.filter(f => f.authors.length > 3);
  if (multiAuthorHotspots.length > 0) {
    recommendations.push(
      `${multiAuthorHotspots.length} hotspots have many authors. Consider establishing clear ownership.`
    );
  }

  if (avgChurnRate > 0.5) {
    recommendations.push(
      'Overall churn rate is high. Consider implementing feature flags to reduce merge conflicts.'
    );
  }

  return {
    analyzedPeriod: {
      start: format(startDate, 'yyyy-MM-dd'),
      end: format(endDate, 'yyyy-MM-dd'),
      days,
    },
    totalFiles: files.length,
    totalChanges,
    hotspotCount: hotspots.length,
    hotspots: hotspots.slice(0, 20), // Top 20 hotspots
    averageChurnRate: Math.round(avgChurnRate * 100) / 100,
    recommendations,
  };
}

/**
 * Group commits by time period
 */
export function groupByPeriod(
  commits: Array<{ date: Date; author: string; insertions: number; deletions: number; filesChanged: number }>,
  groupBy: 'day' | 'week' | 'month'
): ActivityTimeline[] {
  const groups: Map<string, ActivityTimeline> = new Map();

  for (const commit of commits) {
    let periodKey: string;
    const date = commit.date;

    switch (groupBy) {
      case 'day':
        periodKey = format(date, 'yyyy-MM-dd');
        break;
      case 'week':
        periodKey = format(startOfWeek(date), 'yyyy-MM-dd');
        break;
      case 'month':
        periodKey = format(startOfMonth(date), 'yyyy-MM');
        break;
    }

    const existing = groups.get(periodKey);
    if (existing) {
      existing.commits++;
      if (!existing.authors.includes(commit.author)) {
        existing.authors.push(commit.author);
      }
      existing.insertions += commit.insertions;
      existing.deletions += commit.deletions;
      existing.filesChanged += commit.filesChanged;
    } else {
      groups.set(periodKey, {
        period: periodKey,
        commits: 1,
        authors: [commit.author],
        insertions: commit.insertions,
        deletions: commit.deletions,
        filesChanged: commit.filesChanged,
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Calculate contributor streak (consecutive days with commits)
 */
export function calculateStreak(commitDates: Date[]): { current: number; longest: number } {
  if (commitDates.length === 0) return { current: 0, longest: 0 };

  const sortedDates = [...commitDates].sort((a, b) => a.getTime() - b.getTime());
  const uniqueDays = new Set(sortedDates.map(d => format(d, 'yyyy-MM-dd')));
  const days = Array.from(uniqueDays).sort();

  let longest = 1;
  let current = 1;
  let streak = 1;

  for (let i = 1; i < days.length; i++) {
    const prevDay = days[i - 1];
    const currDay = days[i];

    if (!prevDay || !currDay) continue;

    const prev = parseISO(prevDay);
    const curr = parseISO(currDay);
    const diff = differenceInDays(curr, prev);

    if (diff === 1) {
      streak++;
      longest = Math.max(longest, streak);
    } else {
      streak = 1;
    }
  }

  // Check if the streak is current (includes today or yesterday)
  const lastCommitDay = days[days.length - 1];
  if (lastCommitDay) {
    const today = new Date();
    const lastCommit = parseISO(lastCommitDay);
    const daysSinceLastCommit = differenceInDays(today, lastCommit);
    current = daysSinceLastCommit <= 1 ? streak : 0;
  }

  return { current, longest };
}

/**
 * Calculate health metric score and status
 */
export function calculateHealthMetric(
  name: string,
  value: number,
  thresholds: { excellent: number; good: number; fair: number; poor: number },
  higherIsBetter: boolean = true,
  weight: number = 1,
  displayValue?: string
): HealthMetric {
  let score: number;
  let status: HealthMetric['status'];

  if (higherIsBetter) {
    if (value >= thresholds.excellent) {
      score = 90 + (value - thresholds.excellent) / thresholds.excellent * 10;
      status = 'excellent';
    } else if (value >= thresholds.good) {
      score = 70 + (value - thresholds.good) / (thresholds.excellent - thresholds.good) * 20;
      status = 'good';
    } else if (value >= thresholds.fair) {
      score = 50 + (value - thresholds.fair) / (thresholds.good - thresholds.fair) * 20;
      status = 'fair';
    } else if (value >= thresholds.poor) {
      score = 25 + (value - thresholds.poor) / (thresholds.fair - thresholds.poor) * 25;
      status = 'poor';
    } else {
      score = Math.max(0, value / thresholds.poor * 25);
      status = 'critical';
    }
  } else {
    // Lower is better (e.g., churn rate)
    if (value <= thresholds.excellent) {
      score = 90 + (thresholds.excellent - value) / thresholds.excellent * 10;
      status = 'excellent';
    } else if (value <= thresholds.good) {
      score = 70 + (thresholds.good - value) / (thresholds.good - thresholds.excellent) * 20;
      status = 'good';
    } else if (value <= thresholds.fair) {
      score = 50 + (thresholds.fair - value) / (thresholds.fair - thresholds.good) * 20;
      status = 'fair';
    } else if (value <= thresholds.poor) {
      score = 25 + (thresholds.poor - value) / (thresholds.poor - thresholds.fair) * 25;
      status = 'poor';
    } else {
      score = Math.max(0, 25 - (value - thresholds.poor) / thresholds.poor * 25);
      status = 'critical';
    }
  }

  score = Math.min(100, Math.max(0, Math.round(score)));

  const descriptions: Record<string, string> = {
    commitFrequency: `Average commits per week: ${displayValue ?? value}`,
    averageCommitSize: `Average lines changed per commit: ${displayValue ?? value}`,
    documentationRatio: `Documentation files ratio: ${displayValue ?? value}%`,
    codeChurnRate: `Code churn rate: ${displayValue ?? value} changes/file/week`,
    contributorActivity: `Active contributors in last 30 days: ${displayValue ?? value}`,
    branchHealth: `Stale branches: ${displayValue ?? value}`,
  };

  return {
    name,
    score,
    weight,
    status,
    value: displayValue ?? value,
    description: descriptions[name] ?? `${name}: ${displayValue ?? value}`,
  };
}

/**
 * Calculate overall health score from individual metrics
 */
export function calculateOverallScore(metrics: HealthMetric[]): number {
  const totalWeight = metrics.reduce((sum, m) => sum + m.weight, 0);
  const weightedScore = metrics.reduce((sum, m) => sum + m.score * m.weight, 0);
  return Math.round(weightedScore / totalWeight);
}

/**
 * Convert score to letter grade
 */
export function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Generate health recommendations based on metrics
 */
export function generateHealthRecommendations(
  metrics: Record<string, HealthMetric>
): Array<{ priority: 'high' | 'medium' | 'low'; category: string; message: string; action: string }> {
  const recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    category: string;
    message: string;
    action: string;
  }> = [];

  // Commit frequency recommendations
  if (metrics.commitFrequency && metrics.commitFrequency.status === 'poor' || metrics.commitFrequency?.status === 'critical') {
    recommendations.push({
      priority: 'high',
      category: 'Activity',
      message: 'Very low commit frequency detected',
      action: 'Consider breaking work into smaller, more frequent commits for better tracking and easier code reviews',
    });
  }

  // Commit size recommendations
  if (metrics.averageCommitSize && (metrics.averageCommitSize.status === 'poor' || metrics.averageCommitSize.status === 'critical')) {
    recommendations.push({
      priority: 'medium',
      category: 'Commit Quality',
      message: 'Commits are too large on average',
      action: 'Break down changes into smaller, atomic commits that are easier to review and revert if needed',
    });
  }

  // Documentation recommendations
  if (metrics.documentationRatio && (metrics.documentationRatio.status === 'poor' || metrics.documentationRatio.status === 'critical')) {
    recommendations.push({
      priority: 'medium',
      category: 'Documentation',
      message: 'Low documentation ratio',
      action: 'Add README files, inline comments, and API documentation to improve code maintainability',
    });
  }

  // Code churn recommendations
  if (metrics.codeChurnRate && (metrics.codeChurnRate.status === 'poor' || metrics.codeChurnRate.status === 'critical')) {
    recommendations.push({
      priority: 'high',
      category: 'Code Stability',
      message: 'High code churn rate indicates instability',
      action: 'Review frequently changing files for potential architectural issues or unclear requirements',
    });
  }

  // Contributor activity recommendations
  if (metrics.contributorActivity && (metrics.contributorActivity.status === 'poor' || metrics.contributorActivity.status === 'critical')) {
    recommendations.push({
      priority: 'low',
      category: 'Team',
      message: 'Low contributor diversity',
      action: 'Encourage more team members to contribute and consider knowledge sharing sessions',
    });
  }

  // Branch health recommendations
  if (metrics.branchHealth && (metrics.branchHealth.status === 'poor' || metrics.branchHealth.status === 'critical')) {
    recommendations.push({
      priority: 'low',
      category: 'Repository',
      message: 'Too many stale branches',
      action: 'Clean up merged and abandoned branches to keep the repository organized',
    });
  }

  return recommendations.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
}

/**
 * Safely parse a date string with fallback
 */
export function safeParseDateString(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;

  try {
    // Try ISO format first
    const isoDate = parseISO(dateStr);
    if (isValid(isoDate)) return isoDate;

    // Try standard Date parsing
    const standardDate = new Date(dateStr);
    if (isValid(standardDate)) return standardDate;

    return null;
  } catch {
    return null;
  }
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${Math.round(value * 100) / 100} ${units[unitIndex]}`;
}

/**
 * Calculate percentile value from an array
 */
export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;

  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}
