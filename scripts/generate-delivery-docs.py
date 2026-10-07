# Generate current delivery manuals with python-docx.
from pathlib import Path
import re, json, hashlib, html
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/docx-delivery-20261006'
OUT.mkdir(parents=True, exist_ok=True)
SOURCES = [
 ('docs/handoff/current-delivery-notes.md', '00_当前版本补充说明.docx', '当前版本补充说明'),
 ('docs/submissions/PROJECT_OVERVIEW.md', '01_项目总说明.docx', '班级管理本地智能体 项目总说明'),
 ('docs/submissions/INSTALLATION_MANUAL.md', '02_安装与部署手册.docx', '班级管理本地智能体 安装与部署手册'),
 ('docs/submissions/USER_MANUAL.md', '03_教师使用手册.docx', '班级管理本地智能体 教师使用手册'),
 ('docs/submissions/HANDOFF_AND_MAINTENANCE.md', '04_交接维护与开发记录.docx', '班级管理本地智能体 交接维护与开发记录'),
 ('docs/submissions/AGENT_DEVELOPMENT_AND_APPLICATION_REPORT.md', '05_开发与应用报告.docx', '班级管理本地智能体 开发与应用报告'),
 ('docs/submissions/DEMO_VIDEO_SCRIPT.md', '06_演示视频脚本.docx', '班级管理本地智能体 演示视频脚本'),
]

def clean(s):
    s = html.unescape(s)
    return re.sub(r'[\U0001F000-\U0001FAFF\u2300-\u23FF\u2600-\u27BF\uFE0F]', '', s)

def font(f, size, bold=False, east='Microsoft YaHei', latin='Calibri'):
    f.name = latin; f.size = Pt(size); f.bold = bold; f.color.rgb = RGBColor(0,0,0)
    fonts = f._element.get_or_add_rPr().get_or_add_rFonts()
    for key, val in [('ascii',latin),('hAnsi',latin),('eastAsia',east),('cs',latin)]:
        fonts.set(qn('w:'+key),val)

def add_inline(p, text, bold=False, italic=False):
    text = clean(text)
    pattern = r'(<br\s*/?>|\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<!\*)\*[^*]+\*(?!\*))'
    for part in re.split(pattern,text):
        if not part: continue
        if re.fullmatch(r'<br\s*/?>', part): p.add_run().add_break(); continue
        if part.startswith('**') and part.endswith('**'):
            add_inline(p,part[2:-2],True,italic); continue
        if part.startswith('*') and part.endswith('*'):
            add_inline(p,part[1:-1],bold,True); continue
        link = re.fullmatch(r'\[([^\]]+)\]\(([^)]+)\)',part)
        if link:
            label,url = link.groups()
            if url.startswith('#'): add_inline(p,label,bold,italic); continue
            h=OxmlElement('w:hyperlink'); h.set(qn('r:id'),p.part.relate_to(url,RT.HYPERLINK,is_external=True))
            run=OxmlElement('w:r'); props=OxmlElement('w:rPr')
            color=OxmlElement('w:color'); color.set(qn('w:val'),'235A83'); props.append(color)
            rf=OxmlElement('w:rFonts'); rf.set(qn('w:eastAsia'),'Microsoft YaHei'); rf.set(qn('w:ascii'),'Calibri'); props.append(rf)
            run.append(props); t=OxmlElement('w:t'); t.text=label; run.append(t); h.append(run); p._p.append(h); continue
        code = part.startswith('`') and part.endswith('`')
        r=p.add_run(part[1:-1] if code else part); r.bold=bold; r.italic=italic
        if code: font(r.font,10, bold, latin='Consolas')

