(() => {
 const content = document.querySelector('[data-settings-content]');
 const checks = [];
 // Range and element edges can differ by subpixels in WebKit (observed 0.00293px).
 // 1/64 CSS px absorbs that rounding but still rejects a full 1px excess gap.
 const gapTolerance = 1 / 64;
 const rect = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
 const check = (name, pass, boxes) => checks.push({name,pass,boxes});
 const byText = (selector,text) => [...content.querySelectorAll(selector)].find(e=>e.textContent.trim()===text);
 for (const pair of content.querySelectorAll('[class*="helpLabel"], [class*="cardHeading"]')) {
  const label=pair.querySelector('label,h3'), badge=pair.querySelector('[role="button"]');
  if(label&&badge){const range=document.createRange();range.selectNodeContents(label);const lines=[...range.getClientRects()].filter(r=>r.width);const a=lines.at(-1)??rect(label),b=rect(badge);check('badge beside '+label.textContent,b.x>=a.right-1&&b.x-a.right<=12+gapTolerance&&b.y<a.bottom&&b.bottom>a.y,{label:rect(label),lastLine:{x:a.x,y:a.y,right:a.right,bottom:a.bottom},badge:b});}
 }
 for(const row of content.querySelectorAll('[class*="settingRow"]')) {
  if(!row.className.split(' ').some(n=>n.match(/(?:^|_)settingRow(?:_|$)/)))continue;
  const label=row.querySelector('label'),control=row.querySelector('[class*="settingRowControl"]');
  if(!label||!control)continue;
  const a=rect(label),b=rect(control),r=rect(row);
  check('label before control '+label.textContent,innerWidth>800?a.x<b.x:a.bottom<=b.y+1,{label:a,control:b});
  const buttons=[...control.querySelectorAll('button')];
  const toggle=control.querySelector('input[type=checkbox]');if(toggle&&!buttons.length)check('right aligned switch '+label.textContent,Math.abs(rect(toggle).right-r.right)<=2,{row:r,toggle:rect(toggle)});
  if(buttons.length){const right=Math.max(...buttons.map(e=>rect(e).right));check('right aligned action '+label.textContent,Math.abs(right-r.right)<=2,{row:r,control:b,buttonRight:right});}
 }
 const sidebarColor=byText('label','Sidebar Color');
 if(sidebarColor){const row=sidebarColor.closest('[class*="settingRow_"]');check('sidebar color uses shared row',!!row,{label:rect(sidebarColor)});
  const picker=row.querySelector('[class*="groupColorPicker"]'),swatches=[...picker.children].map(rect);
  check('sidebar color targets stay round without flex shrink',swatches.every(b=>Math.abs(b.width-b.height)<=1&&b.width>=24),{swatches});
  check('sidebar color group uses available control width',Math.abs(rect(picker).width-rect(row).width)<=1||innerWidth>800,{picker:rect(picker),row:rect(row)});
  const last=swatches.at(-1);check('clear color target wraps with other swatches',swatches.filter(b=>Math.abs(b.y-last.y)<=1).length>=2,{swatches});
 }

 const breadcrumb=content.querySelector('[class*="breadcrumb"]'),header=content.querySelector('header');
 if(breadcrumb&&header)check('consistent breadcrumb to header gap',Math.abs(rect(header).y-rect(breadcrumb).bottom-12)<=1,{breadcrumb:rect(breadcrumb),header:rect(header)});
 const upstream=byText('h3','Upstream MCP Servers');
 if(upstream){const card=upstream.closest('section'),row=card.parentElement.previousElementSibling;
  const add=card.querySelector('button[title="Add upstream server"]'),selector=card.querySelector('select')??byText('p','No upstream servers configured.');
  const a=rect(add),d=rect(selector);
  check('upstream add action stays clear of card content',a.bottom+8<=d.y||d.bottom+8<=a.y||a.right+8<=d.x||d.right+8<=a.x,{action:a,selector:d});
check('upstream card separated from connection row',rect(card).y-rect(row).bottom>=16,{card:rect(card),row:rect(row)});check('shared card heading size',getComputedStyle(upstream).fontSize==='15px',{size:getComputedStyle(upstream).fontSize});}
 for(const badge of content.querySelectorAll('header [data-testid="status-badge"]')){const b=rect(badge),h=rect(badge.closest('header'));check('header badge stays within header',b.right<=h.right+1&&b.x>=h.x-1,{badge:b,header:h});check('header badge is legible or ellipsized',badge.scrollWidth<=badge.clientWidth+1||getComputedStyle(badge).textOverflow==='ellipsis',{clientWidth:badge.clientWidth,scrollWidth:badge.scrollWidth});}
 for(const label of content.querySelectorAll('[class*="catalogueLabel"]')){const control=label.querySelector('input,select');if(control){const range=document.createRange();range.selectNode(label.firstChild);const a=rect(control),b=range.getBoundingClientRect();check('catalogue label has control gap',a.y-b.bottom>=8,{control:a,label:{bottom:b.bottom}});}}
 const pluginEmpty=byText('p','No plugins installed.');if(pluginEmpty)check('plugin empty state has vertical space',parseFloat(getComputedStyle(pluginEmpty).paddingTop)>=16&&parseFloat(getComputedStyle(pluginEmpty).paddingBottom)>=16,{empty:rect(pluginEmpty)});
 for(const group of content.querySelectorAll('[role="group"][aria-label="Setting actions"]')){const style=getComputedStyle(group);check('catalogue actions reserve 8px gaps',style.display==='flex'&&parseFloat(style.columnGap)===8&&parseFloat(style.rowGap)===8,{columnGap:style.columnGap,rowGap:style.rowGap});const buttons=[...group.querySelectorAll('button')].map(rect);const preceding=group.previousElementSibling;if(preceding&&buttons.length)check('catalogue first action clears field separator',buttons[0].y-rect(preceding).bottom>=8,{field:rect(preceding),firstAction:buttons[0]});for(let i=1;i<buttons.length;i++){const a=buttons[i-1],b=buttons[i];check('catalogue action buttons do not touch',Math.abs(a.y-b.y)<=1?b.x-a.right>=8:b.y-a.bottom>=8,{previous:a,next:b});}}
 const autoFetch=byText('label','Auto-Fetch Interval');
 if(autoFetch){const control=document.getElementById(autoFetch.htmlFor);if(control){const a=rect(autoFetch),b=rect(control);check('repository label before select',innerWidth>600?a.x<b.x&&a.y<=b.bottom:a.bottom<=b.y,{label:a,control:b});}}
 const select=document.querySelector('select[aria-label="Settings page"]');
 if(select&&innerWidth<700){const style=getComputedStyle(select);check('compact page selector reserves arrow space',parseFloat(style.paddingInlineEnd)>=32&&style.textOverflow==='ellipsis',{select:rect(select),paddingInlineEnd:style.paddingInlineEnd,textOverflow:style.textOverflow});}
 const expected=new URLSearchParams(location.search).get('tab');
 if(select&&expected)check('compact page agrees with rendered page',select.value===expected,{actual:select.value,expected});
 const heading=byText('h3','Your machines');
 if(heading){const empty=[...content.querySelectorAll('p')].find(e=>e.textContent.includes('No remote machines configured'));if(empty)check('heading precedes empty state',rect(heading).bottom<=rect(empty).y,{heading:rect(heading),empty:rect(empty)});}
 if(innerWidth<700)for(const row of content.querySelectorAll('table tr')){const cells=row.querySelectorAll('td');if(cells.length===2){const a=rect(cells[0]),b=rect(cells[1]);check('compact shortcut has no empty gap',b.y-a.bottom<=8,{name:a,key:b});}}
 const local=byText('h3','Local tools');
 if(local){const general=byText('h3','General');check('local tools precede general',rect(local).y<rect(general).y,{tools:rect(local),general:rect(general)});}
 const status=[...content.querySelectorAll('[role=status]')].find(e=>e.textContent.includes('Update status'));if(local&&status){const button=status.querySelector('button');check('update banner precedes local tools',rect(status).bottom<=rect(local).y,{status:rect(status),tools:rect(local)});if(button)check('update action on the right',Math.abs(rect(button).right-(rect(status).right-16))<=2,{status:rect(status),button:rect(button)});}
 check('no horizontal overflow',content.scrollWidth<=content.clientWidth,{clientWidth:content.clientWidth,scrollWidth:content.scrollWidth});
 return {checks, shortcuts:[...content.querySelectorAll('td kbd')].map(e=>({text:e.textContent,key:rect(e),cell:rect(e.closest('td')),actions:[...e.parentElement.children].filter(c=>c!==e).map(c=>({tag:c.tagName,text:c.textContent,box:rect(c)}))})), header:rect(content.querySelector('header')), content:rect(content), text:content.innerText};
})()
