import { EditorView } from '@codemirror/view';
import { render } from 'solid-js/web';

// Catches fixed multiline height, missing wrap growth, cap overflow and failed submit reset.
window.composeGrowthGeometry = async () => {
 const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const editor=document.querySelector('.cm-editor');
 const view=EditorView.findFromDOM(editor);
 const scroller=editor.querySelector('.cm-scroller');
 const host=document.querySelector('[data-compose-editor]');
 const replace=async text=>{view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}});await frame();};
 const read=()=>({height:host.getBoundingClientRect().height,scroll:scroller.scrollHeight,client:scroller.clientHeight,overflow:getComputedStyle(scroller).overflowY});
 await replace('');const empty=read();
 await replace('one\ntwo');const two=read();
 await replace('one\ntwo\nthree');const three=read();
 await replace(Array(30).fill('Long draft').join('\n'));const long=read();
 await replace('');const cleared=read();
 await replace('A draft with enough words to wrap across narrow terminal panels.');const wide=read();
 const panel=host.parentElement;const previous=panel.style.width;panel.style.width='180px';await frame();const narrow=read();panel.style.width=previous;await frame();
 await replace('submit me');document.querySelector('[aria-label="Send (Enter)"]').click();await frame();const sent=read();
 await replace('Draft');
 return {empty,two,three,long,cleared,wide,narrow,sent};
};
import { ComposePanel } from '../../components/ComposePanel/ComposePanel';
import '../../global.css';
render(()=><section id="geometry"><ComposePanel isOpen={()=>true} initialText={()=>'Draft'} onClose={()=>{}} onSend={()=>{}} onEnqueue={()=>{}} canEnqueue={()=>true} queuedCount={()=>1} onClearQueue={()=>{}} onLoadQueue={async()=>[{id:1,text:'Queued command',kind:'user_command'}]} onRemoveQueued={()=>{}} pinned={()=>true} onTogglePin={()=>{}} onDismiss={()=>{}} focusRequest={()=>0}/></section>,document.getElementById('root'));
requestAnimationFrame(()=>{
 const badge=document.querySelector('[aria-expanded]');
 badge.click();
 const ready=()=>{
  if(!document.querySelector('[title="Remove from queue"]')){requestAnimationFrame(ready);return;}
  window.controlGeometryReady=true;
 };
 requestAnimationFrame(ready);
});

window.geometryIconLabels=["Remove from queue","Unpin from the terminal bottom","Queue for the next idle moment (Shift+Ctrl+Enter)","Attach images","Send (Enter)","Close compose panel"];
