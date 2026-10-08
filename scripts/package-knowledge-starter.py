"""Build the downloadable starter folder from its canonical public Markdown files."""
from pathlib import Path
import zipfile

def build(root):
    root=Path(root);entries={p.relative_to(root).as_posix():p.read_bytes() for p in root.rglob('*.md')}
    for name in ('vocabulary.md','python.md','concepts.md','course.md','paper.md'):
        entries['Starter/materials/'+name]=entries[name]
    with zipfile.ZipFile(root/'structure.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for name,raw in sorted(entries.items()):
            info=zipfile.ZipInfo('knowledge-starter-kit/'+name,(2026,9,8,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
            archive.writestr(info,raw)
    return len(entries)

if __name__=='__main__':print('Starter documents:',build(Path(__file__).resolve().parents[1]/'public/knowledge-starter-kit'))
