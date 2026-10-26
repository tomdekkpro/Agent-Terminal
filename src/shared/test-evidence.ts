/**
 * Test evidence — proof on a ClickUp task that the developer tested a PR
 * before Code Review lets it pass.
 *
 * Evidence is a ClickUp comment, because that is the one place every
 * developer's runs land, whichever machine they ran on. It is one of:
 *  - a report posted by the dp plugin skills: /dp:tester-local (the one that
 *    tests unmerged code, so the usual one at review time), /dp:tester,
 *    /dp:qc-demo, /dp:qc-demo-auto;
 *  - a manual test note: a comment with `test:manual` and what was tested;
 *  - the developer's own write-up, when it has a test section ("TESTS
 *    (local)", "Test cases & results", "Unit tests: …") with results in it.
 *
 * Evidence only counts for the code under review: it must name the developer's
 * last own commit, or have been posted after it was made. Merge commits don't
 * count as new code — merging the base, or a branch the PR is stacked on, is
 * not something the developer is asked to test again.
 */

export type TestEvidenceSource = 'tester-local' | 'tester' | 'qc-demo' | 'qc-demo-auto' | 'manual' | 'summary';

export interface ParsedTestEvidence {
  source: TestEvidenceSource;
  /** Commit the run names — tester-local's `Branch: x @ <sha>`, or a dp-evidence line. */
  sha?: string;
  /** The run tested `sha` plus uncommitted changes — tester-local's
   *  `@ <sha> + uncommitted …`, the usual state before the PR exists. */
  uncommitted?: boolean;
  /** The run reported at least one failing case. */
  failed: boolean;
}

export interface TestEvidence extends ParsedTestEvidence {
  commentId: string;
  author: string;
  /** When the comment was posted, epoch ms. */
  postedAt: number;
  /** The evidence covers a commit before one or more merges into the branch. */
  mergedSince?: boolean;
}

/** A commit evidence is checked against. */
export interface EvidenceCommit {
  sha: string;
  /** When it was committed, epoch ms; null if GitHub won't say. */
  committedAt: number | null;
  parentShas?: string[];
}

/** Keywords that open a manual test note. */
export const MANUAL_TEST_KEYWORDS = ['test:manual', 'tested:manual'];

/** A manual note must say what was tested — a bare keyword is a rubber stamp. */
export const MIN_MANUAL_NOTE_LENGTH = 20;

/** `file` of the review finding raised when evidence is missing or failing. */
export const TEST_EVIDENCE_FINDING_FILE = 'Testing';

/** Sentence every test-evidence finding carries, so its review comment can be
 *  recognised from the ClickUp text alone. */
export const TEST_EVIDENCE_FINDING_MARKER = 'Code Review only passes tested code';

const SOURCE_LABELS: Record<TestEvidenceSource, string> = {
  'tester-local': '/dp:tester-local',
  tester: '/dp:tester',
  'qc-demo': '/dp:qc-demo',
  'qc-demo-auto': '/dp:qc-demo-auto',
  manual: 'manual test',
  summary: 'developer test summary',
};

export function testEvidenceSourceLabel(source: TestEvidenceSource): string {
  return SOURCE_LABELS[source];
}

/** "/dp:tester-local by Tom on 2026-10-21" */
export function describeTestEvidence(evidence: TestEvidence): string {
  const date = new Date(evidence.postedAt).toISOString().split('T')[0];
  const merged = evidence.mergedSince ? ' (only merges since)' : '';
  return `${testEvidenceSourceLabel(evidence.source)} by ${evidence.author} on ${date}${merged}`;
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * The machine-readable line a skill can add to its report, so detection never
 * depends on the wording of its headers:
 *   dp-evidence: skill=tester-local; task=DP2-26572; pr=7100; sha=a17912e; result=pass
 */
function parseEvidenceLine(text: string): ParsedTestEvidence | null {
  const line = text.match(/^[\s*_`]*dp-evidence:\s*(.+)$/im)?.[1];
  if (!line) return null;
  const fields = new Map<string, string>();
  for (const part of line.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key && rest.length) fields.set(key.trim().toLowerCase(), rest.join('=').trim().replace(/[`*_]+$/, ''));
  }
  const skill = (fields.get('skill') || '').replace(/^\/?dp:/i, '').toLowerCase();
  if (!(skill in SOURCE_LABELS)) return null;
  const sha = fields.get('sha');
  return {
    source: skill as TestEvidenceSource,
    sha: sha && SHA_PATTERN.test(sha) ? sha.toLowerCase() : undefined,
    failed: /^fail/i.test(fields.get('result') || ''),
  };
}