def numbering(doc, ordered, start=1):
    root=doc.part.numbering_part.element
    aids=[int(x.get(qn('w:abstractNumId'))) for x in root.findall(qn('w:abstractNum'))]
    nids=[int(x.get(qn('w:numId'))) for x in root.findall(qn('w:num'))]
    aid=max(aids+[0])+1; nid=max(nids+[0])+1
    a=OxmlElement('w:abstractNum'); a.set(qn('w:abstractNumId'),str(aid))
    for level in range(4):
        lvl=OxmlElement('w:lvl'); lvl.set(qn('w:ilvl'),str(level))
        for tag, val in [('start',str(start)),('numFmt','decimal' if ordered else 'bullet'),('lvlText','%'+str(level+1)+'.' if ordered else '•'),('lvlJc','left')]:
            e=OxmlElement('w:'+tag); e.set(qn('w:val'),val); lvl.append(e)
        pp=OxmlElement('w:pPr'); ind=OxmlElement('w:ind'); ind.set(qn('w:left'),str(330+level*280)); ind.set(qn('w:hanging'),'220'); pp.append(ind); lvl.append(pp)
        rp=OxmlElement('w:rPr'); rf=OxmlElement('w:rFonts'); rf.set(qn('w:ascii'),'Calibri'); rf.set(qn('w:hAnsi'),'Calibri'); rp.append(rf); lvl.append(rp); a.append(lvl)
    root.append(a); n=OxmlElement('w:num'); n.set(qn('w:numId'),str(nid)); ref=OxmlElement('w:abstractNumId'); ref.set(qn('w:val'),str(aid)); n.append(ref); root.append(n)
    return nid

def para(doc,text,style=None):
    p=doc.add_paragraph(style=style); add_inline(p,text); return p

def make_table(doc, rows, widths=None):
    cols=len(rows[0]); t=doc.add_table(rows=1,cols=cols); t.autofit=False; t.alignment=WD_TABLE_ALIGNMENT.CENTER
    widths=widths or {2:[1.55,5.25],3:[1.50,2.60,2.70],4:[1.65,1.75,1.75,1.65]}.get(cols,[6.8/cols]*cols)
    for i,w in enumerate(widths): t.columns[i].width=Inches(w)
    props=t._tbl.tblPr
    borders=OxmlElement('w:tblBorders')
    for edge in ['top','left','bottom','right','insideH','insideV']:
        e=OxmlElement('w:'+edge); e.set(qn('w:val'),'single'); e.set(qn('w:sz'),'4'); e.set(qn('w:color'),'D9D9D9'); borders.append(e)
    props.append(borders)
    for ri,values in enumerate(rows):
        row=t.rows[0] if ri==0 else t.add_row()
        if ri==0:
            rep=OxmlElement('w:tblHeader'); row._tr.get_or_add_trPr().append(rep)
        for ci,(cell, val) in enumerate(zip(row.cells,values)):
            cell.width=Inches(widths[ci]); cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
            cp=cell._tc.get_or_add_tcPr(); shade=OxmlElement('w:shd'); shade.set(qn('w:fill'),'24475D' if ri==0 else ('F2F5F7' if ri%2 else 'FFFFFF')); cp.append(shade)
            mar=OxmlElement('w:tcMar')
            for side,value in [('top','100'),('bottom','100'),('left','120'),('right','120')]:
                e=OxmlElement('w:'+side); e.set(qn('w:w'),value); e.set(qn('w:type'),'dxa'); mar.append(e)
            cp.append(mar); p=cell.paragraphs[0]; p.paragraph_format.space_after=Pt(0); p.paragraph_format.line_spacing=1.2
            add_inline(p,val)
            for run in p.runs:
                font(run.font,10.5,ri==0 or bool(run.bold))
                if ri==0: run.font.color.rgb=RGBColor(255,255,255)
    doc.add_paragraph().paragraph_format.space_after=Pt(2)

