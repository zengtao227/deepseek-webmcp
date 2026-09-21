// Rebuilds an answer's block tree (see answer-blocks.js) as DOM for the Side Panel. Everything is
// created with createElement and textContent; nothing from the provider page is parsed as HTML,
// and no DeepSeek class, style or script is reused. `doc` is a parameter so tests can pass a fake.

import { safeHref } from './answer-blocks.js';

function append(parent, ...children) {
  for (const child of children) parent.append(child);
  return parent;
}

function renderRun(doc, run) {
  // Line breaks inside a run come from <br> in the answer.
  let node = doc.createDocumentFragment();
  run.text.split('\n').forEach((line, index) => {
    if (index > 0) node.append(doc.createElement('br'));
    if (line !== '') node.append(doc.createTextNode(line));
  });

  if (run.code) node = append(doc.createElement('code'), node);
  if (run.italic) node = append(doc.createElement('em'), node);
  if (run.bold) node = append(doc.createElement('strong'), node);
  if (run.strike) node = append(doc.createElement('del'), node);
  const href = safeHref(run.href);
  if (href) {
    const link = doc.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    node = append(link, node);
  }
  return node;
}

function renderRuns(doc, parent, runs) {
  for (const run of runs) parent.append(renderRun(doc, run));
  return parent;
}

function renderCells(doc, row, cells, tag) {
  for (const cell of cells) row.append(renderRuns(doc, doc.createElement(tag), cell));
}

function renderBlock(doc, block) {
  switch (block.type) {
    case 'paragraph':
      return renderRuns(doc, doc.createElement('p'), block.runs);
    case 'heading':
      return renderRuns(doc, doc.createElement(`h${block.level}`), block.runs);
    case 'code': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = block.text;
      if (block.lang) pre.dataset.lang = block.lang;
      return append(pre, code);
    }
    case 'rule':
      return doc.createElement('hr');
    case 'quote':
      return renderBlocks(doc, doc.createElement('blockquote'), block.blocks);
    case 'list': {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      if (block.ordered && Number.isInteger(block.start) && block.start !== 1) list.start = block.start;
      for (const item of block.items) {
        const li = renderRuns(doc, doc.createElement('li'), item.runs);
        renderBlocks(doc, li, item.blocks);
        list.append(li);
      }
      return list;
    }
    case 'table': {
      const table = doc.createElement('table');
      if (block.head) {
        const headRow = doc.createElement('tr');
        renderCells(doc, headRow, block.head, 'th');
        table.append(append(doc.createElement('thead'), headRow));
      }
      const body = doc.createElement('tbody');
      for (const cells of block.rows) {
        const row = doc.createElement('tr');
        renderCells(doc, row, cells, 'td');
        body.append(row);
      }
      table.append(body);
      // The wrapper lets a wide table scroll instead of widening the panel.
      const wrap = doc.createElement('div');
      wrap.className = 'table-wrap';
      return append(wrap, table);
    }
    default:
      return null;
  }
}

export function renderBlocks(doc, parent, blocks) {
  for (const block of blocks ?? []) {
    const node = renderBlock(doc, block);
    if (node) parent.append(node);
  }
  return parent;
}
