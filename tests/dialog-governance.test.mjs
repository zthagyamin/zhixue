import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('public pages are never covered by an automatic dialog', async () => {
  const layout = await read('../app/layout.tsx');
  // The changelog modal used to be mounted for every route, so a first visit to / met a technical
  // release note before the product itself. It now belongs to the signed-in workspace only.
  assert.doesNotMatch(layout, /ReleaseAnnouncement/);
  assert.match(layout, /import \{ReleaseNotice\} from '\.\/release-support'/);
  const dashboard = await read('../app/study-dashboard.tsx');
  assert.match(dashboard, /<ReleaseAnnouncement[\s\S]*?ready=\{model.workspacePhase==='ready'/);
  // /study already requires a session, so mounting it here can never greet a public visitor.
  const studyPage = await read('../app/study/page.tsx');
  assert.match(studyPage, /if\(!user\)redirect\(homeHref\)/);
});

test('the tutorial yields to a dialog that is already on screen', async () => {
  const onboarding = await read('../app/onboarding.tsx');
  // Dismissing the release note used to reveal the tutorial underneath: two stacked modals on the
  // same first visit. The automatic decision now stands down while any dialog is open.
  assert.match(onboarding, /function automaticModalBlocked\(\)\{return typeof document!=='undefined'&&document\.querySelector\('dialog\[open\]'\)!==null;\}/);
  assert.match(onboarding, /setOpen\(shouldAutoOpenOnboarding\(next,Boolean\(id\),window\.location\.pathname,Boolean\(saved\|\|handoff\)\)&&!automaticModalBlocked\(\)\)/);
});

test('both dialogs keep their close control reachable on a small screen', async () => {
  const onboarding = await read('../app/onboarding.css');
  assert.match(onboarding, /\.site-onboarding\{[^}]*max-height:min\(85vh,calc\(100dvh - 32px\)\)/);
  assert.match(onboarding, /\.site-onboarding header\{position:sticky;top:0/);
  assert.match(onboarding, /@media\(max-width:640px\)\{\.site-onboarding\{[^}]*max-height:85vh/);
  const release = await read('../app/release-support.css');
  assert.match(release, /\.release-dialog\{[^}]*max-height:min\(760px,85vh,calc\(100dvh - 48px\)\)/);
  assert.match(release, /\.release-dialog \.study-panel-heading\{position:sticky;top:0/);
});

test('the recall control only appears where the announcement is mounted', async () => {
  const settings = await read('../app/study-dashboard/sources-view.tsx');
  assert.match(settings, /<ShowReleaseAnnouncementButton\/>/);
  const updates = await read('../app/updates/page.tsx');
  // /updates lists every announcement inline and has no mounted dialog, so a modal trigger there
  // would have been a dead control.
  assert.doesNotMatch(updates, /ShowReleaseAnnouncementButton/);
  assert.match(updates, /\/companion-guide|更新说明|公告不会在公开页面自动弹出/);
});
