"""Generate small CC0 ingestion fixtures without Office/PDF authoring dependencies."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo
import json
ROOT = Path(__file__).resolve().parents[1] / 'src-tauri/src/ingest/tests/fixtures'
ROOT.mkdir(parents=True, exist_ok=True)
def archive(name, files):
    with ZipFile(ROOT / name, 'w', ZIP_DEFLATED) as z:
        for key, text in files.items():
            z.writestr(ZipInfo(key, (2020, 1, 1, 0, 0, 0)), text)
archive('structured.docx', {'word/document.xml': '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Fixture heading</w:t></w:r></w:p><w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'''})
archive('ordered.pptx', {
'ppt/presentation.xml':'<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
'ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
'ppt/slides/slide1.xml':'<slide><p><t>Last slide</t></p></slide>',
'ppt/slides/slide2.xml':'<slide><p><t>First slide</t></p></slide>'})
archive('sheets.xlsx', {
'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
'_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Metrics" sheetId="1" r:id="rId1"/></sheets></workbook>',
'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Alpha</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>'})
def pdf(pages):
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    kids = []
    for page in range(1, pages+1):
        page_id = len(objects)+1
        kids.append(f'{page_id} 0 R')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {page_id+1} 0 R >>'.encode())
        lines = [f'Prism fixture page {page}.'] + [f'Line {i}: Alpha beta gamma delta epsilon zeta eta theta.' for i in range(1, 9)]
        stream = ('BT /F1 12 Tf 50 740 Td 18 TL ' + ' T* '.join(f'({line}) Tj' for line in lines) + ' ET').encode()
        objects.append(f'<< /Length {len(stream)} >>\nstream\n'.encode()+stream+b'\nendstream')
    objects[1] = f'<< /Type /Pages /Count {pages} /Kids [{" ".join(kids)}] >>'.encode()
    data=bytearray(b'%PDF-1.4\n');offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(data));data.extend(f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n')
    xref=len(data);data.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:data.extend(f'{offset:010} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    (ROOT/f'text-{pages}.pdf').write_bytes(data)
for n in (1, 101, 150):pdf(n)

def wiki_page(title, heading, prose_paragraphs, table_name, table_rows, links):
    """Synthetic long-form article modeled on a Wikipedia line article: nav
    chrome, prose sections, one large station table, same-host links. All
    content is authored filler; markers pin ordering/table assertions."""
    prose = "\n".join(
        f"<p>SECTION-{i:03d}-MARKER Fixture prose about the line corridor, its history "
        f"and operations. Alpha beta gamma delta epsilon zeta eta theta iota kappa.</p>"
        for i in range(prose_paragraphs)
    )
    header = "".join(f"<th>Column {c}</th>" for c in range(5))
    rows = "\n".join(
        "<tr>" + "".join(
            f"<td>{'MID-TABLE-MARKER' if r == 20 and c == 2 else f'Cell {r}-{c}'}</td>"
            for c in range(5)
        ) + "</tr>"
        for r in range(table_rows)
    )
    anchors = "\n".join(f'<a href="{href}">{label}</a>' for href, label in links)
    return f"""<!DOCTYPE html>
<html><head><title>{title}</title></head><body>
<nav>CHROME-NAV-MARKER site navigation sidebar search login</nav>
<main><h1>{heading}</h1>
{prose}
<h2>{table_name}</h2>
<table><tr>{header}</tr>
{rows}
<tr><td>LAST-ROW-MARKER</td><td>Cell x-1</td><td>Cell x-2</td><td>Cell x-3</td><td>Cell x-4</td></tr>
</table>
{anchors}
</main>
<footer>CHROME-FOOTER-MARKER license text categories</footer>
<script>CHROME-SCRIPT-MARKER var x = 1;</script>
</body></html>"""

(ROOT/'wiki_index.html').write_text(wiki_page(
    "Fixture Line Index", "Fixture Line Index", 60, "Overview",
    8, [("/a", "Station Alpha"), ("/b", "Station Beta")]))
(ROOT/'wiki_a.html').write_text(wiki_page(
    "Fixture Station Alpha", "Fixture Station Alpha", 1500, "Station facilities",
    40, [("/b", "Station Beta")]))
(ROOT/'wiki_b.html').write_text(wiki_page(
    "Fixture Station Beta", "Fixture Station Beta", 600, "Exits",
    12, []))
(ROOT/'wiki_nested.html').write_text("""<!DOCTYPE html>
<html><head><title>Fixture Nested Tables</title></head><body>
<nav>CHROME-NAV-MARKER</nav>
<main><h1>Fixture Nested Tables</h1>
<p>TOP-PROSE-MARKER Fixture prose alpha beta gamma delta epsilon zeta eta theta iota kappa.</p>
<table><tr><th>Name</th><th>Value</th></tr>
<tr><td>TOP-CELL-MARKER</td><td>42</td></tr>
<tr><td colspan="2"><table><tr><td>NESTED-LEVEL1-MARKER<table><tr><td>NESTED-LEVEL2-MARKER<table><tr><td>NESTED-LEVEL3-MARKER</td></tr></table></td></tr></table></td></tr></table></td></tr>
</table>
<p>TAIL-PROSE-MARKER Fixture closing prose lambda mu nu xi omicron pi rho sigma tau.</p>
</main>
</body></html>""")
(ROOT/'LICENSE.txt').write_text('These synthetic fixtures were authored for Prism and are dedicated to the public domain under CC0-1.0. They contain no user documents.\n')
print(ROOT)