/** A skill report counts as failed when any case failed: "FAIL: 1", "FAIL     1",
 *  "1 FAIL, ...", or a QC summary whose result is FAILED. BLOCKED is not a failure. */
function reportFailed(text: string): boolean {
  return /\bFAIL\b\s*:?\s*[1-9]\d*/.test(text)
    // "1 FAIL, 2 BLOCKED" — but not the "7 / 7   FAIL: 0" of a passing report
    || /\b[1-9]\d*\s+FAIL\b(?!\s*:)/.test(text)
    || /^[\s*_]*ROUND\s+\d+:.*\bFAILED\b/im.test(text);
}

/** A line that opens a test section of a developer's write-up: "TESTS (local)",
 *  "Test cases & results — LOCAL", "**Unit tests**: …", "## Testing". */
const TEST_SECTION = /^[\s*_#>•-]*(?:[\w-]+[ \t]+){0,2}(?:tests?|testing|test cases|test results)\b/im;

/** A result inside a test section: "TC1 PASS", "PASSED", "4/4", "36 / 36",
 *  "2581 passed". */
const TEST_RESULT = /\bPASS(?:ED)?\b|\b\d+\s*\/\s*\d+\b|\b\d+\s+[Pp]assed\b/;

/** A case line whose verdict is FAIL. reportFailed misses it: "TC3 FAIL" has no
 *  count, and no word boundary before the 3. */
const CASE_FAILED = /^[\s*_>•-]*(?:TC\s*\d+[a-z]*|REG\w*|[A-Z]\d+[a-z]?)\s*[:—–-]?\s*FAIL(?:ED)?\b/m;

/** A developer's write-up with a test section that holds at least one result —
 *  so a comment that merely mentions testing doesn't count. */
function isTestWriteUp(text: string): boolean {
  const section = text.search(TEST_SECTION);
  return section >= 0 && TEST_RESULT.test(text.slice(section));
}

/**
 * Recognise test evidence in one comment's text. Returns null for anything
 * else — including a `test:manual` note too short to say what was tested.
 *
 * Callers must drop the bot's own comments first: they quote `test:manual` in
 * their instructions.
 */
export function parseTestEvidence(text: string): ParsedTestEvidence | null {
  if (!text) return null;

  const tagged = parseEvidenceLine(text);
  if (tagged) return tagged;

  // Skill report headers (dp plugin 0.55). `[\s*_]*` tolerates markdown bold.
  if (/^[\s*_]*LOCAL VERIFICATION\b/im.test(text)) {
    // "Branch:   fix @ a17912e (+ uncommitted: yes)" per the template, or as
    // written in practice: "branch Releases/26.9.1 @ bc8ef1013c + uncommitted CSS change".
    const at = text.match(/\bbranch:?\s+\S+\s*@\s*([0-9a-f]{7,40})\b([^\n]*)/i);
    return {
      source: 'tester-local',
      sha: at?.[1].toLowerCase(),
      uncommitted: !!at && /\+\s*uncommitted(?!:\s*no\b)/i.test(at[2]),
      failed: reportFailed(text),
    };
  }
  if (/^[\s*_]*VERIFICATION ON\b/im.test(text)) {
    return { source: 'tester', failed: reportFailed(text) };
  }
  if (/^[\s*_]*(?:QC ROUND\s+\d+\b|ROUND\s+\d+:\s*Verify on Demo)/im.test(text)) {
    return {
      source: /auto-approved/i.test(text) ? 'qc-demo-auto' : 'qc-demo',
      failed: reportFailed(text),
    };
  }

  // Only a case line that says FAIL fails a write-up: its prose often holds a
  // control run on the unfixed code ("Demo (unfixed): 10 of 10 FAIL").
  if (isTestWriteUp(text)) {
    return { source: 'summary', failed: CASE_FAILED.test(text) };
  }

  // The keyword must open the comment, so "please comment test:manual with
  // what you tested" from a reviewer is not mistaken for a test note.
  const opening = text.replace(/^[\s*_`>]+/, '').toLowerCase();
  const keyword = MANUAL_TEST_KEYWORDS.find((kw) => opening.startsWith(kw));
  if (keyword) {
    const note = opening.slice(keyword.length).replace(/[\s*_`]+/g, ' ').trim();
    return note.length >= MIN_MANUAL_NOTE_LENGTH ? { source: 'manual', failed: false } : null;
  }
  return null;
}