def diagram(doc, lines):
    # Box drawing is Markdown presentation; preserve every text label in reading order.
    if any('智能中心' in x and '班务管理' in x for x in lines):
        rows=[]
        for line in lines:
            cells=[re.sub(r'[┌┐└┘├┤┬┴┼─━]', '', clean(x)).strip() for x in line.split('│')[1:-1]]
            if len(cells)==4: rows.append(cells)
            elif len(cells)==1 and cells[0]: para(doc,cells[0])
        make_table(doc,rows); return
    if any('当前位置' in x for x in lines):
        left=[]; right=[]
        for line in lines:
            cells=[re.sub(r'[┌┐└┘├┤┬┴┼─━]', '', clean(x)).strip() for x in line.split('│')[1:-1]]
            if len(cells)>=2:
                if cells[0]: left.append(cells[0])
                text='  '.join(c for c in cells[1:] if c)
                if text: right.append(text)
        make_table(doc,[['左侧导航栏','右侧工作区'],['<br>'.join(left),'<br>'.join(right)]],[2.05,4.75]); return
    for line in lines:
        line=clean(line)
        if not re.search(r'[\w\u4e00-\u9fff]',line): continue
        parts=[x.strip() for x in re.split(r'[│┃]',line)]
        text='  ·  '.join(x for x in parts if x)
        text=re.sub(r'[┌┐└┘├┤┬┴┼─━▼]', '',text).strip()
        if text:
            p=para(doc,text); p.paragraph_format.left_indent=Inches(.15); p.paragraph_format.space_after=Pt(3)

def code_block(doc,lines,lang):
    if any('┌' in x or '┬' in x for x in lines): diagram(doc,lines); return
    for line in lines:
        p=doc.add_paragraph(style='Code'); p.add_run(clean(line))
        p.paragraph_format.keep_with_next=False

