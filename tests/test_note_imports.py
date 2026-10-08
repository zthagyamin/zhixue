import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from note_imports import read_local_documents, learning_items, SourceError

class NoteImportTests(unittest.TestCase):
    def test_markdown_and_text_sources_are_readonly_and_have_stable_units(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);p=root/'中文 notes.md';p.write_text('# 标题\n\n## 原理\n这是原始参考内容。\n\n## 例子\n另一个章节。\n',encoding='utf-8');before=p.read_bytes()
            docs=read_local_documents(root);items=learning_items(docs,'source-one')
            self.assertEqual(len(items),2);self.assertEqual(p.read_bytes(),before)
            p.write_text(p.read_text(encoding='utf-8')+'\n## 新章节\n新内容。\n',encoding='utf-8')
            later=learning_items(read_local_documents(root),'source-one')
            self.assertEqual([i['identity'] for i in items],[i['identity'] for i in later[:2]])
            self.assertNotEqual(items[0]['identity'],learning_items(docs,'different-source')[0]['identity'])
    def test_notion_export_zip_uses_page_ids_and_handles_csv(self):
        with tempfile.TemporaryDirectory() as temporary:
            p=Path(temporary)/'export.zip';identifier='1'*32
            with zipfile.ZipFile(p,'w') as z:
                z.writestr('My page '+identifier+'.md','# Notes\n\n## Topic\nA real explanation.\n')
                z.writestr('words.csv','word,meaning,example\nTree,树,A tree grows.\n')
            docs=read_local_documents(p);items=learning_items(docs,'source-one')
            self.assertEqual(len(items),2);self.assertTrue(any(i['kind']=='vocabulary' for i in items));self.assertTrue(any(identifier in d['key'] for d in docs))
    def test_archive_traversal_is_rejected_without_extracting(self):
        with tempfile.TemporaryDirectory() as temporary:
            p=Path(temporary)/'bad.zip'
            with zipfile.ZipFile(p,'w') as z:z.writestr('../outside.md','# Bad')
            with self.assertRaisesRegex(SourceError,'source-unsafe-archive'):read_local_documents(p)
            self.assertFalse((p.parent.parent/'outside.md').exists())
    def test_html_strips_scripts_and_preserves_headings_and_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            p=Path(temporary)/'Notion.html';p.write_text('<h1>Title</h1><h2>Topic</h2><p>Useful content.</p><script>never execute</script>',encoding='utf-8')
            doc=read_local_documents(p)[0];self.assertNotIn('never execute',doc['markdown']);self.assertIn('## Topic',doc['markdown']);self.assertEqual(len(learning_items([doc],'source-one')),1)
    def test_generated_learning_records_and_empty_content_do_not_become_new_questions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'state.md').write_text('---\ntype: zhixue-practice-state\n---\n# State\n',encoding='utf-8')
            (root/'notion-results.md').write_text('zhixue-notion-results-v1\nGenerated result',encoding='utf-8')
            with self.assertRaisesRegex(SourceError,'source-no-documents'):read_local_documents(root)

if __name__=='__main__':unittest.main()
