"""Course state projection must keep frontmatter authoritative without an H1."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from managed_markdown import replace_managed_block
from learning_result import _parse_frontmatter


class CourseProjectionFrontmatterTests(unittest.TestCase):
    def test_frontmatter_without_title_retains_its_position_and_original_bytes(self):
        for newline, bom in (('\n', ''), ('\r\n', ''), ('\n', '\ufeff')):
            header = bom + newline.join(('---', 'type: zhixue-practice-state', '---', ''))
            source = header + '原文保持在自己的区域。' + newline
            with self.subTest(newline=repr(newline), bom=bool(bom)):
                result = replace_managed_block(source, '%% BEGIN %%', '%% END %%', '记录')
                self.assertTrue(result.startswith(header))
                self.assertTrue(result.endswith('原文保持在自己的区域。' + newline))
                self.assertEqual(result.count('%% BEGIN %%'), 1)
                self.assertEqual(result.count('%% END %%'), 1)

    def test_state_frontmatter_only_can_be_parsed_after_first_and_repeated_projection(self):
        source = '---\ntype: zhixue-practice-state\n---\n'
        first = replace_managed_block(source, '%% BEGIN %%', '%% END %%', '首次记录')
        second = replace_managed_block(first, '%% BEGIN %%', '%% END %%', '下一次记录')
        self.assertEqual(_parse_frontmatter(first)['type'], 'zhixue-practice-state')
        self.assertEqual(_parse_frontmatter(second)['type'], 'zhixue-practice-state')
        self.assertTrue(second.startswith(source))
        self.assertNotIn('首次记录', second)


if __name__ == '__main__':
    unittest.main()
