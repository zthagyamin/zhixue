"""Preview subject-owned planning metadata; applying an existing preview is explicit."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from planning_migration import apply_planning_migration, preview_planning_migration, rollback_planning_migration


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', required=True)
    parser.add_argument('--proposals')
    parser.add_argument('--manifest')
    parser.add_argument('--backup-root')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    args = parser.parse_args(argv)
    try:
        vault = Path(args.vault).resolve(strict=True)
        if args.rollback:
            if not args.backup_root or args.proposals or args.manifest:
                parser.error('--rollback requires only --vault and the returned --backup-root')
            result = rollback_planning_migration(vault, Path(args.backup_root))
        elif args.apply:
            if not args.manifest or not args.backup_root or args.proposals:
                parser.error('--apply requires --manifest and --backup-root, not --proposals')
            manifest = json.loads(Path(args.manifest).read_text(encoding='utf-8-sig'))
            result = apply_planning_migration(vault, manifest, Path(args.backup_root))
        else:
            if not args.proposals or not args.manifest or args.backup_root:
                parser.error('preview requires --proposals and a new --manifest path')
            destination = Path(args.manifest).resolve()
            if destination.is_relative_to(vault):
                raise ValueError('preview-manifest-must-be-outside-vault')
            proposals = json.loads(Path(args.proposals).read_text(encoding='utf-8-sig'))
            manifest = preview_planning_migration(vault, proposals)
            with destination.open('x', encoding='utf-8', newline='\n') as handle:
                json.dump(manifest, handle, ensure_ascii=False, indent=2)
                handle.write('\n')
            result = {'status': 'preview-only', 'manifest': str(destination),
                      'targets': [{key: row[key] for key in ('relativePath', 'beforeHash', 'afterHash')}
                                  for row in manifest['targets']], 'diagnostics': manifest['diagnostics']}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
