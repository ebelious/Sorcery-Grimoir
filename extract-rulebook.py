#!/usr/bin/env python3
"""extract-rulebook.py -- the rulebook's text, page by page, as a list to translate.

    python3 extract-rulebook.py rulebook.pdf > rulebook-strings.en.json

Reads each page's words in the order the PDF holds them (which keeps each column and each box whole --
reading by position instead runs the two columns of the glossary into one another), and builds them into
headings, paragraphs and list items from the type: a heading is set at 13.5pt or more, the body at 12pt;
a new paragraph starts where the line spacing opens up, a list item at each bullet. Left out: what is not
prose -- the call-out numbers on the pictures, page numbers, the release line, the contents page's dotted
leaders and page numbers. Two quirks of this PDF are handled: its bold words sit 26pt higher than the line
they are on (measured per page, and allowed for), and symbols it draws as pictures (the circled numbers,
the element marks) leave a space before the punctuation, which is closed up.
Output: {"pages": [{"n", "blocks": [{"t": "h"|"p"|"li", "text", "u"}]}], "strings": [...]} -- each piece
as translate-ui.js and the app read it (plain text, &, < and > escaped).
"""
import json, re, statistics, sys
import pdfplumber

def esc(t): return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
def tidy(t):
    t = re.sub(r'\s+', ' ', t).strip()
    t = re.sub(r'\s+([.,;:)!?])', r'\1', t)
    t = re.sub(r'\(\s+', '(', t)
    t = re.sub(r'(\w) \((s|es)\)', r'\1(\2)', t)           # "location (s)" -> "location(s)"
    return t
def words_text(ws): return tidy(' '.join(w['text'] for w in ws))
def is_bold(w): return 'Bold' in w['fontname']
def style(w): return w['fontname'].split('+')[-1]
def plain(w): return not re.search(r'Bold|Italic', style(w))

pdf = pdfplumber.open(sys.argv[1])
pages = []
for n, page in enumerate(pdf.pages, 1):
    ws = page.extract_words(use_text_flow=True, keep_blank_chars=False, extra_attrs=['size', 'fontname'])
    # how far this page's bold and italic words sit from their line, for each face: measured where one
    # follows a plain word along a line
    # Measured against plain words first, then passed along: a bold-italic word inside an italic example
    # box is measured against the italic words around it, whose own offset is known by then.
    off = {}
    def known(w): return 0 if plain(w) else off.get(style(w))
    for _ in range(3):
        offs = {}
        for a, b in zip(ws, ws[1:]):
            if b['size'] >= 13.5 or a['size'] >= 13.5 or b['x0'] < a['x1'] - 2 or style(a) == style(b): continue
            ka, kb = known(a), known(b)
            if ka is not None and kb is None: offs.setdefault(style(b), []).append(a['top'] + ka - b['top'])
            if kb is not None and ka is None: offs.setdefault(style(a), []).append(b['top'] + kb - a['top'])
        for k, v in offs.items():
            if k not in off: off[k] = statistics.median(v)
    def top(w): return w['top'] + (off.get(style(w), 0) if w['size'] < 13.5 else 0)
    blocks, cur = [], None
    def close():
        global cur
        if cur and cur['ws'] and cur['t'] != 'h' and cur.get('lines') and all(is_bold(x) for x in cur['lines'][0]) \
                and not re.search(r'[.:]$', words_text(cur['lines'][0])) and len(cur['lines'][0]) <= 9:
            first = cur['lines'][0]                                       # a bold line on its own: a small heading
            blocks.append({'t': 'h', 'text': words_text(first)})
            cur['ws'] = cur['ws'][len(first):]; cur['lines'] = cur['lines'][1:]
        if cur and cur['ws']:
            t = words_text(cur['ws'])
            t = re.sub(r'\s*\.{3,}\s*\d*\s*$', '', t)                     # a contents line's leader and page
            if re.search(r'[A-Za-z]{2}', t) and not re.fullmatch(r'Rulebook released .*', t):
                blocks.append({'t': cur['t'], 'text': t})
        cur = None
    for w in ws:
        head = w['size'] >= 13.5
        if head:
            if not re.search(r'[A-Za-z]', w['text']) and (cur is None or cur['t'] != 'h'):
                continue                                                  # a call-out number or a page number
            if cur and cur['t'] == 'h' and abs(w['size'] - cur['size']) < 1.5:
                cur['ws'].append(w); continue
            close(); cur = {'t': 'h', 'ws': [w], 'size': w['size']}; continue
        if w['text'] in ('•',):
            close(); cur = {'t': 'li', 'ws': [], 'size': 12, 'x1': w['x1'], 'line': top(w), 'lines': [[]]}; continue
        if cur is None or cur['t'] == 'h':
            close(); cur = {'t': 'p', 'ws': [w], 'size': 12, 'x1': w['x1'], 'line': top(w), 'lines': [[w]]}; continue
        if w['x0'] >= cur['x1'] - 2 and abs(top(w) - cur['line']) < 6:   # on, along the same line
            cur['ws'].append(w); cur['x1'] = w['x1']; cur['lines'][-1].append(w); continue
        # a new line: the same paragraph if it follows at the body's line spacing (14.4pt)
        pitch = top(w) - cur['line']
        toc = bool(re.search(r'\.{3,}', ' '.join(x['text'] for x in cur['ws'][-3:])))
        if 10 <= pitch <= 16 and not toc:
            cur['ws'].append(w); cur['x1'] = w['x1']; cur['line'] = top(w); cur['lines'].append([w]); continue
        close(); cur = {'t': 'p', 'ws': [w], 'size': 12, 'x1': w['x1'], 'line': top(w), 'lines': [[w]]}
    close()
    # the contents page: a dotted leader and its page number end an entry wherever they fall -- at the end of
    # a bold entry read as a small heading ("Introduction......3"), or between two entries the PDF runs into
    # one line ("Casting Magics......19 Activating Abilities"). The first part keeps its kind; what follows is
    # the next entry. Three or more dots followed by a page number: an ellipsis in prose is not split.
    cut = []
    for b in blocks:
        parts = [tidy(x) for x in re.split(r'\s*\.{3,}\s*\d+\s*', b['text'])]
        parts = [x for x in parts if re.search(r'[A-Za-z]{2}', x)]
        for i, x in enumerate(parts): cut.append({'t': b['t'] if i == 0 else 'p', 'text': x})
    blocks = cut
    # a label set apart from its text ("Step 1:" / "Untap all of your cards ...") joined back to it, and a
    # heading the page draws twice over itself for effect ("Quick Reference Guide Quick Reference Guide") once
    joined = []
    for b in blocks:
        if joined and joined[-1]['t'] == 'p' and b['t'] == 'p' and len(joined[-1]['text']) <= 40 and joined[-1]['text'].endswith(':'):
            joined[-1]['text'] = joined[-1]['text'] + ' ' + b['text']; continue
        if b['t'] == 'h':
            m = re.fullmatch(r'(.+?) \1', b['text'])
            if m: b['text'] = m.group(1)
        joined.append(b)
    pages.append({'n': n, 'blocks': joined})

strings, seen = [], set()
for p in pages:
    for b in p['blocks']:
        b['u'] = esc(b['text'])
        if b['u'] not in seen: seen.add(b['u']); strings.append(b['u'])
json.dump({'source': 'rulebook.pdf', 'pages': pages, 'strings': strings}, sys.stdout, ensure_ascii=False, indent=0)
print()
print(f'{len(pages)} pages, {len(strings)} pieces, {sum(len(s) for s in strings)} characters', file=sys.stderr)