/**
 * The evidence that covers a PR's head: the newest comment that names the head
 * commit, or was posted after it was committed, or tested the head's parent
 * plus uncommitted changes. Null when nothing covers it.
 *
 * The last case is how /dp:tester-local runs before a PR exists: it tests
 * `<parent> + uncommitted`, then the developer commits that work as the head
 * and opens the PR, so the report predates the commit it covers. Only the
 * parent counts — a second commit after the run is untested code.
 *
 * `head.committedAt` null means the commit date couldn't be read — then any
 * evidence counts, since freshness can't be judged.
 */
export function findCoveringEvidence(
  evidence: TestEvidence[],
  head: EvidenceCommit,
): TestEvidence | null {
  let best: TestEvidence | null = null;
  for (const e of evidence) {
    const namesHead = sameCommit(e.sha, head.sha);
    const postedAfter = head.committedAt === null || e.postedAt > head.committedAt;
    const testedBeforeCommit = !!e.uncommitted && (head.parentShas ?? []).some((p) => sameCommit(e.sha, p));
    if ((namesHead || postedAfter || testedBeforeCommit) && (!best || e.postedAt > best.postedAt)) best = e;
  }
  return best;
}

/**
 * findCoveringEvidence for a head that may be a merge. `chain` is the head,
 * then — while the commit is a merge — its first parent, newest first, ending
 * at the developer's last own commit. Evidence for any of them covers the PR:
 * a merge brings in code tested and reviewed elsewhere (the base, or the PR
 * this one is stacked on). Marked `mergedSince` when it covers a commit before
 * a merge.
 */
export function findCoveringEvidenceThroughMerges(
  evidence: TestEvidence[],
  chain: EvidenceCommit[],
): TestEvidence | null {
  let best: TestEvidence | null = null;
  let mergedSince = false;
  for (let i = 0; i < chain.length; i++) {
    const covering = findCoveringEvidence(evidence, chain[i]);
    if (covering && (!best || covering.postedAt > best.postedAt)) {
      best = covering;
      mergedSince = i > 0;
    }
  }
  return best && mergedSince ? { ...best, mergedSince: true } : best;
}

/** Same commit, either sha possibly abbreviated. */
function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * True for a Code Review failure comment whose ONLY finding is missing or
 * failing test evidence. Auto Code can't fix that by changing code — the
 * developer has to test — so it waits instead of starting a review-fix run.
 */
export function isTestEvidenceOnlyFailure(reviewCommentText: string): boolean {
  const count = reviewCommentText.match(/(\d+)\s+issue\(s\) found/i)?.[1];
  return count === '1' && reviewCommentText.includes(TEST_EVIDENCE_FINDING_MARKER);
}
