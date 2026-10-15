"""Actual Companion Handler, temporary test data and a synthetic chat provider."""
import json
import pathlib
import sys
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/"tests"))
import test_companion_origin_policy as fixtures

test=fixtures.CompanionOriginPolicyTests()
try:
    test.setUp()
    test.configure_chat()
    test.bind_transport(fixtures.inline_chat_transport)
    events=[{"type":"delta","text":"Synthetic browser explanation."},{"type":"done","model":"fixture-model","provider":"chatgpt"}]
    provider=mock.patch.object(fixtures.server.study_ai_provider,"stream_chat",side_effect=lambda *_:iter(events))
    provider.start()
    test.addCleanup(provider.stop)
    fixtures.server.CONFIG["allowed_origins"]=[sys.argv[1]]
    print(json.dumps({"base":test.harness.base,"session":test.harness.session,"library":test.library,
        "request":test.chat_request}),flush=True)
    for line in sys.stdin:
        if line.strip()=="stop":
            break
finally:
    test.doCleanups()
