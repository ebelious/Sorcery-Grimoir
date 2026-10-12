#!/usr/bin/env python3
"""rulebook-files.py -- every file the app reads about the rulebook, made from rulebook.pdf.

    python3 rulebook-files.py rulebook.pdf

Run by .github/workflows/update-rulebook.yml whenever a new rulebook.pdf arrives. In order:

1. rulebook.pdf, made light enough for a phone. When any picture in it is over 1200 px on its long edge
   (the official file is about 73 MB), the pictures are resized to 1200 px and saved as JPEG quality 70.
   That is how the app's copy was made in September (72.7 MB -> 17.7 MB). Text, fonts and drawings are
   not touched, and every page's text is compared before and after to prove it.
   A PDF whose pictures are already that size (the app's own copy) is left exactly as it is.
2. rulebook-strings.en.json: the text to translate, made by extract-rulebook.py. The translation job
   (translate-rulebook.yml) reads it.
3. rulebook-text.json: the text the app's global search reads, page by page.
4. rulebook.json: what the app checks when Manually Pull Data runs. It holds the size and SHA-256 of
   each file above. It has no date, so the same PDF always produces the same file and nothing new is
   committed.

A file whose content would not change is not rewritten. Any check that fails stops the run with a
message, and no file is changed.
"""
import hashlib, io, json, os, re, subprocess, sys

import pymupdf
from PIL import Image

MAX_EDGE = 1200            # px, long edge of a picture after compression
JPEG_Q = 70
MAX_IN = 200 * 1024 * 1024  # a PDF larger than this is refused outright
MAX_OUT = 95 * 1024 * 1024  # GitHub refuses files over 100 MB
MIN_PIECES = 100            # fewer pieces of text than this: no usable text layer (a scanned PDF)

HERE = os.path.dirname(os.path.abspath(__file__))


def fail(msg):
    print('::error::' + msg)
    sys.exit(1)


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def page_texts(doc):
    return [pg.get_text('text') for pg in doc]


def write_if_changed(path, data):
    old = open(path, 'rb').read() if os.path.exists(path) else None
    if old == data:
        print(f'  {os.path.basename(path)}: unchanged')
        return False
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)
    print(f'  {os.path.basename(path)}: written ({len(data):,} bytes)')
    return True


def compress(pdf_bytes):
    """The September recompression's settings: each picture over MAX_EDGE (or over 120 KB) re-saved as JPEG
    at MAX_EDGE, kept only where it came out smaller. Returns the new bytes, or None if nothing needed it."""
    doc = pymupdf.open(stream=pdf_bytes, filetype='pdf')
    edges, seen = [], set()
    for p in doc:
        for im in p.get_images(full=True):
            if im[0] in seen:
                continue
            seen.add(im[0])
            info = doc.extract_image(im[0])
            edges.append(max(info['width'], info['height']))
    if not edges or max(edges) <= MAX_EDGE:
        print(f'  pictures: {len(edges)}, largest {max(edges) if edges else 0} px: already phone-sized, PDF left as it is')
        return None
    before = page_texts(doc)
    # each picture once, listed before any is replaced, so a picture already re-saved is never re-saved again
    targets, seen = [], set()
    for p in doc:
        for im in p.get_images(full=True):
            if im[0] not in seen:
                seen.add(im[0])
                targets.append((p.number, im[0]))
    replaced = 0
    for pno, x in targets:
        info = doc.extract_image(x)
        try:
            img = Image.open(io.BytesIO(info['image']))
        except Exception:
            continue
        w, h = img.size
        if max(w, h) <= MAX_EDGE and len(info['image']) < 120000:
            continue
        if img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')
        if max(w, h) > MAX_EDGE:
            r = MAX_EDGE / max(w, h)
            img = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=JPEG_Q, optimize=True)
        if buf.tell() < len(info['image']):
            doc[pno].replace_image(x, stream=buf.getvalue())
            replaced += 1
    out = doc.tobytes(garbage=4, deflate=True, clean=True)
    after_doc = pymupdf.open(stream=out, filetype='pdf')
    if after_doc.page_count != doc.page_count:
        fail('compression changed the page count')
    if page_texts(after_doc) != before:
        fail('compression changed the text of a page; the PDF was left as it was')
    print(f'  pictures: {len(targets)}, {replaced} re-saved; {len(pdf_bytes)/1e6:.1f} MB -> {len(out)/1e6:.1f} MB; text of all {doc.page_count} pages identical')
    return out


