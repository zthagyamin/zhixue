import sys,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from flashcard_support import expand_flashcard,child_id

class FlashcardSupportTests(unittest.TestCase):
    def test_reverse_preserves_forward_identity_and_is_idempotent(self):
        item={'id':'old','itemId':'old','abilityId':'concept','front':'Question','prompt':'Question','back':'Answer','learningSupport':{'schemaVersion':1,'type':'flashcard','mode':'bidirectional'}}
        original=copy.deepcopy(item);cards=expand_flashcard(item)
        self.assertEqual(item,original);self.assertEqual(len(cards),2)
        self.assertEqual(cards[0]['itemId'],'old');self.assertEqual(cards[0]['abilityId'],'concept')
        self.assertEqual(cards[1]['itemId'],child_id('old','reverse'));self.assertNotEqual(cards[1]['abilityId'],'concept')
        self.assertEqual((cards[1]['front'],cards[1]['back']),('Answer','Question'))
        self.assertEqual([c for card in cards for c in expand_flashcard(card)],cards)
    def test_masks_have_stable_independent_identities_when_reordered(self):
        masks=[{'id':v,'x':'10','y':'10','width':'10','height':'10','answer':v} for v in ['a','b']]
        item={'id':'old','itemId':'old','abilityId':'concept','prompt':'Diagram','back':'unused','learningSupport':{'schemaVersion':1,'type':'flashcard','mode':'occlusion','sourceKey':'a'*64,'sourceVersion':'b'*64,'assetId':'diagram','assetVersion':'c'*64,'masks':masks}}
        before=expand_flashcard(item);item['learningSupport']['masks'].reverse();after=expand_flashcard(item)
        self.assertEqual({c['itemId'] for c in before},{c['itemId'] for c in after})
        self.assertEqual(len({c['abilityId'] for c in before}),2)
        self.assertEqual([c['back'] for c in before],['a','b'])
        self.assertEqual([c for card in before for c in expand_flashcard(card)],before)
