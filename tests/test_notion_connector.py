import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from notion_connector import NotionClient, NotionError, page_id

PAGE='11111111-1111-4111-8111-111111111111'
CHILD='22222222-2222-4222-8222-222222222222'


class NotionConnectorTests(unittest.TestCase):
    def test_page_identity_uses_path_not_view_query_or_arbitrary_host(self):
        self.assertEqual(page_id('https://www.notion.so/Study-'+PAGE.replace('-','')+'?v='+CHILD),PAGE)
        with self.assertRaises(NotionError):page_id('https://unrelated.example/'+PAGE)

    def test_full_markdown_expands_reported_subtrees_and_keeps_page_identity(self):
        calls=[]
        def send(method,path,body):
            calls.append(path)
            if path==f'/pages/{PAGE}':return {'id':PAGE,'properties':{'title':{'type':'title','title':[{'plain_text':'My notes'}]}}}
            if path==f'/pages/{PAGE}/markdown':return {'object':'page_markdown','id':PAGE,'markdown':f'# Topic A\n<unknown url="https://www.notion.so/{PAGE.replace("-", "")}#{CHILD.replace("-", "")}" alt="details"/>\n# Topic B\nB content.','truncated':True,'unknown_block_ids':[CHILD]}
            return {'object':'page_markdown','id':CHILD,'markdown':'Complete detail.','truncated':False,'unknown_block_ids':[]}
        document=NotionClient('synthetic-token',transport=send).read_page(PAGE)
        self.assertIn('Complete detail.',document['markdown']);self.assertLess(document['markdown'].index('Complete detail.'),document['markdown'].index('# Topic B'));self.assertEqual(document['key'],PAGE);self.assertEqual(len(calls),3)

    def test_result_page_moved_outside_explicit_parent_is_rejected(self):
        client=NotionClient('synthetic',transport=lambda *args:{'id':PAGE,'parent':{'page_id':CHILD},'markdown':'zhixue-notion-results-v1 marker'})
        self.assertFalse(client.verify_results_page(PAGE,'marker',PAGE))

    def test_unexpandable_truncation_and_generated_records_are_not_accepted_as_sources(self):
        def send(method,path,body):
            if path.endswith('/markdown'):return {'object':'page_markdown','id':PAGE,'markdown':'partial','truncated':True,'unknown_block_ids':[]}
            return {'id':PAGE,'properties':{}}
        with self.assertRaisesRegex(NotionError,'notion-incomplete-page'):NotionClient('synthetic',transport=send).read_page(PAGE)
        def generated(method,path,body):return {'object':'page_markdown','id':PAGE,'markdown':'zhixue-notion-results-v1','truncated':False,'unknown_block_ids':[]} if path.endswith('/markdown') else {'id':PAGE,'properties':{}}
        with self.assertRaisesRegex(NotionError,'source-is-generated'):NotionClient('synthetic',transport=generated).read_page(PAGE)

    def test_children_follow_all_pages_and_detect_cursor_cycles(self):
        calls=[]
        def send(method,path,body):
            calls.append(path)
            return {'results':[{'id':CHILD,'type':'child_page','child_page':{'title':'Daily'}}], 'has_more':len(calls)==1,'next_cursor':'cursor-two' if len(calls)==1 else None}
        self.assertEqual(len(NotionClient('synthetic',transport=send).children(PAGE)),2)
        self.assertIn('start_cursor=cursor-two',calls[1])
        with self.assertRaisesRegex(NotionError,'notion-incomplete-page'):
            NotionClient('synthetic',transport=lambda *args:{'results':[],'has_more':True,'next_cursor':'same'}).children(PAGE)

    def test_write_requests_target_only_explicit_parent_and_payload_is_bounded(self):
        calls=[]
        def send(method,path,body):
            calls.append((method,path,body))
            return {'id':CHILD,'parent':{'page_id':PAGE}} if method=='POST' else {'results':[{'id':CHILD}]}
        client=NotionClient('synthetic',transport=send)
        self.assertEqual(client.create_results_page(PAGE,'2026-09-08','marker'),CHILD)
        self.assertEqual(calls[0][2]['parent'],{'page_id':PAGE})
        client.append_result(CHILD,'真实学习结果\n记录标识：event-one')
        self.assertEqual(calls[-1][0:2],('PATCH',f'/blocks/{CHILD}/children'))
        with self.assertRaisesRegex(NotionError,'notion-result-too-large'):client.append_result(CHILD,'x'*2100)


if __name__=='__main__':unittest.main()
