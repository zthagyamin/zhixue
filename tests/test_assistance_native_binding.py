"""Only temporary learning vaults and the isolated Companion fixture are used."""
import json
import unittest
import test_gateway_server as fixtures
import index_gateway as gateway


class AssistanceNativeBindingTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.GatewayServerTests(); self.fixture.setUp(); self.addCleanup(self.fixture.tearDown)
        self.vault = self.fixture.vault

    def item(self):
        return gateway.load_gateway(self.vault)['subjects'][0]['items'][0]

    def bound_payload(self):
        item = self.item(); payload = self.fixture.payload()
        payload['attemptBinding'] = dict(schemaVersion=1, eventId=payload['event']['eventId'], coreHash=payload['event']['coreHash'],
                                         contentHash=item['contentHash'], localBindingHash=item.get('localBindingHash'), practiceMode='quiz')
        return payload

    def frozen(self):
        with fixtures.server.local_database() as db:
            return json.loads(db.execute('SELECT binding_json FROM study_event_bindings WHERE account_id=?', ('account',)).fetchone()[0])

    def test_read_binding_is_opaque_stable_and_covers_route_changes(self):
        before = self.item(); self.assertRegex(before.get('localBindingHash', ''), r'^[a-f0-9]{64}$')
        self.assertEqual(before['localBindingHash'], self.item()['localBindingHash'])
        index = self.vault / self.fixture.builder.entry / 'subjects/astronomy-fixture.md'
        index.write_text(index.read_text(encoding='utf-8').replace('/records"', '/new-records"'), encoding='utf-8')
        after = self.item(); self.assertEqual(before['contentHash'], after['contentHash']); self.assertNotEqual(before['localBindingHash'], after['localBindingHash'])

    def test_original_attempt_freezes_accepted_binding_in_its_existing_transaction(self):
        payload = self.bound_payload(); result = self.fixture.accept(payload)
        self.assertEqual(result['status'], 'accepted'); self.assertEqual(self.frozen().get('assistanceBinding'), payload['attemptBinding'])
        self.assertEqual(self.fixture.accept(payload)['status'], 'duplicate')
        self.assertEqual(self.frozen()['assistanceBinding'], payload['attemptBinding'])

    def test_source_changes_before_offline_delivery_block_only_auxiliary_binding(self):
        payload = self.bound_payload()
        self.fixture.source.write_text(self.fixture.source.read_text(encoding='utf-8').replace('Grounded explanation', 'New explanation'), encoding='utf-8')
        self.assertEqual(self.fixture.accept(payload)['status'], 'accepted')
        self.assertNotIn('assistanceBinding', self.frozen())
        self.assertEqual(self.frozen().get('assistanceBindingIssue'), 'source-changed')

    def test_invalid_sidecar_never_blocks_the_original_core_or_acquires_a_write_mapping(self):
        payload = self.bound_payload(); payload['attemptBinding']['practiceMode'] = ['quiz']
        self.assertEqual(self.fixture.accept(payload)['status'], 'accepted'); self.assertNotIn('assistanceBinding', self.frozen())
        self.assertEqual(self.frozen().get('assistanceBindingIssue'), 'baseline-unverified')

    def test_old_core_without_submission_binding_cannot_be_rebound_by_a_later_retry(self):
        original = self.fixture.payload(); self.assertEqual(self.fixture.accept(original)['status'], 'accepted')
        payload = self.bound_payload(); self.assertEqual(self.fixture.accept(payload)['status'], 'duplicate')
        self.assertNotIn('assistanceBinding', self.frozen())
