/** Opt-in shortcuts never consume typing, IME, modifiers, repeated keys or modal input. */
export function handleStudyShortcut(event:KeyboardEvent,root:HTMLElement|null):boolean{
 const key=event.key===' '?'Space':event.key;
 if(!root||event.defaultPrevented||event.repeat||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!(/^[0-9]$/.test(key)||key==='Space'||key==='Enter'))return false;
 if(root.getClientRects().length===0||root.closest('[inert]')||root.ownerDocument.querySelector('dialog[open]'))return false;
 const target=event.target as Element|null;
 if(target&&typeof target.closest==='function'&&target.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]'))return false;
 if((key==='Space'||key==='Enter')&&target?.closest?.('button,a,summary,[role="button"],[role="link"]'))return false;
 const button=root.querySelector<HTMLButtonElement>(`button[data-study-key="${key}"],button[data-study-keys~="${key}"]`);
 if(!button||button.disabled||button.closest?.('fieldset[disabled],[inert]')||button.getClientRects().length===0)return false;
 event.preventDefault();button.click();return true;
}