def build(source,filename,title):
    raw=(ROOT/source).read_text(encoding='utf-8-sig'); lines=raw.splitlines()
    doc=Document(); sec=doc.sections[0]
    sec.page_width=Inches(8.5); sec.page_height=Inches(11)
    sec.top_margin=Inches(.78); sec.bottom_margin=Inches(.72); sec.left_margin=sec.right_margin=Inches(.85)
    sec.header_distance=sec.footer_distance=Inches(.32)
    normal=doc.styles['Normal']; font(normal.font,11)
    normal.paragraph_format.space_after=Pt(6); normal.paragraph_format.line_spacing=1.28; normal.paragraph_format.widow_control=True
    for name,size in [('Title',22),('Subtitle',12),('Heading 1',16),('Heading 2',13),('Heading 3',11.5),('Heading 4',11)]:
        st=doc.styles[name]; font(st.font,size,name not in ['Title','Subtitle']); st.paragraph_format.space_before=Pt(13 if name.startswith('Heading') else 0); st.paragraph_format.space_after=Pt(7)
        st.paragraph_format.keep_with_next=True
    # The bundled base template has a blue border on Title; remove all borders.
    for st in doc.styles:
        pp=st.element.find(qn('w:pPr'))
        if pp is not None:
            for border in list(pp.findall(qn('w:pBdr'))): pp.remove(border)
    code=doc.styles.add_style('Code',1); font(code.font,9.5,latin='Consolas'); code.paragraph_format.space_after=Pt(1); code.paragraph_format.line_spacing=1.15
    footer=sec.footer.paragraphs[0]; footer.alignment=WD_ALIGN_PARAGRAPH.CENTER
    r=footer.add_run('第 '); font(r.font,9)
    f=OxmlElement('w:fldSimple'); f.set(qn('w:instr'),'PAGE'); footer._p.append(f); r=footer.add_run(' 页'); font(r.font,9)
    doc.core_properties.title=title; doc.core_properties.subject='原始交付文档的 Word 格式转换'; doc.core_properties.author='Class Manager 项目'
    para(doc,title,'Title')
    # Original title blocks remain visible below the concise Word title.
    i=0; lists={}; previous_list=False
    while i<len(lines):
        line=lines[i]
        if not line.strip() or re.fullmatch(r'\s*[-*_]{3,}\s*',line): i+=1; continue
        if line.startswith('```'):
            lang=line[3:]; block=[]; i+=1
            while i<len(lines) and not lines[i].startswith('```'): block.append(lines[i]); i+=1
            code_block(doc,block,lang); i+=1; previous_list=False; continue
        heading=re.match(r'^(#{1,6})\s+(.+)',line)
        if heading:
            level=len(heading[1]); text=heading[2]
            if level==1:
                para(doc,text,'Subtitle')
            else:
                para(doc,text,'Heading '+str(min(level-1,4)))
            i+=1; previous_list=False; continue
        if line.lstrip().startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].lstrip().startswith('|'):
                vals=[v.strip() for v in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?[- ]+:?',v) for v in vals): rows.append(vals)
                i+=1
            if len(rows[0])==5 and rows[0][0] == '序号':
                make_table(doc,[[rows[0][0],rows[0][1]]]+[[r[0],r[1]] for r in rows[1:]], [1.1,5.7])
                for row in rows[1:]:
                    para(doc,f'分镜 {clean(row[0]).replace("**","")}  {clean(row[1]).replace("**","")}', 'Heading 2')
                    for field,val in zip(rows[0][2:],row[2:]):
                        para(doc,field.replace('**',''),'Heading 3'); para(doc,val)
            else: make_table(doc,rows)
            previous_list=False; continue
        m=re.match(r'^(\s*)([-+*]|\d+\.)\s+(.+)',line)
        if m:
            ordered=m[2].endswith('.'); level=min(len(m[1].expandtabs(4))//2,3)
            if not previous_list: lists={}
            key=(level,ordered)
            if key not in lists: lists[key]=numbering(doc,ordered,int(m[2][:-1]) if ordered else 1)
            p=para(doc,m[3]); np=OxmlElement('w:numPr')
            for tag,val in [('ilvl',level),('numId',lists[key])]:
                e=OxmlElement('w:'+tag); e.set(qn('w:val'),str(val)); np.append(e)
            p._p.get_or_add_pPr().append(np); p.paragraph_format.space_after=Pt(5)
            i+=1; previous_list=True; continue
        text=re.sub(r'^>\s*','',line); i+=1
        # Keep explicit Markdown hard line breaks, otherwise join wrapped prose.
        while i<len(lines) and lines[i].strip() and not re.match(r'^\s*(#{1,6}\s|```|\||[-+*]\s|\d+\.\s|>|---)',lines[i]) and not lines[i-1].endswith('  '):
            text+=' '+lines[i].strip(); i+=1
        para(doc,text); previous_list=False
    if filename == '07_新版教师工作台操作说明.docx':
        doc.styles['Normal'].paragraph_format.line_spacing = 1.15
        doc.styles['Normal'].paragraph_format.space_after = Pt(3)
    if filename in ['00_当前版本补充说明.docx', '07_新版教师工作台操作说明.docx']:
        sec.bottom_margin = Inches(1)
        # Keep each short instruction paragraph together above the page footer.
        for p in doc.paragraphs:
            p.paragraph_format.keep_together = True
    doc.save(OUT/filename)
    return {'source':source,'docx':filename,'title':title,'sourceSha256':hashlib.sha256((ROOT/source).read_bytes()).hexdigest(),'sha256':hashlib.sha256((OUT/filename).read_bytes()).hexdigest()}


from docx import Document
from docx.shared import Pt, Inches
import json, hashlib

sources = [(source, filename, '班级助手 ' + title.split(' ', 1)[-1]) for source, filename, title in SOURCES]
sources.append(('docs/handoff/redesigned-workspace-guide.md', '07_快速上手.docx', '班级助手快速上手'))
manifest = []
for source, filename, _ in sources:
    title = (ROOT / source).read_text(encoding='utf-8').splitlines()[0].removeprefix('# ')
    item = build(source, filename, title)
    doc = Document(OUT / filename)
    if doc.paragraphs[1].text == title:
        paragraph = doc.paragraphs[1]._element
        paragraph.getparent().remove(paragraph)
    doc.styles['Normal'].paragraph_format.line_spacing = 1.18
    doc.styles['Normal'].paragraph_format.space_after = Pt(4)
    if filename.startswith(('00_', '01_', '07_')):
        doc.styles['Normal'].paragraph_format.line_spacing = 1.15
        doc.styles['Normal'].paragraph_format.space_after = Pt(3)
        doc.sections[0].bottom_margin = Inches(.72)
    doc.save(OUT / filename)
    item['sha256'] = hashlib.sha256((OUT / filename).read_bytes()).hexdigest()
    manifest.append(item)
(OUT / 'conversion-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'documents': len(manifest), 'manifest': str(OUT / 'conversion-manifest.json')}, ensure_ascii=False))
