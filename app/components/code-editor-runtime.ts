import {EditorState,Compartment} from '@codemirror/state';
import {EditorView,lineNumbers,highlightActiveLineGutter,highlightSpecialChars,drawSelection,keymap} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {bracketMatching,syntaxHighlighting,indentUnit} from '@codemirror/language';
import {oneDarkHighlightStyle} from '@codemirror/theme-one-dark';
export const codeEditorKeymap=[...defaultKeymap,...historyKeymap,indentWithTab];

export async function mountCodeEditor(parent:HTMLElement,options:{value:string;readOnly:boolean;language:'python'|'c'|'cpp';label:string;onChange:(value:string)=>void}){
  const language=options.language==='python'?(await import('@codemirror/lang-python')).python():(await import('@codemirror/lang-cpp')).cpp();
  const access=new Compartment();let locked=options.readOnly;
  const disabled=()=>locked||Boolean(parent.closest('fieldset[disabled]'));
  const mode=()=>[EditorState.readOnly.of(disabled()),EditorView.editable.of(!disabled())];
  const view=new EditorView({parent,state:EditorState.create({doc:options.value,extensions:[
    lineNumbers(),highlightActiveLineGutter(),highlightSpecialChars(),drawSelection(),history(),bracketMatching(),language,
    syntaxHighlighting(oneDarkHighlightStyle),indentUnit.of('    '),keymap.of(codeEditorKeymap),
    access.of(mode()),EditorView.contentAttributes.of({'aria-label':options.label,'aria-multiline':'true',spellcheck:'false'}),
    EditorState.transactionFilter.of(transaction=>transaction.docChanged&&disabled()?[]:transaction),
    EditorView.updateListener.of(update=>{if(update.docChanged)options.onChange(update.state.doc.toString());}),
    EditorView.theme({'&':{backgroundColor:'#161b22',color:'#e6edf3',minHeight:'260px',fontSize:'14px'},'.cm-scroller':{fontFamily:'Consolas, monospace',lineHeight:'1.65',overflow:'auto',maxHeight:'520px'},'.cm-content':{padding:'16px 0',caretColor:'#fff'},'.cm-gutters':{backgroundColor:'#13161c',color:'#7d8590',borderRight:'1px solid #30363d'},'.cm-activeLineGutter':{backgroundColor:'#21262d'},'.cm-selectionBackground':{backgroundColor:'#33475b !important'},'&.cm-focused':{outline:'2px solid #698eab',outlineOffset:'-2px'}},{dark:true}),
  ]})});
  const observer=new MutationObserver(()=>view.dispatch({effects:access.reconfigure(mode())}));
  const fieldset=parent.closest('fieldset');if(fieldset)observer.observe(fieldset,{attributes:true,attributeFilter:['disabled']});
  return {
    setValue(value:string){if(value!==view.state.doc.toString())view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value},filter:false});},
    setReadOnly(value:boolean){locked=value;view.dispatch({effects:access.reconfigure(mode())});},
    focus(){view.focus();},
    destroy(){observer.disconnect();view.destroy();},
  };
}
