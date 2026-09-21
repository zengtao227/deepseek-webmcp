// The Side Panel shows DeepSeek answers as a small structured tree instead of the page's HTML.
// The provider content script builds it from the answer DOM; the background worker re-checks it
// here before storing it, and the panel rebuilds it with createElement + textContent only.
//
//   block: { type: 'paragraph' | 'heading' | 'list' | 'code' | 'quote' | 'table' | 'rule', ... }
//   run:   { text, bold?, italic?, strike?, code?, href? }
//
// Anything outside these limits collapses to [] so the panel falls back to the plain answer text
// instead of showing a silently truncated structure.

export const MAX_BLOCK_DEPTH = 3;
const MAX_BLOCKS = 300;
const MAX_NODES = 6000;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;
const MAX_LIST_ITEMS = 200;
const MAX_HREF_CHARS = 2048;
const SAFE_LANGUAGE = /^[A-Za-z0-9_+.#-]{1,32}$/;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// A link target comes from the DeepSeek page, so it is untrusted: javascript:, data: and relative
// URLs are dropped, and the run keeps its text.
export function safeHref(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HREF_CHARS) return null;
  try {
    const url = new URL(value);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

class LimitError extends Error {}

function spend(budget, nodes, chars = 0) {
  budget.nodes += nodes;
  budget.chars += chars;
  if (budget.nodes > MAX_NODES || budget.chars > MAX_TEXT_CHARS) throw new LimitError('limit');
}

function normalizeRuns(value, budget) {
  if (!Array.isArray(value)) return [];
  const runs = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || raw.text === '') continue;
    spend(budget, 1, raw.text.length);
    const run = { text: raw.text };
    if (raw.bold === true) run.bold = true;
    if (raw.italic === true) run.italic = true;
    if (raw.strike === true) run.strike = true;
    if (raw.code === true) run.code = true;
    const href = safeHref(raw.href);
    if (href) run.href = href;
    runs.push(run);
  }
  return runs;
}

function normalizeCells(value, budget) {
  if (!Array.isArray(value) || value.length > MAX_TABLE_COLUMNS) throw new LimitError('columns');
  return value.map((cell) => normalizeRuns(cell, budget));
}

function normalizeBlock(raw, depth, budget) {
  if (!raw || typeof raw !== 'object') return null;
  if (depth > MAX_BLOCK_DEPTH) throw new LimitError('depth');
  spend(budget, 1);

  switch (raw.type) {
    case 'paragraph':
      return { type: 'paragraph', runs: normalizeRuns(raw.runs, budget) };
    case 'heading': {
      const level = Number.isInteger(raw.level) ? Math.min(6, Math.max(1, raw.level)) : 3;
      return { type: 'heading', level, runs: normalizeRuns(raw.runs, budget) };
    }
    case 'code': {
      const text = typeof raw.text === 'string' ? raw.text : '';
      spend(budget, 0, text.length);
      return { type: 'code', lang: SAFE_LANGUAGE.test(raw.lang ?? '') ? raw.lang : '', text };
    }
    case 'rule':
      return { type: 'rule' };
    case 'quote':
      return { type: 'quote', blocks: normalizeBlockList(raw.blocks, depth + 1, budget) };
    case 'list': {
      if (!Array.isArray(raw.items) || raw.items.length > MAX_LIST_ITEMS) throw new LimitError('items');
      const items = raw.items.map((item) => {
        spend(budget, 1);
        return {
          runs: normalizeRuns(item?.runs, budget),
          blocks: normalizeBlockList(item?.blocks, depth + 1, budget),
        };
      });
      const list = { type: 'list', ordered: raw.ordered === true, items };
      if (list.ordered && Number.isInteger(raw.start) && raw.start >= 0 && raw.start < 100000) list.start = raw.start;
      return list;
    }
    case 'table': {
      const rows = Array.isArray(raw.rows) ? raw.rows : [];
      if (rows.length > MAX_TABLE_ROWS) throw new LimitError('rows');
      return {
        type: 'table',
        head: raw.head === undefined || raw.head === null ? null : normalizeCells(raw.head, budget),
        rows: rows.map((row) => normalizeCells(row, budget)),
      };
    }
    default:
      return null;
  }
}

function normalizeBlockList(value, depth, budget) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) throw new LimitError('blocks');
  return value.map((raw) => normalizeBlock(raw, depth, budget)).filter(Boolean);
}

export function normalizeBlocks(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  try {
    return normalizeBlockList(value, 1, { nodes: 0, chars: 0 });
  } catch (error) {
    if (error instanceof LimitError) return [];
    throw error;
  }
}

const runsText = (runs) => runs.map((run) => run.text).join('');

// Copy uses this: the rendered answer as readable text, without any markup characters that were
// not part of the answer itself.
export function blocksToPlainText(blocks) {
  const lines = [];
  appendBlocks(lines, Array.isArray(blocks) ? blocks : [], '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function appendBlocks(lines, blocks, indent) {
  for (const block of blocks) {
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
    appendBlock(lines, block, indent);
  }
}

function appendBlock(lines, block, indent) {
  if (block.type === 'paragraph' || block.type === 'heading') {
    lines.push(indent + runsText(block.runs));
  } else if (block.type === 'code') {
    for (const line of block.text.replace(/\n$/, '').split('\n')) lines.push(indent + line);
  } else if (block.type === 'rule') {
    lines.push(`${indent}---`);
  } else if (block.type === 'quote') {
    const inner = [];
    appendBlocks(inner, block.blocks, '');
    for (const line of inner) lines.push(`${indent}> ${line}`.trimEnd());
  } else if (block.type === 'list') {
    block.items.forEach((item, index) => {
      const marker = block.ordered ? `${(block.start ?? 1) + index}. ` : '- ';
      lines.push(indent + marker + runsText(item.runs));
      const inner = [];
      appendBlocks(inner, item.blocks, indent + '  ');
      for (const line of inner) if (line !== '') lines.push(line);
    });
  } else if (block.type === 'table') {
    const rows = block.head ? [block.head, ...block.rows] : block.rows;
    for (const row of rows) lines.push(indent + row.map(runsText).join(' | '));
  }
}
