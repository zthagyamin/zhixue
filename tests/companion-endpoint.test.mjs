import {test} from 'node:test';
import assert from 'node:assert/strict';
import {companionEndpointFromSearch,sessionForEndpoint,companionSignInLink,companionSessionRecordKey,DEFAULT_COMPANION_URL} from '../app/companion-endpoint.ts';
test('only explicit valid loopback ports are accepted',()=>{
  assert.equal(companionEndpointFromSearch('?companionPort=43125'),'http://127.0.0.1:43125');
  for(const port of ['0','65536','43121@evil.test','https://evil.test','-1'])assert.equal(companionEndpointFromSearch('?companionPort='+port),DEFAULT_COMPANION_URL);
});
test('a saved token never follows a different installation port',()=>{
  const legacy={token:'local-session'};
  assert.equal(sessionForEndpoint(legacy,DEFAULT_COMPANION_URL),legacy);
  assert.equal(sessionForEndpoint(legacy,'http://127.0.0.1:43125'),null);
  const paired={...legacy,baseUrl:'http://127.0.0.1:43125'};
  assert.equal(sessionForEndpoint(paired,paired.baseUrl),paired);
  assert.notEqual(companionSessionRecordKey(paired.baseUrl),companionSessionRecordKey(DEFAULT_COMPANION_URL));
  const link=new URL(companionSignInLink(paired.baseUrl),'https://example.test');
  assert.equal(link.searchParams.get('return_to'),'/study?pair=1&companionPort=43125');
});