def main():
    if len(sys.argv) != 2:
        fail('usage: python3 rulebook-files.py rulebook.pdf')
    pdf_path = os.path.abspath(sys.argv[1])
    folder = os.path.dirname(pdf_path)
    raw = open(pdf_path, 'rb').read()
    if len(raw) > MAX_IN:
        fail(f'{os.path.basename(pdf_path)} is {len(raw)/1e6:.0f} MB; over {MAX_IN // 1024 // 1024} MB is refused')
    if not raw.startswith(b'%PDF-'):
        fail(f'{os.path.basename(pdf_path)} is not a PDF (it does not start with %PDF-)')
    try:
        doc = pymupdf.open(stream=raw, filetype='pdf')
    except Exception as e:
        fail(f'the PDF could not be opened: {e}')
    if doc.needs_pass:
        fail('the PDF is password-protected')
    if doc.page_count < 1:
        fail('the PDF has no pages')
    print(f'{os.path.basename(pdf_path)}: {doc.page_count} pages, {len(raw)/1e6:.1f} MB')

    # 1. the PDF
    print('1. PDF')
    small = compress(raw)
    pdf_bytes = small if small is not None else raw
    if len(pdf_bytes) > MAX_OUT:
        fail(f'the PDF is still {len(pdf_bytes)/1e6:.0f} MB after compression; GitHub takes at most 100 MB')

    # 2. the text to translate (extract-rulebook.py reads a file, so it is given the final PDF)
    print('2. rulebook-strings.en.json')
    tmp_pdf = pdf_path + '.next.pdf'
    with open(tmp_pdf, 'wb') as f:
        f.write(pdf_bytes)
    try:
        run = subprocess.run([sys.executable, os.path.join(HERE, 'extract-rulebook.py'), tmp_pdf],
                             capture_output=True)
    finally:
        os.remove(tmp_pdf)
    if run.returncode != 0:
        fail('extract-rulebook.py failed: ' + run.stderr.decode('utf-8', 'replace')[-2000:])
    strings_bytes = run.stdout
    strings = json.loads(strings_bytes)
    if len(strings['pages']) != doc.page_count:
        fail(f"the text list has {len(strings['pages'])} pages; the PDF has {doc.page_count}")
    if len(strings['strings']) < MIN_PIECES:
        fail(f"only {len(strings['strings'])} pieces of text came out of the PDF (a scanned PDF has no text "
             f"layer); nothing was changed")
    print('  ' + run.stderr.decode('utf-8', 'replace').strip())

    # 3. the global search's text: September's method, unchanged
    print('3. rulebook-text.json')
    final = pymupdf.open(stream=pdf_bytes, filetype='pdf')
    pages = []
    for i, pg in enumerate(final):
        t = pg.get_text('text')
        t = re.sub(r'[ \t]+', ' ', t)
        t = re.sub(r'\n{2,}', '\n', t).strip()
        pages.append({'p': i + 1, 't': t})
    text_bytes = json.dumps({'pages': pages}, ensure_ascii=False).encode('utf-8')

    # 4. the manifest the app checks
    print('4. rulebook.json')
    first = (strings['pages'][0]['blocks'] or [{}])[0].get('text', '') if strings['pages'] else ''
    m = re.fullmatch(r'(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}', first)
    manifest = {
        'v': 1,
        'edition': m.group(0) if m else None,
        'pages': final.page_count,
        'files': {
            'rulebook.pdf': {'bytes': len(pdf_bytes), 'sha256': sha256(pdf_bytes)},
            'rulebook-strings.en.json': {'bytes': len(strings_bytes), 'sha256': sha256(strings_bytes)},
            'rulebook-text.json': {'bytes': len(text_bytes), 'sha256': sha256(text_bytes)},
        },
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode('utf-8')

    # every check passed: now the files are written
    print('writing:')
    write_if_changed(pdf_path, pdf_bytes)
    write_if_changed(os.path.join(folder, 'rulebook-strings.en.json'), strings_bytes)
    write_if_changed(os.path.join(folder, 'rulebook-text.json'), text_bytes)
    write_if_changed(os.path.join(folder, 'rulebook.json'), manifest_bytes)
    print(f"edition: {manifest['edition']}, {manifest['pages']} pages, {len(strings['strings'])} pieces of text")


if __name__ == '__main__':
    main()
